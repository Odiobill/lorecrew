import { assertThinkingChoice } from '../runtime/thinking.js';
import {assertAuthorityDomain} from '../projects/authority-domain.js';
import { checkAgentUse } from '../setup/agent-use.js';
import { attachSetupEntity,assertSetupReservation } from '../setup/service.js';
import type { Context } from 'hono';
import type { ApiOptions, Principal, Route } from './routes.js';
import * as S from './schemas.js';
import type { Static } from 'typebox';
import { AppError, type Json } from '../contracts/base.js';
import { resolveGroup } from '../agents/resolve.js';
import { stableId as conceptId } from '../vault/indexes.js';
import { stableId } from '../runtime/admission.js';
import { bindProject } from '../projects/bindings.js';
import { handoffProject } from '../projects/handoff.js';
import { openConfiguredWorkloadOwnership } from '../projects/configured-ownership.js';
import { GitClient } from '../git/client.js';
import { scheduleDispatch } from '../schedules/dispatch.js';
import { openSchedules } from '../schedules/service.js';
import type { Occurrence, Schedule } from '../schedules/types.js';
import { listProviderSettings, readProviderSettings, saveProviderSettings,saveCompatibleSettings } from '../runtime/providers.js';
import { listObservedRevisions, restoreObservedRevision } from '../sync/recovery.js';
import type { LearningAssignment } from '../learning/curator.js';
export function operationsRoutes(options:ApiOptions,principal:(c:Context)=>Principal):Route[]{
 const {ctx,vault,runtime,ownership}=options;const logins=options.providerLogins!;let service=options.schedules;
 const schedules=async()=>service??=(openSchedules({ctx,vault,runtime,ownership,workloads:await workloads()}));
 const workloads=async()=>openConfiguredWorkloadOwnership(ctx,new GitClient(),(await ctx.store.read<{remote:string}>('fleet','assignments'))?.remote??'origin');
 const param=(c:Context)=>c.req.param('id')!;
 const assignment=async()=>{const a=await ctx.store.read<LearningAssignment>('learning-assignment','curator');const pending=await ctx.store.read<{agentId:string;expectedRevision:string|null}>('curator-reassignment','pending');return {assignment:a??null,revision:a?stableId(JSON.stringify(a)):null,status:await runtime.curator.status(),...pending?{pending:{agentId:pending.agentId,expectedRevision:pending.expectedRevision}}:{}};};
 const sync=()=>{if(!options.sync)throw new AppError('SYNC_UNAVAILABLE','Synchronization service is not attached');return options.sync;};
 const syncView=async()=>({status:await sync().status(),pending:await ctx.store.list<Json>('sync-apply-diagnostic'),recovery:(await listObservedRevisions(ctx)).map(({id,path,at})=>({id,path,at}))});
 const edit=async(c:Context,body:unknown,requestId:string,type:'Agent'|'Group')=>{const input=body as Static<typeof S.AgentEditSchema>;if(input.id!==param(c))throw new AppError('INVALID_REQUEST','Definition ID differs from path');if(type==='Agent')assertThinkingChoice(input.model,(await runtime.listModels()).find(m=>m.provider===input.model.provider&&m.modelId===input.model.modelId));const concept=(await vault.list()).find(x=>x.metadata.type===type&&conceptId(x)===input.id);if(!concept)throw new AppError('NOT_FOUND','Definition not found');const {expectedRevision,...definition}=input;return vault.propose({id:requestId,path:concept.path,expectedRevision,actor:`user:${principal(c).id}`,content:{metadata:{lorecrew:{...concept.metadata.lorecrew as Record<string,Json>,...definition}}}});};
 return [
 {method:'GET',path:'/agents/:id/readiness',response:S.AgentUseReadinessSchema,handle:c=>checkAgentUse(options,{agentId:param(c)})},
 {method:'GET',path:'/sessions/:id/readiness',response:S.AgentUseReadinessSchema,handle:c=>checkAgentUse(options,{sessionId:param(c)})},
 {method:'GET',path:'/groups',response:S.Type.Array(S.GroupSchema),async handle(){return Promise.all((await vault.list()).filter(c=>c.metadata.type==='Group').map(c=>resolveGroup(vault,conceptId(c)!)));}},
 ...(['Agent','Group'] as const).map(type=>({method:'POST' as const,path:type==='Agent'?'/agents':'/groups',body:type==='Agent'?S.AgentCreateSchema:S.GroupCreateSchema,response:S.RevisionSchema,idempotent:true,async handle(c:Context,b:unknown,id:string){
   const input=b as Static<typeof S.AgentCreateSchema>;
   await assertSetupReservation(ctx,type==='Agent'?['agent','additionalAgent']:['group'],c.req.header('idempotency-key'),input.id);
   if(type==='Agent')assertThinkingChoice(input.model,(await runtime.listModels()).find(m=>m.provider===input.model.provider&&m.modelId===input.model.modelId));
   const result=await vault.propose({id,path:`${type==='Agent'?'agents':'groups'}/${input.id}.md`,expectedRevision:null,actor:`user:${principal(c).id}`,content:`---\n${JSON.stringify({type,lorecrew:input})}\n---\n`});await attachSetupEntity(ctx,type==='Group'?'group':'agent',c.req.header('idempotency-key'),input.id);if(type==='Agent')await attachSetupEntity(ctx,'additionalAgent',c.req.header('idempotency-key'),input.id);return result;
 }})),
 ...(['Agent','Group'] as const).map(type=>({method:'PUT' as const,path:type==='Agent'?'/agents/:id':'/groups/:id',body:type==='Agent'?S.AgentEditSchema:S.GroupEditSchema,response:S.RevisionSchema,idempotent:true,handle:(c:Context,b:unknown,id:string)=>edit(c,b,id,type)})),
 {method:'POST',path:'/sessions/:id/reload',body:S.ExpectedRevisionSchema,response:S.SessionRefSchema,idempotent:true,handle:(c,b,id)=>runtime.reloadAgent({sessionId:param(c),expectedRevision:(b as {expectedRevision:string}).expectedRevision,requestId:id})},
 {method:'GET',path:'/projects/:id/binding',response:S.JsonSchema,async handle(c){const binding=await ctx.store.read<{projectId:string;path:string}>('project-binding',param(c));return {binding:binding??null,revision:binding?stableId(binding.projectId,binding.path):null};}},
 {method:'PUT',path:'/projects/:id/binding',body:S.BindingInputSchema,response:S.OkSchema,idempotent:true,async handle(c,b,id){await bindProject(ctx,{projectId:param(c),requestId:id,...b as Static<typeof S.BindingInputSchema>});return {ok:true};}},
 {method:'POST',path:'/projects/claim',body:S.ClaimSchema,response:S.JsonSchema,idempotent:true,async handle(_c,b,id){await assertAuthorityDomain(ctx);return ownership.claim(b as Static<typeof S.ClaimSchema>,id);}},
 {method:'POST',path:'/projects/:id/handoff',body:S.HandoffSchema,response:S.JsonSchema,idempotent:true,handle:(c,b,id)=>{if(!runtime.repositories)throw new AppError('RUNTIME_REQUIRED','Repository controls unavailable');return runtime.repositories.enqueue({action:'handoff',projectId:param(c),...b as Static<typeof S.HandoffSchema>},id);}},
 {method:'PUT',path:'/providers/openai-compatible/endpoint',body:S.CompatibleInputSchema,response:S.ProviderSchema,browserOnly:true,idempotent:true,async handle(_c,b,id){await saveCompatibleSettings(ctx,b as Static<typeof S.CompatibleInputSchema>,id);await runtime.reloadProviders();return readProviderSettings(ctx,'openai-compatible',options.providerOptions);}},
 {method:'GET',path:'/providers',response:S.Type.Array(S.ProviderSchema),handle:()=>listProviderSettings(ctx.stateDir,options.providerOptions)},
 {method:'POST',path:'/providers/:id/login',body:S.ProviderLoginInputSchema,response:S.ProviderLoginSchema,browserOnly:true,transient:true,handle:(c,b)=>logins.start(principal(c).id,param(c),(b as Static<typeof S.ProviderLoginInputSchema>).type)},
 {method:'GET',path:'/provider-logins/:id',response:S.ProviderLoginSchema,browserOnly:true,handle:async c=>logins.get(principal(c).id,param(c))},
 {method:'POST',path:'/provider-logins/:id/answer',body:S.ProviderAnswerSchema,response:S.ProviderLoginSchema,browserOnly:true,transient:true,handle:(c,b)=>{const input=b as Static<typeof S.ProviderAnswerSchema>;return logins.answer(principal(c).id,param(c),input.promptId,input.value);}},
 {method:'POST',path:'/provider-logins/:id/cancel',body:S.EmptySchema,response:S.ProviderLoginSchema,browserOnly:true,transient:true,handle:async c=>logins.cancel(principal(c).id,param(c))},
 {method:'GET',path:'/providers/:id',response:S.ProviderSchema,handle:c=>readProviderSettings(ctx,param(c),options.providerOptions)},
 {method:'PUT',path:'/providers/:id',body:S.ProviderInputSchema,response:S.ProviderSchema,idempotent:true,async handle(c,b,id){await saveProviderSettings(ctx,param(c),b as Static<typeof S.ProviderInputSchema>,id);await runtime.reloadProviders();return readProviderSettings(ctx,param(c),options.providerOptions);}},
 {method:'GET',path:'/learning/assignment',response:S.AssignmentViewSchema,handle:assignment},
 {method:'PUT',path:'/learning/assignment',body:S.AssignmentInputSchema,response:S.AssignmentViewSchema,idempotent:true,async handle(_c,b,id){const input=b as Static<typeof S.AssignmentInputSchema>;const pending=await ctx.store.read<{agentId:string;expectedRevision:string|null;requestId:string}>('curator-reassignment','pending');const requestId=pending?.agentId===input.agentId&&pending.expectedRevision===input.expectedRevision?pending.requestId:id;await runtime.curator.reassign({agentId:input.agentId,expectedRevision:input.expectedRevision,requestId,claim:async()=>{const o=await workloads();return o.claim('curator','curator-initial');}});return assignment();}},
 {method:'GET',path:'/schedules',response:S.ScheduleListSchema,async handle(){const all=await (await schedules()).list();const occurrences=await ctx.store.list<Occurrence>('schedule-occurrence');return {items:await Promise.all(all.map(async schedule=>{const runs=await Promise.all(occurrences.filter(o=>o.scheduleId===schedule.id).map(async o=>schedule.ownerId===ctx.instanceId&&['pending','running'].includes(o.state)?{...o,state:await scheduleDispatch(ctx,runtime).status(o)}:o));let currentState=schedule.ownerId!==ctx.instanceId?'remote_readonly':!schedule.enabled?'disabled':runs.some(o=>['pending','running'].includes(o.state))?'working':'ready';if(currentState==='ready')try{const workload=await workloads();const grant=await ctx.store.read<{assignment:{generation:number}}>('workload-grants','schedule:'+schedule.id);await workload.assertOwner('schedule:'+schedule.id,grant?.assignment.generation??0);if(schedule.projectId){const g=await ctx.store.read<{assignment:{generation:number}}>('assignment-grants',schedule.projectId);await ownership.assertOwner(schedule.projectId,g?.assignment.generation??0);}}catch{currentState='waiting_grant';}return {schedule,currentState,lastDiagnostic:await ctx.store.read('schedule-status',schedule.id),occurrences:runs};}))};}},
 ...(['POST','PUT'] as const).map(method=>({method,path:method==='POST'?'/schedules':'/schedules/:id',body:method==='POST'?S.ScheduleInputSchema:S.ScheduleEditSchema,response:S.ScheduleSchema,idempotent:true,async handle(c:Context,b:unknown,id:string){const input=b as Static<typeof S.ScheduleEditSchema>;if(method==='PUT'&&input.id!==param(c))throw new AppError('INVALID_REQUEST','Schedule ID differs');const {expectedRevision,...fields}=input;const old=(await (await schedules()).list()).find(x=>x.id===input.id);const schedule:Schedule={...fields,ownerId:ctx.instanceId,revision:id,overlap:'skip',missed:'coalesce',effectiveFrom:old?.effectiveFrom??new Date(ctx.clock.now()).toISOString()};await (await schedules()).save(schedule,method==='POST'?null:expectedRevision);return schedule;}})),
 {method:'POST',path:'/schedules/:id/disable',body:S.ExpectedRevisionSchema,response:S.OkSchema,idempotent:true,async handle(c,b){await (await schedules()).disable(param(c),(b as {expectedRevision:string}).expectedRevision);return {ok:true};}},
 {method:'GET',path:'/sync',response:S.SyncViewSchema,handle:syncView},
 ...(['pause','resume','run'] as const).map(action=>({method:'POST' as const,path:'/sync/'+action,body:S.EmptySchema,response:S.SyncViewSchema,idempotent:true,async handle(){await (action==='run'?sync().flush():sync()[action]());return syncView();}})),
 {method:'GET',path:'/remote/tasks',response:S.RemoteTasksSchema,async handle(){const status=await ctx.store.read<{lastFetchAt?:string}>('sync-status','current');const items=(await vault.list()).filter(c=>c.metadata.type==='TaskStatus').flatMap(c=>{const d=c.metadata.lorecrew as Record<string,Json>|undefined;if(!d||d.originId===ctx.instanceId||typeof d.originId!=='string'||typeof d.taskId!=='string'||typeof d.sessionId!=='string'||typeof d.sequence!=='number'||!Number.isInteger(d.sequence)||typeof d.reportedAt!=='string'||typeof d.state!=='string'||typeof d.summary!=='string')return [];return [{path:c.path,originId:d.originId,taskId:d.taskId,sessionId:d.sessionId,sequence:d.sequence,reportedAt:d.reportedAt,state:d.state,summary:d.summary,...typeof d.agentId==='string'?{agentId:d.agentId}:{}}];});return {items,lastFetchAt:status?.lastFetchAt??null};}},
 {method:'GET',path:'/history',response:S.HistoryListSchema,async handle(){return {items:(await vault.list()).filter(c=>c.metadata.type==='History').map(c=>({path:c.path,title:String(c.metadata.title??c.path),originId:String((c.metadata.lorecrew as Record<string,Json>|undefined)?.originId??''),body:c.body}))};}},
 {method:'POST',path:'/recovery/:id/restore',body:S.EmptySchema,response:S.OkSchema,idempotent:true,async handle(c,_b,id){await restoreObservedRevision(ctx,param(c),id);return {ok:true};}},
 ];
}
