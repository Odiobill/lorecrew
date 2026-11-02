import { assertThinkingChoice } from '../runtime/thinking.js';
import type { Context } from 'hono';
import type { TSchema } from 'typebox';
import { AppError, type Json } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Runtime, SessionRecord, SessionSnapshot } from '../runtime/types.js';
import type { Team, TaskRecord, Decision } from '../team/types.js';
import type { Vault } from '../vault/types.js';
import type { Ownership, Assignment } from '../projects/types.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import { resolveAgent,listUsableAgents } from '../agents/resolve.js';
import { stableId } from '../vault/indexes.js';
import { stableId as operationId } from '../runtime/admission.js';
import { COOKIE_NAME, type BrowserSessions, type BrowserSession } from '../auth/sessions.js';
import { authRoutes } from './auth-routes.js';
import { eventStream } from './events.js';
import { setupRoutes } from './setup-routes.js';
import { setupRequest,attachSetupEntity } from '../setup/service.js';
import { operationsRoutes } from './operations-routes.js';
import { knowledgeRoutes } from './knowledge-routes.js';
import { skillImportRoutes } from './skill-import-routes.js';
import { skillManagementRoutes } from './skill-management-routes.js';
import * as S from './schemas.js';
import {repositoryRoutes} from './repository-routes.js';
import {projectRoutes} from './project-routes.js';
import {inboxRoutes} from './inbox-routes.js';
export interface ApiOptions {additionalRoutes?:(security:import('./transport.js').TransportSecurity)=>Route[];ctx:InstanceContext;runtime:Runtime;team:Team;vault:Vault;ownership:Ownership;workspaces:WorkspaceManager;skillImportTransport?:import('../skills/import/github.js').GitHubReader;providerLogins?:import('../runtime/provider-login.js').ProviderLogins;providerOptions?:import('../runtime/providers.js').ProviderOptions;auth?:BrowserSessions;publicOrigin?:string;name?:string;webAssetsDir?:string;sync?:Awaited<ReturnType<typeof import('../sync/service.js').openVaultSync>>;schedules?:import('../schedules/types.js').ScheduleService}
export interface Principal {id:string;kind:'browser'|'token';scopes:readonly string[];session?:BrowserSession}
export interface Route {method:'GET'|'POST'|'PUT'|'DELETE';path:string;body?:TSchema;response:TSchema;query?:Array<{name:string;schema:TSchema;required?:boolean}>;status?:200|201|202;browserOnly?:boolean;idempotent?:boolean;transient?:boolean;handle(c:Context,body:unknown,requestId:string):Promise<unknown>}
export { publicSnapshot } from '../runtime/public-history.js';
import { publicSnapshot } from '../runtime/public-history.js';
export function routes(options:ApiOptions,auth:BrowserSessions,origin:string,principal:(c:Context)=>Principal,authorize:(c:Context)=>Promise<Principal>):Route[] {
  const {ctx,runtime,team,vault,workspaces}=options;
  const sessions=async()=>Promise.all((await ctx.store.list<SessionRecord>('runtime-session')).map(r=>runtime.snapshot(r.session.id).then(publicSnapshot)));
  const projects=async()=>(await ctx.store.list<{assignment:Assignment}>('assignment-grants')).map(g=>({...g.assignment,instanceId:ctx.instanceId}));
  const agents=()=>listUsableAgents(vault);
  const checkModel=async(agentId:string)=>{const agent=await resolveAgent(vault,agentId);assertThinkingChoice(agent.model,(await runtime.listModels()).find(m=>m.provider===agent.model.provider&&m.modelId===agent.model.modelId));};
  const param=(c:Context,name='id')=>c.req.param(name)!;
  return [
    ...authRoutes(ctx,auth,origin,principal,id=>options.providerLogins?.cancelOwner(id)),
    {method:'GET',path:'/instance',response:S.InstanceSchema,async handle(){return {instanceId:ctx.instanceId,name:options.name??'Lorecrew'};}},
    {method:'GET',path:'/models',response:S.Type.Array(S.ModelSchema),async handle(){return runtime.listModels();}},
    {method:'GET',path:'/agents',response:S.Type.Array(S.AgentSchema),async handle(){return agents();}},
    {method:'GET',path:'/projects',response:S.Type.Array(S.ProjectSchema),async handle(){return projects();}},
    {method:'GET',path:'/sessions',response:S.Type.Array(S.SessionSnapshotSchema),async handle(){return sessions();}},
    {method:'GET',path:'/sessions/:id',response:S.SessionSnapshotSchema,async handle(c){return publicSnapshot(await runtime.snapshot(param(c)));}},
    {method:'POST',path:'/sessions',body:S.SessionInputSchema,response:S.SessionRefSchema,status:201,idempotent:true,async handle(c,body,requestId){const input=body as S.SessionInput;requestId=await setupRequest(ctx,'session',c.req.header('idempotency-key'),input,requestId);if(!await ctx.store.read<SessionRecord>('runtime-session',operationId(ctx.instanceId,requestId)))await checkModel(input.agentId);const created=await runtime.createSession({...input,requestId});await attachSetupEntity(ctx,'session',c.req.header('idempotency-key'),created.id);return created;}},
    {method:'POST',path:'/sessions/:id/messages',body:S.TextInputSchema,response:S.SubmissionSchema,status:202,idempotent:true,async handle(c,body,requestId){requestId=await setupRequest(ctx,'message',c.req.header('idempotency-key'),{},requestId,param(c));return runtime.submit({sessionId:param(c),requestId,text:(body as S.TextInput).text});}},
    {method:'POST',path:'/sessions/:id/cancel',body:S.EmptySchema,response:S.OkSchema,idempotent:true,async handle(c){await runtime.cancel(param(c));return {ok:true};}},
    {method:'GET',path:'/tasks',response:S.Type.Array(S.TaskSchema),async handle(){return ctx.store.list<TaskRecord>('team-task');}},
    {method:'GET',path:'/tasks/:id',response:S.TaskSchema,async handle(c){return team.getTask(param(c));}},
    {method:'POST',path:'/tasks',body:S.TaskInputSchema,response:S.TaskSchema,status:201,idempotent:true,async handle(c,body,requestId){const input=body as S.TaskInput;requestId=await setupRequest(ctx,'task',c.req.header('idempotency-key'),input,requestId);if(!await ctx.store.read('team-request',operationId(ctx.instanceId,'team-task',requestId)))await checkModel(input.leadAgentId);return team.createTask({...input,requestId});}},
    {method:'POST',path:'/tasks/:id/steer',body:S.TextInputSchema,response:S.OkSchema,idempotent:true,async handle(c,body,requestId){await team.steer({taskId:param(c),requestId,text:(body as S.TextInput).text});return {ok:true};}},
    {method:'POST',path:'/tasks/:id/cancel',body:S.EmptySchema,response:S.StopTaskResultSchema,idempotent:true,async handle(c){const id=param(c);await team.getTask(id);return team.stopTaskAndProve(id);}},
    {method:'POST',path:'/decisions/:id/answer',body:S.TextInputSchema,response:S.OkSchema,idempotent:true,async handle(c,body,requestId){await team.answer({id:param(c),requestId,text:(body as S.TextInput).text});return {ok:true};}},
    {method:'GET',path:'/workspaces/:id/diff',response:S.DiffSchema,async handle(c){return {diff:await workspaces.diff(param(c))};}},
    {method:'GET',path:'/snapshot',response:S.SnapshotSchema,async handle(){
      const {maxSeq}=await ctx.store.eventPage(0,1);
      return {instanceId:ctx.instanceId,name:options.name??'Lorecrew',seq:maxSeq,sessions:await sessions(),tasks:await ctx.store.list<TaskRecord>('team-task'),decisions:await ctx.store.list<Decision>('team-decision'),projects:await projects(),agents:await agents(),models:await runtime.listModels()};
    }},
    {method:'GET',path:'/events',response:S.SseMessageSchema,async handle(c){return eventStream(ctx,c.req.header('last-event-id')??c.req.query('after'),async()=>{try{await authorize(c);return true;}catch{return false;}},c.req.raw.signal);}},
    ...projectRoutes(options),...repositoryRoutes(options),...inboxRoutes(options),...skillImportRoutes(options,principal),...skillManagementRoutes(options,principal),...setupRoutes(options),...knowledgeRoutes(options,principal),...operationsRoutes(options,principal),
  ];
}
