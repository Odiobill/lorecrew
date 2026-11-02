import { assertThinkingChoice,thinkingPreference } from './thinking.js';
import {openRepositoryWorkflow,type RepositoryWorkflow} from '../repositories/workflow.js';
import {repositoryTools} from '../repositories/tools.js';
import {openProjectCheckpoints,queueProjectCheckpoint,type ProjectCheckpointRequest} from '../projects/checkpoints.js';
import {openRepositories} from '../repositories/service.js';
import {inputHash} from '../repositories/inspect.js';
import {assertRepositoryChildrenStopped} from '../repositories/git.js';
import { assertAuthorityDomain,assertAuthorityScope,authorityScope } from '../projects/authority-domain.js';
import { reportTools } from '../attention/tools.js';
import { homedir } from 'node:os';
import { ensureExecutionContext, assertExecutionContext, assertExecutionCwd, type ExecutionOwner } from '../workspaces/context.js';
import { assertCurrentExecutionState } from './compatibility.js';
import { agentInstructions } from './instructions.js';
import { openConfiguredWorkloadOwnership } from '../projects/configured-ownership.js';
import { assertRestoredExecutionAllowed } from '../instance/recovery.js';
import { openSkillEvolution } from '../skills/activate.js';
import { openCurator } from '../learning/curator.js';
import { type WorkloadOwnership } from '../projects/workload-grants.js';
import { GitClient } from '../git/client.js';
import { PriorityGate } from '../learning/priority.js';
import { curatorTools, ensureWorkloadWorkspace, assertWorkloadWorkspace } from '../learning/tools.js';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context';
import { Harness, configure, createRegistry, defineDoc, defineExtension, defineTask, GenerationTask, hook, LiveDoc, ProviderDoc, ToolTask, UsageDoc, type ConversationId, type EntryId, type Cursor, type TaskId, type Extension, type ModelRef, type ToolRegistration } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { Models } from '@earendil-works/pi-ai/models';
import type { ModelThinkingLevel } from '@earendil-works/pi-ai';
import { AppError, type Json } from '../contracts/base.js';
import { resolveAgent } from '../agents/resolve.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { Assignment, Ownership } from '../projects/types.js';
import type { WorkspaceManager } from '../workspaces/manager.js';
import type { ProcessSupervisor } from '../workspaces/processes.js';
import type { WorkspaceRecord, ProjectBinding, WorkloadWorkspace } from '../workspaces/types.js';
import { assertAdmission, requestId, stableId } from './admission.js';
import { enqueue, receipt } from './outbox.js';
import { openProviders, listModels, gateModelContinuations } from './providers.js';
import {CodingTools} from '@earendil-works/pi-durable/tools';
import { runtimeTools } from './tools.js';
import { openKnowledge } from '../knowledge/search.js';
import { knowledgeTools, discoveryInstructions } from '../knowledge/tools.js';
import { SkillCatalog } from '../skills/catalog.js';
import { openSkillLoader } from '../skills/load.js';
import { openTeam } from '../team/service.js';
import { teamTools } from '../team/tools.js';
import { terminal } from '../team/decisions.js';
import type { Team, TaskRecord } from '../team/types.js';
import { isDeepStrictEqual } from 'node:util';
import type { Runtime, SessionRecord, SessionSnapshot, EffectRecord, SubmissionRecord, HistoryEntry } from './types.js';
import { publicEntry, controlHistory } from './public-history.js';
import { openLearning } from '../learning/capture.js';
const context=BACKGROUND_CONTEXT;
const RegistryDoc=defineDoc<{sessions:Record<string,number>;lifecycle?:Record<string,number>;reloads?:Record<string,boolean>;priority?:Record<string,number>}>({kind:'lorecrew.sessions',version:1,scope:'session',initial:()=>({sessions:{}}),checkpointWhen:()=>true});
export async function openPiDatabase(path:string) {
  const database=await openNodeSqliteDatabase(path);
  try {
    const storage=await SqliteStorage.open(database);
    // Pi initializes NORMAL. FULL must be applied after initialization, on this connection.
    await database.exec('PRAGMA synchronous=FULL');
    const synchronous=await database.get<{synchronous:number}>('PRAGMA synchronous');
    const journal=await database.get<{journal_mode:string}>('PRAGMA journal_mode');
    if(synchronous?.synchronous!==2 || journal?.journal_mode!=='wal')throw new AppError('PI_DURABILITY','Pi storage requires WAL and synchronous=FULL');
    return {database,storage};
  } catch(error){await database.close();throw error;}
}
export async function openRuntime(options:{ctx:InstanceContext;vault:Vault;ownership:Ownership;workspaces:WorkspaceManager;supervisor:ProcessSupervisor;models?:Models;providerOptions?:import('./providers.js').ProviderOptions;extensions?:readonly Extension[];resume?:boolean;workloadOwnership?:WorkloadOwnership}):Promise<Runtime> {
  const {ctx,vault,ownership,workspaces,supervisor}=options;
  await assertCurrentExecutionState(ctx);
  await assertRestoredExecutionAllowed(ctx);
  if(await ctx.store.read('authority-binding','current')&&!await ctx.store.read('authority-promotion','pending'))await assertAuthorityDomain(ctx);
  let models=options.models??await openProviders(ctx.stateDir,options.providerOptions);
  const availableExtensions=new Set((options.extensions??[]).map(e=>e.name));
  const {database,storage}=await openPiDatabase(join(ctx.stateDir,'pi.sqlite'));
  const retiredSessions=new Set(await ctx.store.keys('repository-retired-session'));
  const sessions=new Map<string,SessionRecord>((await ctx.store.list<SessionRecord>('runtime-session')).map(r=>[r.session.id,r]));
  // Cross-store changes wake projections only after Pi commits. Startup repairs a
  // crash between that commit and the advisory control-store marker.
  const touch=async(ids:string[])=>{await ctx.store.transact(tx=>{for(const id of new Set(ids)){const old=tx.get<{generation:number}>('session-source',id);tx.put('session-source',id,{sessionId:id,generation:(old?.generation??0)+1});}});};
  await ctx.store.transact(tx=>{for(const record of sessions.values()){tx.put('runtime-session-index',record.session.id,{sessionId:record.session.id,instanceId:record.session.instanceId,agentId:record.session.agentId,agentRevision:record.session.agentRevision,projectId:record.session.projectId??null,finished:!!record.finished,cancelled:!!record.cancelled,cancellationSettled:!!record.cancellationSettled});}});
  await touch([...sessions.keys()]);
  const commit=storage.commit.bind(storage);
  storage.commit=async(writes,c)=>{
    const seq=await commit(writes,c);
    const terminalIds=new Set(writes.flatMap(w=>w.type==='task'&&w.value.state.status==='terminal'?[Number(w.value.id)]:[]));
    const conversations=new Set(writes.flatMap(write=>'value' in write&&'conversationId' in write.value?[Number(write.value.conversationId)]:[]));
    const affected=[...sessions.values()].filter(record=>record.conversationId!==undefined&&conversations.has(record.conversationId));
    // Only newly committed transcript entries count as activity. Document updates,
    // reconciliation, and polling still wake projections without changing dates.
    const entries=writes.flatMap(write=>write.type==='entry'&&['pi.user','pi.assistant','pi.tool-result'].includes(write.value.kind)?[write.value]:[]);
    if(entries.length)await ctx.store.transact(tx=>{for(const record of affected){
      const lastEntryId=Math.max(0,...entries.filter(entry=>entry.conversationId===record.conversationId).map(entry=>Number(entry.id)));
      const old=tx.get<{lastEntryId:number;updatedAt:string}>('runtime-session-activity',record.session.id);
      if(lastEntryId>(old?.lastEntryId??0))tx.put('runtime-session-activity',record.session.id,{lastEntryId,updatedAt:new Date(Math.max(ctx.clock.now(),Date.parse(old?.updatedAt??record.createdAt??'')||0)).toISOString()});
    }});
    await touch(affected.map(record=>record.session.id));return seq;
  };
  let harness:Harness;
  let team:Team;
  let repositoryWorkflow:RepositoryWorkflow;let repositoryTimer:ReturnType<typeof setInterval>|undefined;
  let closing=false;
  let tail=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>)=>{
    if(closing)return Promise.reject<T>(new AppError('RUNTIME_CLOSED','Runtime is closing'));
    const result=tail.then(fn);tail=result.then(()=>{},()=>{});return result;
  };
  const save=async(record:SessionRecord)=>{await ctx.store.transact(tx=>tx.put('runtime-session',record.session.id,record));sessions.set(record.session.id,record);};
  const lookup=(id:string)=>{const record=sessions.get(id);if(!record)throw new AppError('SESSION_NOT_FOUND','Unknown local session');return record;};
  const byConversation=(id:number)=>{const record=[...sessions.values()].find(r=>r.conversationId===id);if(!record)throw new AppError('SESSION_NOT_FOUND','Conversation has no local session binding');return record;};
  async function dependency(record:SessionRecord):Promise<string|undefined> {
    if(record.blockedReason==='uncertain_tool_outcome')return record.blockedReason;
    if(record.reloadBlockedReason)return record.reloadBlockedReason;
    if(record.cancelled)return 'cancelled';
    if(record.finished)return undefined;
    if(record.input.teamTaskId) {
      const task=await ctx.store.read<TaskRecord>('team-task',record.input.teamTaskId);
      if(task && ['pending','waiting_decision','blocked'].includes(task.state))return task.state==='pending'?'waiting_dependencies':task.state;
    }
    if(record.extensionSnapshots.some(e=>!availableExtensions.has(e.name)))return 'missing_extension';
    try {await ctx.store.transact(tx=>assertAdmission(ctx,tx,record));}catch(error){return error instanceof AppError?error.code.toLowerCase():'admission_unavailable';}
    if(record.input.workload){
      const workspace=record.workspaceId?await ctx.store.read<WorkloadWorkspace>('workload-workspace',record.workspaceId):undefined;
      if(!workspace||workspace.state!=='active')return record.workspaceBlockedReason??'missing_workspace';
      try{await assertWorkloadWorkspace(ctx,workspace);}catch(error){return error instanceof AppError?error.code.toLowerCase():'missing_workspace';}
    }
    if(record.session.projectId) {
      if(!record.workspaceId)return record.workspaceBlockedReason??'missing_workspace';
      const workspace=await ctx.store.read<WorkspaceRecord>('workspace',record.workspaceId);
      if(!workspace || workspace.state!=='active')return 'missing_workspace';
      try{if(!(await stat(workspace.path)).isDirectory())return 'missing_workspace';}catch{return 'missing_workspace';}
      try{await ownership.assertOwner(record.session.projectId,record.generation!);}catch(error){return error instanceof AppError?error.code.toLowerCase():'ownership_unavailable';}
    }
    if(!record.cwd)return 'execution_cwd_unavailable';
    try{await assertExecutionCwd(record.cwd);}catch{return 'execution_cwd_unavailable';}
    if(record.executionContextId)try{await assertExecutionContext(ctx,record.executionContextId);}catch(error){return error instanceof AppError?error.code.toLowerCase():'execution_context_unavailable';}
    const {provider,modelId}=record.session.model;
    if(!models.getProvider(provider))return 'missing_provider';
    if(!models.getModel(provider,modelId))return 'missing_model';
    try{assertThinkingChoice(record.agent.model,record.modelDescriptor??models.getModel(provider,modelId));}catch(error){return error instanceof AppError?error.code.toLowerCase():'unsupported_thinking_level';}
    try{if(!(await models.getAvailable(provider)).some(m=>m.id===modelId))return 'missing_credential';}catch{return 'missing_credential';}
    return undefined;
  }
  async function block(record:SessionRecord,reason:string|undefined) {
    if(record.blockedReason===reason)return;
    if(reason)record.blockedReason=reason;else delete record.blockedReason;
    await save(record);
  }
  async function foregroundRunnable():Promise<boolean>{
    const tasks=await ctx.store.list<TaskRecord>('team-task');
    const records=await ctx.store.list<SessionRecord>('runtime-session');
    const runnableTeam=tasks.filter(t=>t.state==='running'&&t.dependsOn.every(id=>tasks.find(d=>d.id===id)?.state==='completed'));
    if(runnableTeam.some(t=>!records.some(r=>r.session.id===t.executingSessionId)))return true;
    const inspection=await harness.inspect(context);
    const outbox=await ctx.store.list<SubmissionRecord>('runtime-outbox');
    for(const record of records){
      if(record.input.background||record.cancelled||record.finished)continue;
      if(record.input.teamTaskId&&!runnableTeam.some(t=>t.id===record.input.teamTaskId))continue;
      if(await dependency(record))continue;
      if(outbox.some(s=>s.sessionId===record.session.id&&!s.cancelled)||inspection.submissions.some(s=>s.conversationId===record.conversationId)||inspection.tasks.some(t=>t.record.conversationId===record.conversationId&&!['lorecrew.team-owner','lorecrew.priority-wait'].includes(t.record.kind)))return true;
    }
    return false;
  }
  const priorityWait=defineTask<{sessionId:string},{phase:'wait'},null>({name:'lorecrew.priority-wait',version:1,initial:()=>({phase:'wait'}),phases:{wait:async(task,api,c)=>{
    const record=lookup(task.input.sessionId);
    if(record.cancelled||!await foregroundRunnable()){await api.commit(()=>({status:'terminal',outcome:{status:'completed',result:null}}),c);return;}
    await api.sleepUntil(api.now()+50,{phase:'wait'},c);
  }},abort:async(_task,api,c)=>{await api.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c);}});
  async function waitForPriority(record:SessionRecord,c:Context){
    await block(record,'foreground_priority');
    const id=await harness.commit(async tx=>{
      const doc=await tx.doc(RegistryDoc);doc.priority??={};const previous=doc.priority[record.session.id];
      if(previous){const task=await tx.task(previous as TaskId);if(task&&task.state.status!=='terminal')return previous;}
      return doc.priority[record.session.id]=await tx.createTask(priorityWait,{sessionId:record.session.id},{ownership:{kind:'conversation'},conversationId:record.conversationId as ConversationId,background:true});
    },c);
    await harness.waitForTask(id as TaskId,c);
  }
  async function gate(id:number,c:Context,taskId?:number):Promise<SessionRecord> {
    const record=byConversation(id);
    for(;;) {
      c.abortSignal?.throwIfAborted();
      const saved=await ctx.store.read<SessionRecord>('runtime-session',record.session.id);if(saved)Object.assign(record,saved);
      const reason=await dependency(record);await block(record,reason);
      if(!reason){
        if(record.input.background){const priority=new PriorityGate(foregroundRunnable,()=>waitForPriority(record,c));const permit=await priority.enter('background');permit.release();const after=await dependency(record);await block(record,after);if(after)continue;}
        return record;
      }
      await delay(50,undefined,c.abortSignal?{signal:c.abortSignal}:{});
    }
  }
  const knowledge=openKnowledge({ctx,vault});
  const learning=openLearning({ctx,vault});
  const catalog=new SkillCatalog(vault,knowledge.snapshot);
  const evolution=openSkillEvolution({ctx,vault,supervisor,boundary:async(record,signal)=>{if(options.resume===false)await serial(async()=>{await ensureWorkspace(record);await ensureConversation(record);});await gate(record.conversationId!,withAbortSignal(signal,context));}});
  const skills={catalog,...openSkillLoader({ctx,vault,snapshot:knowledge.snapshot}),...evolution};
  const registry=createRegistry();
  const code=createCodemodeExtension({sandbox:new CodemodeSandbox(),models:false});
  const extensions=runtimeTools(ctx,supervisor,async(api,c)=>gate(api.conversationId,c,api.taskId),[teamTools(()=>team,byConversation),knowledgeTools(knowledge,catalog,skills,byConversation,learning),curatorTools(ctx,vault,supervisor,byConversation,evolution),reportTools(()=>({ctx,vault,runtime}),byConversation),repositoryTools(()=>repositoryWorkflow,byConversation),...options.extensions??[]]);
  // A persistent Pi anchor owns each delegated conversation and survives tool return.
  registry.install(defineExtension({name:'lorecrew-priority',tasks:[priorityWait]}));
  const anchor=defineTask<{taskId:string},{phase:'watch'},Json>({name:'lorecrew.team-owner',version:1,initial:()=>({phase:'watch'}),phases:{watch:async(task,api,c)=>{
    const record=await ctx.store.read<TaskRecord>('team-task',task.input.taskId);
    if(record && terminal(record) && await finishTaskWorkspace(record,api.taskId)) {
      await api.commit(()=>({status:'terminal',outcome:{status:'completed',result:record.outcome??null}}),c);
    } else await api.sleepUntil(api.now()+100,{phase:'watch'},c);
  }},abort:async(task,api,c)=>{
    await ctx.store.transact(tx=>{const record=tx.get<TaskRecord>('team-task',task.input.taskId);if(record&&!terminal(record)){const updated={...record,state:'cancelled' as const};tx.put('team-task',record.id,updated);queueProjectCheckpoint(tx,updated);}});
    await api.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c);
  }});
  registry.install(defineExtension({name:'lorecrew-team-ownership',tasks:[anchor]}));
  async function finishTaskWorkspace(task:TaskRecord,anchorId:TaskId):Promise<boolean> {
    if(closing)return false;
    return serial(async()=>{
      const record=sessions.get(task.executingSessionId);if(!record)return false;
      const inspection=await harness.inspect(context);
      // Only this lifecycle task is exempt. Other anchors, tools and generations must drain.
      if(inspection.tasks.some(t=>t.record.conversationId===record.conversationId&&t.record.id!==anchorId)||inspection.submissions.some(s=>s.conversationId===record.conversationId))return false;
      if(record.workspaceId){
        const proof=await supervisor.stopWorkspace(record.workspaceId);if(!proof.quiescent)return false;
      }
      record.finished=true;delete record.blockedReason;await save(record);
      if(record.workspaceId)await workspaces.release(record.workspaceId);
      await ctx.store.transact(tx=>{queueProjectCheckpoint(tx,task);const request=tx.get<ProjectCheckpointRequest>('project-checkpoint-request',task.id);if(request)tx.put('project-checkpoint-request',task.id,{...request,lifecycleTaskId:Number(anchorId)});});
      for(const waiting of sessions.values())if(!waiting.cancelled&&!waiting.finished&&waiting.workspaceBlockedReason==='workspace_busy')await dispatch(waiting);
      return true;
    });
  }
  async function ensureRootLifecycle(record:SessionRecord) {
    if(retiredSessions.has(record.session.id)||!record.input.teamTaskId||record.input.parentSessionId)return;
    await harness.commit(async tx=>{
      const mapping=await tx.doc(RegistryDoc);if(!mapping.lifecycle)mapping.lifecycle={};const lifecycle=mapping.lifecycle;
      if(!lifecycle[record.session.id])lifecycle[record.session.id]=await tx.createTask(anchor,{taskId:record.input.teamTaskId!},{ownership:{kind:'conversation'},conversationId:record.conversationId as ConversationId,background:true});
    },context);
  }

  const guard=defineExtension({name:'lorecrew-boundaries',hooks:[
    hook(GenerationTask,{beforeRequest:async(_request,api,c)=>{await gate(api.conversationId,c);return undefined;}}),
    hook(ToolTask,{beforeTool:async(_call,api,c)=>{await gate(api.conversationId,c);return undefined;}}),
  ]});
  const extension=(name:string)=>{const found=extensions.find(e=>e.name===name);if(!found)throw new AppError('MISSING_EXTENSION','Required native extension '+name+' is unavailable');return found;};
  const coding=extension(CodingTools.name);const teamExtension=extension('lorecrew-team'),knowledgeExtension=extension('lorecrew-knowledge'),curatorExtension=extension('lorecrew-curator'),reportExtension=extension('lorecrew-results'),repositoryExtension=extension('lorecrew-repositories');
  const curatorKnowledge=defineExtension({...knowledgeExtension,name:'lorecrew-curator-knowledge',tools:knowledgeExtension.tools!.filter(t=>!['memory_remember','knowledge_record_evidence'].includes(t.name))});
  for(const extension of [...extensions,curatorKnowledge,code,guard])registry.install(extension);
  // Keep unavailable tool definitions resolvable so Pi can retain their checkpoints.
  // These placeholders only wait; they never impersonate an installed implementation.
  for(const record of sessions.values())for(const extension of record.extensionSnapshots) {
    if(registry.snapshot().extension(extension.name))continue;
    registry.install(defineExtension({name:extension.name,tools:extension.tools.map(tool=>({...tool,
      async execute(_args:unknown,api,c){await gate(api.conversationId,c);throw new AppError('MISSING_EXTENSION','Reopen the runtime after restoring its extension');},
    } as ToolRegistration))}));
  }
  // Pi validates model existence before its hook. A pinned descriptor preserves that
  // checkpoint's configuration; the hook still gates actual requests on the live catalog.
  const pinnedModels=new Proxy(models,{get(_target,key){const target=models;
    if(key==='getModel')return (provider:string,id:string)=>target.getModel(provider,id)??[...sessions.values()].find(r=>r.modelDescriptor && r.session.model.provider===provider && r.session.model.modelId===id)?.modelDescriptor;
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const gatedModels=gateModelContinuations(pinnedModels,async identity=>{
    let record:SessionRecord|undefined;
    if(identity.sessionId)for(const candidate of sessions.values()) {
      if(candidate.conversationId===undefined)continue;
      if((await harness.snapshot(ProviderDoc,candidate.conversationId as ConversationId,context))?.sessionId===identity.sessionId){record=candidate;break;}
    }
    if(identity.handleId) {
      const task=(await harness.inspect(context)).tasks.find(t=>{
        const checkpoint=t.record.state.status==='terminal'?undefined:t.record.state.checkpoint;
        return checkpoint && typeof checkpoint==='object' && !Array.isArray(checkpoint) && checkpoint.handle && typeof checkpoint.handle==='object' && !Array.isArray(checkpoint.handle) && checkpoint.handle.id===identity.handleId;
      });
      if(task)record=byConversation(task.record.conversationId);
    }
    if(!record?.conversationId)throw new AppError('SESSION_NOT_FOUND','Model continuation lacks its durable session identity');
    await gate(record.conversationId,identity.signal?withAbortSignal(identity.signal,context):context);
    return {model:record.modelDescriptor??models.getModel(record.session.model.provider,record.session.model.modelId)!};
  });
  try {
    harness=await Harness.open(storage,{models:gatedModels,registry,env:async target=>{
      const record=byConversation(target.conversationId);
      if(!record.executionContextId)throw new AppError('CONTEXT_NOT_FOUND','Session has no admitted execution context');
      // Constructing an environment is not leaf admission: a replaying CodeMode orchestrator
      // must reattach committed nested results while its parent epoch is yielded.
      // Every actual host tool crosses gate + boundary admission before using this cwd.
      const execution=await ctx.store.read<import('../workspaces/context.js').ExecutionContext>('execution-context',record.executionContextId);
      if(!execution)throw new AppError('CONTEXT_NOT_FOUND','Session execution context is missing');
      await assertExecutionCwd(execution.cwd);
      return new NodeExecutionEnv({cwd:execution.cwd});
    }},context);
    if((await database.get<{synchronous:number}>('PRAGMA synchronous'))?.synchronous!==2)throw new AppError('PI_DURABILITY','Pi initialization changed synchronous=FULL');
  }catch(error){await storage.close(context);throw error;}
  const allocationFailures=new Set(['PROJECT_NOT_BOUND','NOT_OWNER','OWNER_REVOKED','ADMISSION_CLOSED','BINDING_CHANGED','INVALID_GIT_PROJECT','WORKSPACE_UNCERTAIN','WORKSPACE_BUSY','WORKTREE_FAILED']);
  async function ensureRecordContext(record:SessionRecord) {
    if(record.cancelled||record.finished)return;
    if(!record.cwd){record.workspaceBlockedReason='execution_cwd_unavailable';await save(record);return;}
    const owner:ExecutionOwner=record.input.workload?{kind:'workload',...record.input.workload,workspaceId:record.workspaceId!}:record.session.projectId?{kind:'project',projectId:record.session.projectId,generation:record.generation!,workspaceId:record.workspaceId!}:{kind:'session'};
    try {
      const resume=await ctx.store.read<{contextId:string}>('execution-resume',record.session.id);
      const execution=await ensureExecutionContext(ctx,{sessionId:record.session.id,cwd:record.cwd,owner,...(resume?{afterStoppedContextId:resume.contextId}:{})});
      record.executionContextId=execution.id;delete record.workspaceBlockedReason;await save(record);
      if(resume)await ctx.store.transact(tx=>tx.delete('execution-resume',record.session.id));
    }catch(error){if(!(error instanceof AppError)||!['EXECUTION_CWD_UNAVAILABLE','CONTEXT_STOPPED','WORKSPACE_STOPPED'].includes(error.code))throw error;record.workspaceBlockedReason=error.code.toLowerCase();await save(record);}
  }
  async function ensureWorkspace(record:SessionRecord) {
    if(retiredSessions.has(record.session.id))return;
    if(record.input.workload){if(record.workspaceId){await ensureRecordContext(record);return;}if(!record.workspaceId){try{const workspace=await ensureWorkloadWorkspace(ctx,record);record.workspaceId=workspace.id;record.cwd=workspace.path;await ensureRecordContext(record);delete record.workspaceBlockedReason;await save(record);}catch(error){if(!(error instanceof AppError))throw error;record.workspaceBlockedReason=error.code.toLowerCase();await save(record);}}return;}
    const projectId=record.session.projectId;
    if(!projectId || record.workspaceId){await ensureRecordContext(record);return;}
    try {
      if(!await ctx.store.read<ProjectBinding>('project-binding',projectId))throw new AppError('PROJECT_NOT_BOUND','Bind a local workspace before continuing');
      const grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',projectId);
      if(!grant || grant.assignment.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','No confirmed local project grant');
      if(record.generation===undefined){record.generation=grant.assignment.generation;await save(record);}
      await ownership.assertOwner(projectId,record.generation);
      // Contention is durable blocked state, never an unbounded wait on the mutation queue.
      const workspace=await workspaces.acquire({projectId,taskId:record.session.id,...(record.input.workspaceRole?{role:record.input.workspaceRole}:{})},{wait:false});
      record.workspaceId=workspace.id;record.cwd=workspace.path;await ensureRecordContext(record);delete record.workspaceBlockedReason;await save(record);
    } catch(error) {
      if(!(error instanceof AppError) || !allocationFailures.has(error.code))throw error;
      record.workspaceBlockedReason=error.code==='PROJECT_NOT_BOUND'?'missing_workspace':error.code.toLowerCase();
      await save(record);
    }
  }
  async function ensureConversation(record:SessionRecord) {
    if(record.conversationId){
      // Queued roots/helpers may acquire cwd after conversation creation. Refresh
      // generated execution context from the pinned agent before dispatching input.
      await harness.commit(tx=>configure(tx,record.conversationId as ConversationId,{instructions:agentInstructions(record),cwd:record.cwd??null}),context);return;
    }
    if(record.input.parentSessionId)await ensureConversation(lookup(record.input.parentSessionId));
    const id=await harness.commit(async tx=>{
      const mapping=await tx.doc(RegistryDoc);
      const existing=mapping.sessions[record.session.id];if(existing)return existing;
      const parent=record.input.parentSessionId?lookup(record.input.parentSessionId):undefined;
      if(parent)await ctx.store.transact(control=>assertAdmission(ctx,control,parent));
      const owner=parent?await tx.createTask(anchor,{taskId:record.input.teamTaskId!},{ownership:{kind:'conversation'},conversationId:parent.conversationId as ConversationId,background:true}):undefined;
      const conversation=await tx.createConversation({ownership:owner?{kind:'task',taskId:owner}:{kind:'ownerless'}});
      await configure(tx,conversation.id,{
        model:record.session.model as ModelRef,
        ...(record.agent.model.thinkingLevel?{thinkingLevel:record.agent.model.thinkingLevel as ModelThinkingLevel}:{}),
        instructions:agentInstructions(record),
        extensions:record.input.workload?[curatorKnowledge,curatorExtension,reportExtension,code,guard]:[coding,teamExtension,knowledgeExtension,reportExtension,repositoryExtension,...record.extensionSnapshots.map(e=>registry.snapshot().extension(e.name)!),code,guard],
        ...(record.cwd?{cwd:record.cwd}:{}),
      });
      mapping.sessions[record.session.id]=conversation.id;return conversation.id;
    },context);
    record.conversationId=id;await save(record);
  }
  async function reconcileEffects(recovery:boolean) {
    for(const effect of await ctx.store.list<EffectRecord>('runtime-effect')) {
      if(effect.state==='settled')continue;
      const task=await harness.getTask(effect.taskId as TaskId,context);
      if(task?.state.status==='terminal' && task.state.outcome.status==='completed') {
        await ctx.store.transact(tx=>tx.put('runtime-effect',effect.id,{...effect,state:'settled'}));
      } else if(recovery) await block(lookup(effect.sessionId),'uncertain_tool_outcome');
    }
  }
  async function dispatch(record:SessionRecord) {
    if(!record.cancelled&&!record.finished)await ensureWorkspace(record);await ensureConversation(record);await ensureRootLifecycle(record);if(record.finished)return;await ensureWorkspace(record);
    const reason=await dependency(record);await block(record,reason);if(reason)return;
    const descriptor=models.getModel(record.session.model.provider,record.session.model.modelId);
    if(descriptor && !record.modelDescriptor){record.modelDescriptor=JSON.parse(JSON.stringify(descriptor));await save(record);}
    const conversation=(await harness.conversation(record.conversationId as ConversationId,context))!;
    for(const item of (await ctx.store.list<SubmissionRecord>('runtime-outbox')).filter(s=>s.sessionId===record.session.id && !s.cancelled)) {
      try {await ctx.store.transact(tx=>assertAdmission(ctx,tx,record));}
      catch(error){if(error instanceof AppError && allocationFailures.has(error.code)){await block(record,error.code.toLowerCase());return;}throw error;}
      const submission=await conversation.submit({type:'input',content:item.text,requestId:item.requestId},context);
      await receipt(ctx,item,submission.id);
    }
  }
  type Reload={id:string;sessionId:string;expectedRevision:string;agent:SessionRecord['agent'];modelDescriptor?:SessionRecord['modelDescriptor'];result?:SessionRecord['session'];state:'pending'|'completed'|'blocked';diagnostic?:{code:string;message:string}};
  async function parkReload(reload:Reload,error:AppError){
    const record=lookup(reload.sessionId),next={...record,reloadBlockedReason:error.code.toLowerCase(),blockedReason:record.blockedReason==='uncertain_tool_outcome'?record.blockedReason:error.code.toLowerCase()};
    // Pi may already contain this historical configure. Fence the session and
    // retain the rejected original receipt in the same control transaction.
    await ctx.store.transact(tx=>{tx.put('runtime-session',record.session.id,next);tx.put('runtime-reload',reload.id,{...reload,state:'blocked',diagnostic:{code:error.code,message:error.message}});tx.emit('session.blocked',{sessionId:record.session.id,reason:next.reloadBlockedReason});});sessions.set(record.session.id,next);
  }
  async function finishReload(reload:Reload){
    const record=lookup(reload.sessionId);const descriptor=reload.modelDescriptor??models.getModel(reload.agent.model.provider,reload.agent.model.modelId);assertThinkingChoice(reload.agent.model,descriptor);await ensureConversation(record);
    const next={...record,agent:reload.agent,session:{...record.session,agentRevision:reload.agent.revision,thinkingPreference:thinkingPreference(reload.agent.model),model:{provider:reload.agent.model.provider,modelId:reload.agent.model.modelId}}};next.modelDescriptor=JSON.parse(JSON.stringify(descriptor));
    await harness.commit(async tx=>{const doc=await tx.doc(RegistryDoc);doc.reloads??={};if(!Object.hasOwn(doc.reloads,reload.id)||doc.reloads[reload.id]!==true){await configure(tx,record.conversationId as ConversationId,{model:next.session.model as ModelRef,thinkingLevel:(next.agent.model.thinkingLevel??null) as ModelThinkingLevel|null,instructions:agentInstructions(next)});doc.reloads[reload.id]=true;}},context);
    delete next.reloadBlockedReason;
    await save(next);await ctx.store.transact(tx=>{tx.put('runtime-reload',reload.id,{...reload,state:'completed',result:next.session});tx.emit('session.reloaded',{sessionId:record.session.id,fromRevision:reload.expectedRevision,toRevision:next.session.agentRevision});});return next.session;
  }
  async function quiesceWorkload(workloadId:string){
    await tail;const records=[...sessions.values()].filter(r=>r.input.workload?.workloadId===workloadId);
    for(const record of records){record.cancelled=true;delete record.cancellationSettled;await save(record);}
    const proofPromise=supervisor.stopWorkload(workloadId);
    await Promise.all([evolution.quiesce(records.map(r=>r.session.id)),...records.map(async record=>{const conversation=record.conversationId===undefined?undefined:await harness.conversation(record.conversationId as ConversationId,context);await conversation?.abort(context,{background:true});})]);
    const proof=await proofPromise;if(!proof.quiescent)return proof;
    const inspection=await harness.inspect(context);const ids=new Set(records.map(r=>r.conversationId));if(inspection.tasks.some(t=>ids.has(t.record.conversationId))||inspection.submissions.some(s=>ids.has(s.conversationId)))return {quiescent:false,reason:'Pi has live workload work'};
    for(const record of records){record.cancellationSettled=true;await save(record);}return {quiescent:true};
  }
  let closePromise:Promise<void>|undefined;
  let learningFailure:unknown;
  let learningPending=false;
  let checkpointTimer:ReturnType<typeof setInterval>|undefined;let checkpointService:ReturnType<typeof openProjectCheckpoints>|undefined;let checkpointFailure:unknown;
  let learningTick:Promise<void>|undefined;
  let curator:ReturnType<typeof openCurator>;
  let learningTimer:ReturnType<typeof setInterval>|undefined;
  const runtime:Runtime={
    get team(){return team;},
    knowledge,skills,learning,
    get curator(){return curator;},
    reloadProviders:()=>serial(async()=>{const fresh=await openProviders(ctx.stateDir,options.providerOptions);for(const provider of options.models?.getProviders()??[])if(!fresh.getProvider(provider.id))fresh.setProvider(provider);models=fresh;}),
    quiesceCurator:async()=>{if(!await ctx.store.read('curator-reassignment','pending')&&!await ctx.store.read('authority-promotion','pending'))throw new AppError('ADMISSION_OPEN','Curator reassignment must fence admission first');return quiesceWorkload('curator');},
    reloadAgent:input=>serial(async()=>{
      const existing=await ctx.store.read<Reload>('runtime-reload',input.requestId);if(existing){if(existing.sessionId!==input.sessionId||existing.expectedRevision!==input.expectedRevision)throw new AppError('REQUEST_CONFLICT','Reload request differs');if(existing.state==='blocked')throw new AppError(existing.diagnostic?.code??'RELOAD_BLOCKED',existing.diagnostic?.message??'Historical reload is blocked; repair the saved agent and explicitly reload with a new request');return existing.state==='completed'?(existing.result??{...lookup(input.sessionId).session,agentRevision:existing.agent.revision,model:{provider:existing.agent.model.provider,modelId:existing.agent.model.modelId},thinkingPreference:thinkingPreference(existing.agent.model)}):finishReload(existing);}
      const record=lookup(input.sessionId);if(record.session.agentRevision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Session definition changed');
      if(record.input.workload||record.input.temporaryIdentity||record.cancelled||record.finished)throw new AppError('RELOAD_UNAVAILABLE','Reload applies to active local conversations; workload identities stay pinned');
      const inspection=await harness.inspect(context);const active=inspection.tasks.some(t=>t.record.conversationId===record.conversationId)||inspection.submissions.some(s=>s.conversationId===record.conversationId);
      if(active||(await ctx.store.list<SubmissionRecord>('runtime-outbox')).some(s=>s.sessionId===input.sessionId&&!s.cancelled)||(await ctx.store.list<EffectRecord>('runtime-effect')).some(e=>e.sessionId===input.sessionId&&e.state!=='settled'))throw new AppError('SESSION_BUSY','Wait for an idle session boundary before reloading');
      const agent=await resolveAgent(vault,record.session.agentId);assertThinkingChoice(agent.model,models.getModel(agent.model.provider,agent.model.modelId));
      const reload:Reload={id:input.requestId,...input,agent,modelDescriptor:JSON.parse(JSON.stringify(models.getModel(agent.model.provider,agent.model.modelId))),state:'pending'};await ctx.store.transact(tx=>tx.insert('runtime-reload',reload.id,reload));return finishReload(reload);
    }),
    createSession:(input,expectedAuthority)=>serial(async()=>{
      requestId(input.requestId);
      if(input.workload&&(input.projectId||input.teamTaskId||input.parentSessionId||input.temporaryIdentity||!input.background)||input.background&&!input.workload)throw new AppError('INVALID_SCOPE','Background workload scope must be distinct from project/team scope');
      if(Object.hasOwn(input,'mode'))throw new AppError('INVALID_REQUEST','Obsolete session capability mode is not supported');
      const id=stableId(ctx.instanceId,input.requestId);
      const old=sessions.get(id);
      if(old){if(!isDeepStrictEqual(old.input,input))throw new AppError('REQUEST_CONFLICT','Session request ID already names a different configuration');if(expectedAuthority)await ctx.store.transact(tx=>{assertAuthorityScope(tx,expectedAuthority);assertAdmission(ctx,tx,old);});return old.session;}
      if(input.parentSessionId){const parent=lookup(input.parentSessionId);if(parent.session.projectId!==input.projectId)throw new AppError('INVALID_PARENT','Parent must belong to the same local project');await ctx.store.transact(tx=>assertAdmission(ctx,tx,parent));}
      let agent=await resolveAgent(vault,input.agentId);
      const descriptor=models.getModel(agent.model.provider,agent.model.modelId);assertThinkingChoice(agent.model,descriptor);
      if(input.temporaryIdentity)agent={...agent,id:input.temporaryIdentity.id,name:input.temporaryIdentity.id,personality:`${agent.personality}\nTemporary helper ${input.temporaryIdentity.id}, derived from ${input.temporaryIdentity.sourceAgentId}.`};
      const extensionSnapshots=(input.workload?[]:options.extensions??[]).map(e=>({name:e.name,tools:(e.tools??[]).map(t=>JSON.parse(JSON.stringify({name:t.name,description:t.description,parameters:t.parameters,replay:t.replay,callers:t.callers,structuredOutputSchema:t.structuredOutputSchema})) as Pick<ToolRegistration,'name'|'description'|'parameters'|'replay'|'callers'|'structuredOutputSchema'>)}));
      const currentScope=(input.projectId||input.workload)&&await ctx.store.read('authority-binding','current')?authorityScope(await assertAuthorityDomain(ctx)):undefined;
      const scope=currentScope?{authority:expectedAuthority??currentScope}:{};
      const record:SessionRecord={...scope,createdAt:new Date(ctx.clock.now()).toISOString(),input,agent,modelDescriptor:JSON.parse(JSON.stringify(descriptor)),extensionSnapshots,...(!input.projectId&&!input.workload?{cwd:homedir()}:{}),session:{id,agentId:agent.id,instanceId:ctx.instanceId,agentRevision:agent.revision,thinkingPreference:thinkingPreference(agent.model),model:{provider:agent.model.provider,modelId:agent.model.modelId},...(input.projectId?{projectId:input.projectId}:{}),...(input.workload?{workloadId:input.workload.workloadId}:{})}};
      await ctx.store.transact(tx=>{assertAdmission(ctx,tx,record);tx.insert('runtime-session',id,record);});sessions.set(id,record);
      await dispatch(record);return record.session;
    }),
    submit:input=>serial(async()=>{
      const record=lookup(input.sessionId);
      if(record.input.teamTaskId){const task=await ctx.store.read<TaskRecord>('team-task',record.input.teamTaskId);if(task&&terminal(task))throw new AppError('TASK_TERMINAL','This assignment has a final outcome; create a new task for more work');}
      const submission=await enqueue(ctx,record,input);
      if(!submission.piId && !submission.cancelled)await dispatch(record);
      return {submissionId:submission.id};
    }),
    observationIndexed:true,
    attentionState:async id=>{
      const record=lookup(id),inspection=await harness.inspect(context);
      const pendingWork=(await ctx.store.scan<SubmissionRecord>('runtime-outbox',{field:'sessionId',value:id})).some(s=>!s.cancelled)||record.conversationId!==undefined&&(inspection.submissions.some(s=>s.conversationId===record.conversationId)||inspection.tasks.some(t=>t.record.conversationId===record.conversationId&&!['lorecrew.team-owner','lorecrew.priority-wait'].includes(t.record.kind)));
      let effects=false;for(const effect of await ctx.store.scan<EffectRecord>('runtime-effect',{field:'sessionId',value:id})){if(effect.state==='settled')continue;const task=await harness.getTask(effect.taskId as TaskId,context);if(task?.state.status!=='terminal'||task.state.outcome.status!=='completed')effects=true;}
      const unconfirmedStop=!!(record.cancelled&&!record.cancellationSettled)||!pendingWork&&effects;
      const conversation=record.conversationId===undefined?undefined:await harness.conversation(record.conversationId as ConversationId,context);
      const entries=conversation?(await conversation.context(context)).entries:[];
      const last=entries.filter(e=>e.kind==='pi.assistant').at(-1)?.model?.[0];
      const failure=!record.cancelled&&!pendingWork&&last?.role==='assistant'&&['error','aborted'].includes(last.stopReason)?'The latest request failed':undefined;
      const reason=pendingWork&&!record.cancelled?await dependency(record):undefined;
      return {pendingWork,unconfirmedStop,...failure?{failure}:{},...reason&&!['foreground_priority','waiting_dependencies','waiting_decision'].includes(reason)?{blockedReason:reason}:{}};
    },
    snapshot:async id=>{
      const record=lookup(id);await reconcileEffects(false);
      const conversation=record.conversationId===undefined?undefined:await harness.conversation(record.conversationId as ConversationId,context);
      const entries=conversation?(await conversation.context(context)).entries:[];
      const messages:HistoryEntry[]=entries.filter(e=>['pi.user','pi.assistant','pi.tool-result'].includes(e.kind)).map(e=>({id:String(e.id),kind:e.kind==='pi.user'?'user':e.kind==='pi.assistant'?'assistant':'tool',at:new Date(e.model?.[0]?.timestamp??0).toISOString(),data:JSON.parse(JSON.stringify(e)) as Json}));
      const live=record.conversationId?await harness.snapshot(LiveDoc,record.conversationId as ConversationId,context):undefined;
      const usage=record.conversationId?await harness.snapshot(UsageDoc,record.conversationId as ConversationId,context):undefined;
      const lastAssistant=entries.filter(e=>e.kind==='pi.assistant').at(-1)?.model?.[0];
      const failed=lastAssistant?.role==='assistant' && ['error','aborted'].includes(lastAssistant.stopReason);
      let reason=await dependency(record)??(record.input.background&&(live?.run||evolution.isRunning(id))&&await foregroundRunnable()?'foreground_priority':undefined);
      // A stopped ordinary epoch fences future execution, not its completed transcript.
      // Reading history must neither revive that epoch nor hide outstanding effects/work.
      if(reason==='context_stopped'&&!record.session.projectId&&!record.input.workload&&lastAssistant?.role==='assistant'&&!failed&&lastAssistant.stopReason!=='toolUse'&&!live?.run&&!evolution.isRunning(id)){
        const attention=await runtime.attentionState(id);if(!attention.pendingWork&&!attention.unconfirmedStop)reason=undefined;
      }
      await block(record,reason);
      const taskOutcome=record.finished&&record.input.teamTaskId?(await ctx.store.read<TaskRecord>('team-task',record.input.teamTaskId))?.state:undefined;
      const status:SessionSnapshot['status']=record.cancelled?'cancelled':taskOutcome==='completed'||taskOutcome==='failed'||taskOutcome==='cancelled'?taskOutcome:reason?'blocked':live?.run||evolution.isRunning(id)?'running':failed?'failed':messages.some(m=>m.kind==='assistant')?'completed':'idle';
      const activity=await ctx.store.read<{updatedAt:string}>('runtime-session-activity',id);
      // Repair the Pi/control-store commit gap using original transcript times.
      // Never manufacture a historical date from the time of a snapshot read.
      const lastActivity=Math.max(0,...[record.createdAt,activity?.updatedAt,...messages.map(message=>message.at)].map(at=>at?Date.parse(at)||0:0));
      return {...(record.createdAt?{createdAt:record.createdAt}:{}),...(lastActivity>0?{updatedAt:new Date(lastActivity).toISOString()}:{}),session:{...record.session,thinkingPreference:thinkingPreference(record.agent.model)},status,messages,tools:messages.filter(m=>m.kind==='tool').map(m=>m.data),usage:JSON.parse(JSON.stringify(usage??{})) as Json,...(reason && !record.cancelled?{blockedReason:reason}:{}),...(record.cancelled?{stopState:record.cancellationSettled?'confirmed' as const:'requested' as const}:{})};
    },
    history:async(id,afterEntryId)=>{
      // Pi and control storage cannot share a transaction. Reconcile immutable IDs into
      // a local observation order, so late control/tool entries always follow a cursor.
      const record=lookup(id);
      const last=await ctx.store.read<{entryId:number}>('runtime-transcript-cursor',id);
      const messages:HistoryEntry[]=[];let lastEntryId=last?.entryId??0;const minEntryId=(lastEntryId+1) as EntryId;
      if(record.conversationId) {
        let cursor:Cursor|undefined;
        do {
          const page=await storage.scanEntries({conversationId:record.conversationId as ConversationId,order:'ascending',minEntryId},256,cursor,context);
          for(const entry of page.items){
            lastEntryId=Math.max(lastEntryId,entry.id);
            if(['pi.user','pi.assistant','pi.tool-result'].includes(entry.kind))messages.push(publicEntry({id:String(entry.id),kind:entry.kind==='pi.user'?'user':entry.kind==='pi.assistant'?'assistant':'tool',at:new Date(entry.model?.[0]?.timestamp??0).toISOString(),data:JSON.parse(JSON.stringify(entry)) as Json}));
          }
          cursor=page.next;
        }while(cursor!==undefined);
      }
      // Upgrade the old accumulated array once; subsequent reads load only the
      // requested suffix. Sequence keys remain stable when late records arrive.
      if(!await ctx.store.read('runtime-history-version',id)){
        const legacy=await ctx.store.read<HistoryEntry[]>('runtime-public-history',id)??[];
        await ctx.store.transact(tx=>{let sequence=0;for(const entry of legacy){sequence++;tx.put('runtime-history-entry:'+id,String(sequence).padStart(16,'0'),entry);tx.put('runtime-history-id:'+id,entry.id,{sequence});}tx.put('runtime-history-sequence',id,{sequence});tx.put('runtime-history-version',id,{version:1});tx.delete('runtime-public-history',id);});
      }
      const controlCursor=(await ctx.store.read<{sequence:number}>('runtime-control-cursor',id))?.sequence??0;
      const controls=await controlHistory(ctx,id,controlCursor);
      const cohort=[...messages,...controls.entries].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||(a.id.replace('team:assignment:','team:0:').replace('team:decision:','team:1:').replace('team:answer:','team:2:')).localeCompare(b.id.replace('team:assignment:','team:0:').replace('team:decision:','team:1:').replace('team:answer:','team:2:')));
      await ctx.store.transact(tx=>{
        let sequence=tx.get<{sequence:number}>('runtime-history-sequence',id)?.sequence??0;
        for(const entry of cohort)if(!tx.get('runtime-history-id:'+id,entry.id)){sequence++;tx.put('runtime-history-entry:'+id,String(sequence).padStart(16,'0'),entry);tx.put('runtime-history-id:'+id,entry.id,{sequence});}
        tx.put('runtime-history-sequence',id,{sequence});tx.put('runtime-control-cursor',id,{sequence:controls.sequence});
        tx.put('runtime-transcript-cursor',id,{entryId:Math.max(tx.get<{entryId:number}>('runtime-transcript-cursor',id)?.entryId??0,lastEntryId)});
      });
      let sequence=0;if(afterEntryId!==undefined){const cursor=await ctx.store.read<{sequence:number}>('runtime-history-id:'+id,afterEntryId);if(!cursor)throw new AppError('INVALID_CURSOR','History entry cursor is unknown');sequence=cursor.sequence;}
      return ctx.store.scan<HistoryEntry>('runtime-history-entry:'+id,{after:String(sequence).padStart(16,'0')});
    },
    cancel:async id=>{
      const records=await serial(async()=>{
      lookup(id);
      const ids=new Set([id]);let changed=true;
      while(changed){changed=false;for(const record of sessions.values())if(record.input.parentSessionId&&ids.has(record.input.parentSessionId)&&!ids.has(record.session.id)){ids.add(record.session.id);changed=true;}}
      const records=[...ids].map(lookup);
      for(const record of records){record.cancelled=true;delete record.cancellationSettled;await save(record);}
      // Durable assignments can precede session creation; cancel that graph too.
      const tasks=await ctx.store.list<TaskRecord>('team-task');const taskIds=new Set(tasks.filter(t=>ids.has(t.executingSessionId)).map(t=>t.id));
      let expanded=true;while(expanded){expanded=false;for(const task of tasks)if(task.parentTaskId&&taskIds.has(task.parentTaskId)&&!taskIds.has(task.id)){taskIds.add(task.id);expanded=true;}}
      await ctx.store.transact(tx=>{for(const taskId of taskIds){const task=tx.get<TaskRecord>('team-task',taskId)!;if(!terminal(task)){const updated={...task,state:'cancelled' as const};tx.put('team-task',taskId,updated);queueProjectCheckpoint(tx,updated);}tx.delete('team-task-outbox',taskId);}});
      for(const item of await ctx.store.list<SubmissionRecord>('runtime-outbox'))if(ids.has(item.sessionId))await ctx.store.transact(tx=>{tx.put('runtime-submission',item.id,{...item,cancelled:true});tx.delete('runtime-outbox',item.id);});
      return records;
      });
      await evolution.quiesce(records.map(r=>r.session.id));
      // Native Pi ownership aborts descendants; stop all corresponding host work concurrently.
      const proofs=await Promise.all(records.map(async record=>{
        const conversation=record.conversationId===undefined?undefined:await harness.conversation(record.conversationId as ConversationId,context);
        const workspaceIds=new Set(record.workspaceId?[record.workspaceId]:[]);
        if(record.input.workload)for(const workspace of await ctx.store.list<WorkloadWorkspace>('workload-workspace')){
          if(workspace.taskId===record.session.id&&workspace.workloadId===record.input.workload.workloadId)workspaceIds.add(workspace.id);
        }
        const [,workspaceProofs]=await Promise.all([conversation?.abort(context,{background:true}),Promise.all([...workspaceIds].map(id=>supervisor.stopWorkspace(id)).concat(record.executionContextId?[supervisor.stopContext(record.executionContextId)]:[]))]);
        return {quiescent:workspaceProofs.every(proof=>proof.quiescent)};
      }));
      if(proofs.some(proof=>!proof.quiescent))throw new AppError('NOT_QUIESCENT','Cannot release a workspace with uncertain processes');
      const inspection=await harness.inspect(context);const conversations=new Set(records.map(r=>r.conversationId));
      if(inspection.tasks.some(t=>conversations.has(t.record.conversationId)) || inspection.submissions.some(s=>conversations.has(s.conversationId)))throw new AppError('NOT_QUIESCENT','Pi session work has not settled');
      await serial(async()=>{
      for(const record of records){if(record.workspaceId)await workspaces.release(record.workspaceId);record.cancellationSettled=true;await save(record);}
      // Retry waiting admissions after a proven release; each attempt remains nonblocking.
      for(const waiting of sessions.values())if(!waiting.cancelled && waiting.workspaceBlockedReason==='workspace_busy')await dispatch(waiting);
      });
    },
    checkpointBoundary:async(projectId,taskIds)=>{
      await reconcileEffects(false);
      const tasks:TaskRecord[]=[];for(const id of taskIds){const task=await ctx.store.read<TaskRecord>('team-task',id);if(!task||task.projectId!==projectId||!terminal(task))return {quiescent:false,revision:'',reason:'Selected task is not terminal'};tasks.push(task);}
      const selected=taskIds.length?tasks.map(task=>sessions.get(task.executingSessionId)).filter((r):r is SessionRecord=>!!r):[...sessions.values()].filter(r=>r.session.projectId===projectId);
      if(taskIds.length&&selected.length!==tasks.length)return {quiescent:false,revision:'',reason:'A selected task session is unavailable'};
      const allow=new Set<number>();for(const task of tasks){const request=await ctx.store.read<ProjectCheckpointRequest>('project-checkpoint-request',task.id);if(request?.lifecycleTaskId!==undefined)allow.add(request.lifecycleTaskId);}
      const inspection=await harness.inspect(context),conversations=new Set(selected.map(r=>r.conversationId));
      if(inspection.tasks.some(t=>conversations.has(t.record.conversationId)&&!allow.has(Number(t.record.id)))||inspection.submissions.some(item=>conversations.has(item.conversationId)))return {quiescent:false,revision:'',reason:'Pi task/tool work is still active'};
      const evidence:unknown[]=[];
      for(const local of selected){const record=(await ctx.store.read<SessionRecord>('runtime-session',local.session.id))!;if(!record.finished&&!record.cancellationSettled)return {quiescent:false,revision:'',reason:'The task has not reached its positive release boundary'};const effects=await ctx.store.scan<EffectRecord>('runtime-effect',{field:'sessionId',value:record.session.id});if(effects.some(effect=>effect.state!=='settled'))return {quiescent:false,revision:'',reason:'Tool effects have not settled'};let workspace:WorkspaceRecord|undefined;if(record.workspaceId){workspace=await ctx.store.read<WorkspaceRecord>('workspace',record.workspaceId);if(workspace?.state!=='released')return {quiescent:false,revision:'',reason:'Task workspace is not positively released'};const proof=await supervisor.stopWorkspace(record.workspaceId);if(!proof.quiescent)return {quiescent:false,revision:'',reason:proof.reason??'Task descendants remain uncertain'};}evidence.push({sessionId:record.session.id,authority:record.authority??null,finished:!!record.finished,cancelled:!!record.cancelled,cancellationSettled:!!record.cancellationSettled,workspace:workspace?{id:workspace.id,state:workspace.state,branch:workspace.branch??null}:null,effects:effects.map(e=>({id:e.id,state:e.state}))});}
      return {quiescent:true,revision:inputHash({tasks:tasks.map(t=>({id:t.id,generation:t.generation,state:t.state,outcome:t.outcome??null,authority:t.authority??null})),evidence})};
    },
    stopWorkloadAndProve:async workloadId=>{
      await ctx.store.transact(tx=>{const grant=tx.get<{assignment:{generation:number}}>('workload-grants',workloadId);tx.put('workload-admission',workloadId,{generation:grant?.assignment.generation??0,closed:true});});
      return quiesceWorkload(workloadId);
    },
    stopAndProve:async projectId=>{
      await ctx.store.transact(tx=>tx.put('runtime-project-fence',projectId,{generation:tx.get<{assignment:Assignment}>('assignment-grants',projectId)?.assignment.generation??0}));
      await tail;
      const records=[...sessions.values()].filter(r=>r.session.projectId===projectId);
      const promotion=await ctx.store.read<{id:string}>('authority-promotion','pending');const processes=supervisor.stop(projectId,promotion?{promotionId:promotion.id}:undefined);
      await Promise.all(records.map(async r=>{r.cancelled=true;delete r.cancellationSettled;await save(r);const conversation=r.conversationId===undefined?undefined:await harness.conversation(r.conversationId as ConversationId,context);await conversation?.abort(context,{background:true});}));
      const processProof=await processes;if(!processProof.quiescent)return processProof;
      const inspection=await harness.inspect(context);const ids=new Set(records.map(r=>r.conversationId));
      if(inspection.tasks.some(t=>ids.has(t.record.conversationId)) || inspection.submissions.some(s=>ids.has(s.conversationId)))return {quiescent:false,reason:'Pi still has live project work'};
      for(const record of records){if(record.workspaceId)await workspaces.release(record.workspaceId);record.cancellationSettled=true;await save(record);}
      return {quiescent:true};
    },
    listModels:()=>listModels(models),
    close:()=>closePromise??=(async()=>{
      clearInterval(repositoryTimer);await repositoryWorkflow?.close();clearInterval(checkpointTimer);await checkpointService?.close();await assertRepositoryChildrenStopped(ctx);clearInterval(learningTimer);await learningTick;await curator.close();await evolution.close();closing=true;await tail;
      const ids=new Set([...sessions.values()].map(r=>r.executionContextId).filter((id):id is string=>!!id));
      const [,proofs]=await Promise.all([harness.close(context),Promise.all([...ids].map(async id=>({id,proof:await supervisor.stopContext(id)})))]);
      await learning.close();await knowledge.close();
      if(proofs.some(p=>!p.proof.quiescent))throw new AppError('NOT_QUIESCENT','Runtime shutdown has unresolved process evidence; retain the state lock and inspect descendants');
      await ctx.store.transact(tx=>{for(const {id} of proofs){const execution=tx.get<import('../workspaces/context.js').ExecutionContext>('execution-context',id)!;const record=tx.get<SessionRecord>('runtime-session',execution.sessionId);if(record&&!record.cancelled&&!record.finished)tx.put('execution-resume',execution.sessionId,{contextId:id,reason:'proven_shutdown'});}});
      if(learningFailure)throw learningFailure;if(checkpointFailure)throw checkpointFailure;
    })(),
  };
  const workloadOwnership=options.workloadOwnership??openConfiguredWorkloadOwnership(ctx,new GitClient());
  curator=openCurator({ctx,vault,runtime,ownership:workloadOwnership});
  team=openTeam({ctx,runtime,vault});
  checkpointService=openProjectCheckpoints({ctx,vault,repositories:openRepositories({state:ctx,git:new GitClient()}),runtime});runtime.projectCheckpoints=checkpointService;repositoryWorkflow=openRepositoryWorkflow({ctx,vault,runtime,ownership,callerSettled:async caller=>!(await harness.inspect(context)).tasks.some(t=>Number(t.record.id)===caller.taskId)});runtime.repositories=repositoryWorkflow;if(options.resume!==false){repositoryTimer=setInterval(()=>{void repositoryWorkflow.drain().catch(error=>{checkpointFailure=error;});},250);repositoryTimer.unref();}if(options.resume!==false){checkpointTimer=setInterval(()=>{void checkpointService!.drain().catch(error=>{checkpointFailure=error;});},250);checkpointTimer.unref();}
  try {
    if(options.resume!==false)for(const record of sessions.values()){if(retiredSessions.has(record.session.id))continue;if(!record.cancelled&&!record.finished)await ensureWorkspace(record);await ensureConversation(record);await ensureRootLifecycle(record);}
    for(const reload of await ctx.store.list<Reload>('runtime-reload'))if(reload.state==='pending'){
      try{assertThinkingChoice(reload.agent.model,reload.modelDescriptor??models.getModel(reload.agent.model.provider,reload.agent.model.modelId));}catch(error){if(error instanceof AppError&&['UNSUPPORTED_THINKING_LEVEL','UNKNOWN_MODEL'].includes(error.code)){await parkReload(reload,error);continue;}throw error;}
      if(options.resume!==false)await finishReload(reload);
    }
    await reconcileEffects(true);
    if(options.resume!==false){
      for(const record of sessions.values())if(!record.cancelled&&!retiredSessions.has(record.session.id))await dispatch(record);
      await team.recover();
      harness.resume();
    }
  } catch(error){clearInterval(repositoryTimer);await repositoryWorkflow?.close();clearInterval(checkpointTimer);await checkpointService?.close();await harness.close(context);throw error;}
  // Durable completions are polled independently of foreground Pi work and transport.
  // Per-event failures are recorded by drain; an unavailable control store is surfaced at close.
  learningTimer=setInterval(()=>{if(learningPending||options.resume===false)return;learningPending=true;learningTick=learning.drain().then(()=>curator.tick()).catch(error=>{learningFailure=error;}).finally(()=>{learningPending=false;});},250);learningTimer.unref();
  try{await learning.drain();if(options.resume!==false)await curator.tick();}catch(error){clearInterval(repositoryTimer);await repositoryWorkflow?.close();clearInterval(checkpointTimer);await checkpointService?.close();clearInterval(learningTimer);await harness.close(context);await knowledge.close();throw error;}
  return runtime;
}
