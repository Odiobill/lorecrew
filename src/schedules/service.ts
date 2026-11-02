import {assertAuthorityScope,authorityScope} from '../projects/authority-domain.js';
import type {AuthorityBinding} from '../repositories/types.js';
import { AppError } from '../contracts/base.js';
import { isDeepStrictEqual } from 'node:util';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { Runtime } from '../runtime/types.js';
import type { Ownership, Assignment } from '../projects/types.js';
import { assertWorkloadAdmission, resumeWorkloadGrant, type WorkloadGrant, type WorkloadOwnership } from '../projects/workload-grants.js';
import { resolveAgent } from '../agents/resolve.js';
import { stableId, assertAdmission } from '../runtime/admission.js';
import type { SessionRecord } from '../runtime/types.js';
import { occurrencesAfter, validateRecurrence } from './recurrence.js';
import { scheduleDispatch, scheduleWorkload } from './dispatch.js';
import type { Schedule, Occurrence, ScheduleService } from './types.js';
interface Cursor {throughUtc:string}
interface Catchup {revision:string;target:number;through:string;first?:string;previous?:string;latest?:{utc:string;localKey:string};count:number}
interface Move {id:string;targetOwner:string;generation:number;transitionId:string;schedule:Schedule;expectedRevision:string;state:'pending'|'completed'}
const queues=new WeakMap<InstanceContext,Promise<void>>();
const instant=(value:string)=>{const time=Date.parse(value);if(!Number.isFinite(time))throw new AppError('INVALID_TIME','Invalid UTC instant');return time;};
const iso=(value:number)=>new Date(value).toISOString();
function validate(schedule:Schedule){
 if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(schedule.id)||![schedule.revision,schedule.ownerId,schedule.agentId,schedule.instructions].every(v=>typeof v==='string'&&v.trim())||typeof schedule.enabled!=='boolean'||schedule.overlap!=='skip'||schedule.missed!=='coalesce'||schedule.projectId!==undefined&&!schedule.projectId.trim())throw new AppError('INVALID_SCHEDULE','Schedule fields or policies are invalid');
 instant(schedule.effectiveFrom);validateRecurrence(schedule);
}
const path=(id:string)=>`schedules/${id}.md`;
export function openSchedules({ctx,vault,runtime,ownership,workloads}:{ctx:InstanceContext;vault:Vault;runtime:Runtime;ownership:Ownership;workloads:WorkloadOwnership}):ScheduleService{
 let closed=false;const dispatch=scheduleDispatch(ctx,runtime);
 const serial=<T>(fn:()=>Promise<T>)=>{if(closed)return Promise.reject(new AppError('SCHEDULES_CLOSED','Schedules are closed'));const result=(queues.get(ctx)??Promise.resolve()).then(fn);queues.set(ctx,result.then(()=>{},()=>{}));return result;};
 async function list(){return (await vault.list()).filter(c=>c.metadata.type==='Schedule').map(c=>{const s=c.metadata.schedule as unknown as Schedule;validate(s);if(c.path!==path(s.id))throw new AppError('INVALID_SCHEDULE','Schedule ID differs from its canonical path');return s;});}
 async function read(id:string){const schedule=(await list()).find(s=>s.id===id);if(!schedule)throw new AppError('NOT_FOUND','Schedule not found');return schedule;}
 function local(s:Schedule){if(s.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Imported schedules are read-only on this instance');}
 async function grant(s:Schedule,create=false):Promise<WorkloadGrant>{
  local(s);const workloadId=scheduleWorkload(s.id);
  if(!create)return resumeWorkloadGrant(ctx,workloads,workloadId);
  const current=await workloads.claim(workloadId,`schedule:${s.id}`);await workloads.assertOwner(workloadId,current.generation);return current;
 }
 async function project(s:Schedule){if(s.projectId){const grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',s.projectId);if(!grant)throw new AppError('NOT_OWNER','Project schedules require a confirmed project grant');await ownership.assertOwner(s.projectId,grant.assignment.generation);}}
 async function publish(s:Schedule,expectedRevision:string|null,generation?:number){
  await vault.propose({id:`schedule-definition:${stableId(s.id,s.revision)}`,path:path(s.id),expectedRevision,actor:`schedule-owner:${ctx.instanceId}`,content:`---\n${JSON.stringify({type:'Schedule',id:s.id,title:`Schedule ${s.id}`,schedule:s},null,2)}\n---\n# Schedule ${s.id}\n\n${s.instructions}\n`},generation===undefined?undefined:tx=>assertWorkloadAdmission(ctx,tx,scheduleWorkload(s.id),generation));
 }
 async function save(s:Schedule,expectedRevision?:string|null){
  validate(s);local(s);const old=(await list()).find(v=>v.id===s.id);if(old)local(old);
  if(expectedRevision!==undefined&&(old?.revision??null)!==expectedRevision){if(old&&isDeepStrictEqual(old,s))return;throw new AppError('REVISION_CONFLICT','Schedule definition changed');}
  if(old&&old.revision===s.revision&&!isDeepStrictEqual(old,s))throw new AppError('REVISION_CONFLICT','A changed definition requires a new revision');
  const g=await grant(s,!old);await project(s);await resolveAgent(vault,s.agentId);
  if(old&&isDeepStrictEqual(old,s))return;
  const concept=old?await vault.read(path(s.id)):undefined;
  // Re-enabling starts from now; time spent disabled must never become catch-up work.
  if(old&&!old.enabled&&s.enabled)await advance(s.id,ctx.clock.now());
  await publish(s,concept?.revision??null,g.generation);
 }
 async function advance(id:string,time:number){await ctx.store.transact(tx=>{const prior=tx.get<Cursor>('schedule-cursor',id);tx.put('schedule-cursor',id,{throughUtc:iso(Math.max(time,prior?instant(prior.throughUtc):-Infinity))});});}
 async function move(id:string,targetOwner:string){
  const s=await read(id);const pending=await ctx.store.read<Move>('schedule-move',id);
  if(pending?.state==='completed'&&pending.targetOwner===targetOwner&&s.ownerId===targetOwner)return;
  if(!(pending?.state==='pending'&&pending.targetOwner===targetOwner&&isDeepStrictEqual(s,pending.schedule)))local(s);
  if(!targetOwner.trim()||targetOwner===ctx.instanceId)throw new AppError('INVALID_TRANSFER','Select another execution instance');
  let intent=pending?.state==='pending'?pending:undefined;
  if(intent&&intent.targetOwner!==targetOwner)throw new AppError('HANDOFF_CONFLICT','Resume the existing schedule move');
  if(!intent){
   const g=await grant(s);const cursor=await ctx.store.read<Cursor>('schedule-cursor',id);const concept=await vault.read(path(id));
   const boundary=Math.max(ctx.clock.now(),instant(s.effectiveFrom),cursor?instant(cursor.throughUtc):-Infinity);
   const transitionId=stableId('schedule-move',id,String(g.generation),targetOwner);
   intent={id,targetOwner,generation:g.generation,transitionId,expectedRevision:concept.revision,state:'pending',schedule:{...s,revision:transitionId,ownerId:targetOwner,effectiveFrom:iso(boundary+1)}};
   await ctx.store.transact(tx=>tx.put('schedule-move',id,intent));
  }
  const occurrences=(await ctx.store.list<Occurrence>('schedule-occurrence')).filter(o=>o.scheduleId===id);
  await workloads.transfer({workloadId:scheduleWorkload(id),expectedGeneration:intent.generation,targetInstanceId:targetOwner,transitionId:intent.transitionId,probe:{stopAndProve:workloadId=>dispatch.stop(occurrences,workloadId)}});
  // Authority has irreversibly moved. The durable intent permits only this exact publication on retry.
  await publish(intent.schedule,intent.expectedRevision);
  await ctx.store.transact(tx=>{for(const o of occurrences)if(o.state==='pending'||o.state==='running'){tx.put('schedule-occurrence',o.id,{...o,state:'cancelled'});tx.delete('schedule-outbox',o.id);}tx.put('schedule-move',id,{...intent,state:'completed'});tx.emit('schedule.transferred',{id,targetOwner});});
 }
 async function flush(occurrence:Occurrence){
  try{await ctx.store.transact(tx=>assertAuthorityScope(tx,occurrence.authority));const sent=await dispatch.send(occurrence);await ctx.store.transact(tx=>{tx.put('schedule-occurrence',sent.id,sent);tx.delete('schedule-outbox',sent.id);tx.emit('schedule.dispatched',{id:sent.id,requestId:sent.requestId});});return sent;}
  catch(error){await ctx.store.transact(tx=>{const pending=tx.get<{id:string}>('schedule-outbox',occurrence.id);if(pending)tx.put('schedule-outbox',occurrence.id,{...pending,failure:error instanceof AppError?error.code:error instanceof Error?error.message:String(error)});});throw error;}
 }
 async function tick(nowUtc:string){
  const now=instant(nowUtc);const failures:unknown[]=[];
  for(const s of await list()){
   if(closed)break;
   try{
   if(s.ownerId!==ctx.instanceId)continue;
   if((await ctx.store.read<Move>('schedule-move',s.id))?.state==='pending')continue;
   let g:WorkloadGrant;
   try{g=await grant(s);}catch(error){if(!(error instanceof AppError))throw error;await ctx.store.transact(tx=>tx.put('schedule-status',s.id,{state:'blocked',reason:error.code}));continue;}
   const active=(await ctx.store.list<Occurrence>('schedule-occurrence')).filter(o=>o.scheduleId===s.id&&(o.state==='pending'||o.state==='running'));
   let running=false;
   for(let o of active){
    if(await ctx.store.read('schedule-outbox',o.id)){
     await workloads.assertOwner(scheduleWorkload(o.scheduleId),o.generation);await project(o.schedule);o=await flush(o);
    }
    const state=await dispatch.status(o);if(state==='pending'||state==='running')running=true;
    else await ctx.store.transact(tx=>tx.put('schedule-occurrence',o.id,{...o,state}));
   }
   if(!s.enabled){await advance(s.id,now);await ctx.store.transact(tx=>tx.delete('schedule-catchup',s.id));continue;}if(running)continue;
   try{await project(s);}catch(error){if(!(error instanceof AppError))throw error;await ctx.store.transact(tx=>tx.put('schedule-status',s.id,{state:'blocked',reason:error.code}));continue;}
   const cursor=await ctx.store.read<Cursor>('schedule-cursor',s.id);const after=Math.max(instant(s.effectiveFrom)-1,cursor?instant(cursor.throughUtc):-Infinity);
   if(after>=now)continue;
   const saved=await ctx.store.read<Catchup>('schedule-catchup',s.id);
   const work:Catchup=saved?.revision===s.revision?saved:{revision:s.revision,target:now,through:iso(after),count:0};
   if(work.target>now)continue; // A reversed clock never admits a future occurrence.
   let complete=false;let scanned=0;
   for(const occurrence of occurrencesAfter(s,work.through)){
    if(instant(occurrence.utc)>work.target){complete=true;break;}
    work.through=occurrence.utc;
    if(!await ctx.store.read('schedule-key',stableId(s.id,occurrence.localKey))){work.first??=occurrence.utc;if(work.latest)work.previous=work.latest.utc;work.latest=occurrence;work.count++;}
    if(++scanned>=128||closed)break;
   }
   if(!complete){await ctx.store.transact(tx=>tx.put('schedule-catchup',s.id,work));await new Promise<void>(resolve=>setImmediate(resolve));continue;}
   const {latest,first,previous,count}=work;
   if(!latest){await advance(s.id,work.target);await ctx.store.transact(tx=>tx.delete('schedule-catchup',s.id));continue;}
   const id=stableId('schedule-occurrence',s.id,latest.localKey);const o:Occurrence={...latest,id,scheduleId:s.id,revision:s.revision,generation:g.generation,schedule:s,state:'pending',requestId:`schedule:${id}`,...(count>1?{skipped:{fromUtc:first!,toUtc:previous!,count:count-1}}:{})};
   await ctx.store.transact(tx=>{
    const binding=tx.get<AuthorityBinding>('authority-binding','current');if(binding)o.authority=authorityScope(binding);assertAuthorityScope(tx,o.authority);
    assertWorkloadAdmission(ctx,tx,scheduleWorkload(s.id),g.generation);
    if(s.projectId){const assignment=tx.get<{assignment:Assignment}>('assignment-grants',s.projectId)?.assignment;if(assignment?.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Project is not owned locally');assertAdmission(ctx,tx,{session:{id,projectId:s.projectId},generation:assignment.generation,authority:o.authority} as SessionRecord);}
    tx.insert('schedule-occurrence',id,o);tx.put('schedule-key',stableId(s.id,o.localKey),{id,utc:o.utc});tx.put('schedule-cursor',s.id,{throughUtc:iso(work.target)});tx.delete('schedule-catchup',s.id);tx.insert('schedule-outbox',id,{id});tx.emit('schedule.admitted',JSON.parse(JSON.stringify(o)));
   });
   await flush(o);
   }catch(error){
    // Keep this schedule's durable intent untouched and let independent schedules run.
    await ctx.store.transact(tx=>tx.put('schedule-status',s.id,{state:'blocked',reason:error instanceof AppError?error.code:error instanceof Error?error.message:String(error)}));
    failures.push(error);
   }
  }
  // Direct callers still observe failure, after every schedule has had its turn.
  if(failures.length===1)throw failures[0];
  if(failures.length>1)throw new AggregateError(failures,'Multiple schedules are blocked');
 }
 return {
  save:(s,revision)=>serial(()=>save(s,revision)),list:()=>serial(list),tick:now=>serial(()=>tick(now)),
  disable:(id,revision)=>serial(async()=>{const s=await read(id);local(s);if(revision!==undefined&&!s.enabled&&s.revision===stableId(revision,'disabled'))return;if(revision!==undefined&&s.revision!==revision)throw new AppError('REVISION_CONFLICT','Schedule definition changed');await save({...s,enabled:false,revision:stableId(s.revision,'disabled')});}),
  transfer:(id,target)=>serial(()=>move(id,target)),async close(){closed=true;await queues.get(ctx);},
 };
}
/** The app owns this polling lifecycle; all work remains in Team/Pi. */
export function startSchedulePolling(ctx:InstanceContext,schedules:ScheduleService){
 let pending:Promise<void>|undefined;let closed=false;
 const poll=()=>{if(closed||pending)return;pending=schedules.tick(new Date(ctx.clock.now()).toISOString()).catch(async error=>{await ctx.store.transact(tx=>tx.put('schedule-service-status','current',{state:'blocked',reason:error instanceof Error?error.message:String(error)}));}).finally(()=>{pending=undefined;});};
 const timer=setInterval(poll,1000);timer.unref();poll();
 return {async close(){closed=true;clearInterval(timer);await pending;await schedules.close();}};
}
