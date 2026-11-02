import {readFile} from 'node:fs/promises';
import {hash,inputHash} from '../repositories/inspect.js';
import {safeRepositoryPath} from '../repositories/checkpoint.js';
import {queueProjectCheckpoint} from '../projects/checkpoints.js';
import {assertAuthorityScope,type AuthorityScope} from '../projects/authority-domain.js';
import { resolveAgent } from '../agents/resolve.js';
import type { Vault } from '../vault/types.js';
import { isDeepStrictEqual } from 'node:util';
import { AppError, type Json } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { HistoryEntry, Runtime, SessionRecord } from '../runtime/types.js';
import type { Assignment } from '../projects/types.js';
import type { WorkspaceRecord } from '../workspaces/types.js';
import type { Tx } from '../storage/store.js';
import { assertAdmission, requestId, stableId } from '../runtime/admission.js';
import { affectedTasks, assertDependencies, taskState, terminal } from './decisions.js';
import type { Team, TaskRecord, TaskInput, DelegateInput, Decision, MessageInput } from './types.js';
import type { ExecutionReceipt } from '../learning/types.js';
import { object, strings } from '../learning/evidence.js';
import type { ExportReceipt } from '../export/types.js';
import { component } from '../export/history.js';
import { queueLearningCompletion } from '../learning/capture.js';
interface Envelope {id:string;sessionId:string;text:string}
const required=(text:string)=>{if(typeof text!=='string'||!text.trim())throw new AppError('INVALID_INPUT','Nonempty text is required');};
export function openTeam({ctx,runtime,vault,onDelegate}:{ctx:InstanceContext;runtime:Runtime;vault:Vault;onDelegate?:(input:{parentSessionId:string;childTaskId:string;requestId:string})=>Promise<void>}):Team {
  let tail=Promise.resolve();
  const serial=<T>(fn:()=>Promise<T>)=>{const result=tail.then(fn);tail=result.then(()=>{},()=>{});return result;};
  const get=async(id:string)=>{const task=await ctx.store.read<TaskRecord>('team-task',id);if(!task)throw new AppError('TASK_NOT_FOUND','Unknown local task');return task;};
  function local(tx:Tx,id:string) {
    const record=tx.get<SessionRecord>('runtime-session',id);
    if(!record||record.session.instanceId!==ctx.instanceId)throw new AppError('SESSION_NOT_FOUND','Unknown local session');
    assertAdmission(ctx,tx,record);return record;
  }
  function projectAdmission(tx:Tx,task:TaskRecord) {
    const grant=tx.get<{assignment:Assignment}>('assignment-grants',task.projectId)?.assignment;
    if(grant?.generation!==task.generation||grant.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Task generation is not locally owned');
    assertAdmission(ctx,tx,{session:{id:`team-project:${task.projectId}`,projectId:task.projectId},generation:task.generation,...task.authority?{authority:task.authority}:{}} as SessionRecord);
  }
  function admitted(tx:Tx,task:TaskRecord) {
    projectAdmission(tx,task);
    const record=tx.get<SessionRecord>('runtime-session',task.executingSessionId);
    if(record&&record.session.instanceId!==ctx.instanceId)throw new AppError('SESSION_NOT_FOUND','Unknown local session');
    if(record)assertAdmission(ctx,tx,record);
  }
  function history(tx:Tx,id:string,sessionIds:string[],kind:HistoryEntry['kind'],data:Json) {
    for(const sessionId of new Set(sessionIds)) {
      const key=`${sessionId}:${id}`;
      if(!tx.get('team-history',key))tx.insert('team-history',key,{sessionId,entry:{id:`team:${id}`,kind,at:new Date(ctx.clock.now()).toISOString(),data}});
    }
  }
  function envelope(tx:Tx,item:Envelope) {
    const old=tx.get<Envelope>('team-envelope',item.id);
    if(old){if(!isDeepStrictEqual(old,item))throw new AppError('REQUEST_CONFLICT','Message ID names another delivery');return;}
    tx.insert('team-envelope',item.id,item);tx.insert('team-outbox',item.id,item);
  }
  const closedAdmission=new Set(['SESSION_CANCELLED','TASK_TERMINAL','ADMISSION_CLOSED','NOT_OWNER','OWNER_REVOKED','AUTHORITY_RETIRED','AUTHORITY_NOT_LOCAL']);
  async function flush() {
    for(const item of await ctx.store.list<Envelope>('team-outbox')) {
      try {
        await ctx.store.transact(tx=>local(tx,item.sessionId));
        await runtime.submit({sessionId:item.sessionId,requestId:`team:${item.id}`,text:item.text});
        await ctx.store.transact(tx=>{tx.delete('team-outbox',item.id);tx.put('team-delivery',item.id,{state:'delivered'});tx.emit('team.delivered',{id:item.id,sessionId:item.sessionId});});
      } catch(error) {
        if(!(error instanceof AppError)||!closedAdmission.has(error.code))throw error;
        await ctx.store.transact(tx=>{tx.delete('team-outbox',item.id);tx.put('team-delivery',item.id,{state:'cancelled',reason:error.code});tx.emit('team.delivery_cancelled',{id:item.id,reason:error.code});});
      }
    }
  }
  async function refresh() {
    const tasks=await ctx.store.list<TaskRecord>('team-task');const decisions=await ctx.store.list<Decision>('team-decision');
    for(const task of tasks) {
      const session=await ctx.store.read<SessionRecord>('runtime-session',task.executingSessionId);
      if(session?.cancelled&&!terminal(task))task.state='cancelled';
      const state=task.blockedReason&&!session?task.state:taskState(task,tasks,decisions);
      await ctx.store.transact(tx=>{
        const current=tx.get<TaskRecord>('team-task',task.id)!;
        if(!terminal(current)){
          const updated={...current,state};
          if(session){updated.workspaceId=session.workspaceId??'';if(session.workspaceBlockedReason)updated.blockedReason=session.workspaceBlockedReason;else delete updated.blockedReason;}
          tx.put('team-task',task.id,updated);if(terminal(updated))queueProjectCheckpoint(tx,updated);
          if(state==='running'&&current.state!=='running'){const initial=tx.get<Envelope>('team-envelope',`assignment:${task.id}`);if(initial)tx.put('team-outbox',initial.id,initial);}
        }
      });
    }
  }
  async function prepare(task:TaskRecord) {
    if(terminal(task)){await ctx.store.transact(tx=>tx.delete('team-task-outbox',task.id));return;}
    const parent=task.parentTaskId?await get(task.parentTaskId):undefined;
    await ctx.store.transact(tx=>{admitted(tx,task);if(parent)admitted(tx,parent);});
    await runtime.createSession({requestId:task.id,agentId:task.temporaryIdentity?.sourceAgentId??task.agentId,projectId:task.projectId,
      teamTaskId:task.id,...(parent?{parentSessionId:parent.executingSessionId}:{workspaceRole:'lead' as const}),...(task.temporaryIdentity?{temporaryIdentity:task.temporaryIdentity}:{})},task.authority);
    const record=(await ctx.store.read<SessionRecord>('runtime-session',task.executingSessionId))!;
    await ctx.store.transact(tx=>{
      const current=tx.get<TaskRecord>('team-task',task.id)!;
      admitted(tx,current);
      tx.put('team-task',task.id,{...current,workspaceId:record.workspaceId??'',...(record.workspaceBlockedReason?{blockedReason:record.workspaceBlockedReason}:{})});
      envelope(tx,{id:`assignment:${task.id}`,sessionId:task.executingSessionId,text:JSON.stringify({taskId:task.id,objective:task.objective,deliverable:task.deliverable,contextPaths:task.contextPaths,dependsOn:task.dependsOn,leadSessionId:task.leadSessionId,returnSessionId:task.returnSessionId??task.leadSessionId})});
      tx.delete('team-task-outbox',task.id);
    });
  }
  async function create(input:TaskInput|DelegateInput,expectedAuthority?:AuthorityScope):Promise<TaskRecord> {
    requestId(input.requestId);required(input.objective);if(Object.hasOwn(input,'mode'))throw new AppError('INVALID_REQUEST','Obsolete delegation capability mode is not supported');
    const id=stableId(ctx.instanceId,'team-task',input.requestId);
    const old=await ctx.store.read<{input:TaskInput|DelegateInput}>('team-request',id);
    if(old){if(!isDeepStrictEqual(old.input,input))throw new AppError('REQUEST_CONFLICT','Task request ID names another assignment');if(expectedAuthority)await ctx.store.transact(tx=>{assertAuthorityScope(tx,expectedAuthority);admitted(tx,tx.get<TaskRecord>('team-task',id)!);});await recover();return get(id);}
    const parent='parentTaskId' in input?await get(input.parentTaskId):undefined;
    if(parent&&terminal(parent))throw new AppError('TASK_TERMINAL','Cannot delegate from a terminal task');
    const projectId=parent?.projectId??(input as TaskInput).projectId;
    const grant=await ctx.store.read<{assignment:Assignment;authority?:AuthorityScope}>('assignment-grants',projectId);
    if(!grant||grant.assignment.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Claim the project locally before creating tasks');
    let continuationPaths:string[]=[];
    if(!parent&&grant.assignment.checkpoint){const continuation=await ctx.store.read<{generation:number;authority:AuthorityScope;targetInstanceId:string;reference:unknown;contextPaths:string[];contextHashes:Record<string,string>}>('project-continuation-context',projectId);if(!continuation||continuation.generation!==grant.assignment.generation||continuation.targetInstanceId!==ctx.instanceId||inputHash(continuation.reference)!==inputHash(grant.assignment.checkpoint)||inputHash(continuation.authority)!==inputHash(grant.authority??null))throw new AppError('HANDOFF_CONTEXT_REQUIRED','Preflight this actual owner and exact continuation context before starting fresh work');for(const path of continuation.contextPaths)if(hash(await readFile(await safeRepositoryPath(ctx.vaultDir,path)))!==continuation.contextHashes[path])throw new AppError('CHECKPOINT_CONTEXT_CHANGED','Restore the exact accepted checkpoint context before creating fresh work');continuationPaths=continuation.contextPaths;}
    const agentId='agentId' in input?input.agentId:input.leadAgentId;required(agentId);
    await resolveAgent(vault,parent&&agentId.startsWith('helper:')?parent.temporaryIdentity?.sourceAgentId??parent.agentId:agentId);
    const executingSessionId=stableId(ctx.instanceId,id);
    const taskScope=parent?.authority??expectedAuthority??grant.authority;
    const task:TaskRecord={...taskScope?{authority:taskScope}:{},id,projectId,generation:parent?.generation??grant.assignment.generation,executingSessionId,leadSessionId:parent?.leadSessionId??executingSessionId,
      ...(parent?{parentTaskId:parent.id,returnSessionId:parent.executingSessionId}:{}),agentId,
      dependsOn:'dependsOn' in input?[...new Set(input.dependsOn)]:[],objective:input.objective,deliverable:'deliverable' in input?input.deliverable:input.objective,
      contextPaths:'contextPaths' in input?input.contextPaths:continuationPaths,workspaceId:'',state:'pending',
      ...(parent&&agentId.startsWith('helper:')?{temporaryIdentity:{id:agentId,sourceAgentId:parent.temporaryIdentity?.sourceAgentId??parent.agentId,parentTaskId:parent.id}}:{})};
    assertDependencies(await ctx.store.list<TaskRecord>('team-task'),task);
    await ctx.store.transact(tx=>{admitted(tx,task);if(parent)admitted(tx,parent);tx.insert('team-request',id,{input});tx.insert('team-task',id,task);tx.insert('team-task-outbox',id,{id});history(tx,`assignment:${id}`,[task.executingSessionId,...(parent?[parent.executingSessionId]:[])],'delegation',JSON.parse(JSON.stringify(task)));tx.emit('team.assigned',JSON.parse(JSON.stringify(task)));});
    if(parent)await onDelegate?.({parentSessionId:parent.executingSessionId,childTaskId:id,requestId:input.requestId});
    await prepare(task);await refresh();await flush();return get(id);
  }
  async function recover() {
    for(const item of await ctx.store.list<{id:string}>('team-task-outbox')) {
      try{await prepare(await get(item.id));}
      catch(error){
        if(!(error instanceof AppError)||!closedAdmission.has(error.code)&&!['NOT_FOUND','INVALID_DEFINITION','CREDENTIAL_VALUE'].includes(error.code))throw error;
        await ctx.store.transact(tx=>{const task=tx.get<TaskRecord>('team-task',item.id)!;const closed=closedAdmission.has(error.code);tx.put('team-task',item.id,{...task,state:closed?'cancelled':'blocked',blockedReason:error.code.toLowerCase()});if(closed)tx.delete('team-task-outbox',item.id);});
      }
    }
    await refresh();await flush();
  }
  const team:Team={
    createTask:(input,expectedAuthority)=>serial(()=>create(input,expectedAuthority)),delegate:input=>serial(()=>create(input)),
    getTask:id=>serial(async()=>{await refresh();await flush();const task=await get(id);const session=await ctx.store.read<SessionRecord>('runtime-session',task.executingSessionId);return session?.workspaceBlockedReason&&!terminal(task)&&task.state==='running'?{...task,state:'blocked',blockedReason:session.workspaceBlockedReason}:task;}),
    recover:()=>serial(recover),
    async stopTaskAndProve(id){
      // Fence the whole task graph under Team ordering, then release the queue before
      // joining Pi: an aborted tool may itself be waiting for a Team operation.
      const sessions=await serial(async()=>{
        const tasks=await ctx.store.list<TaskRecord>('team-task');const ids=new Set([id]);
        for(let changed=true;changed;){changed=false;for(const task of tasks)if(task.parentTaskId&&ids.has(task.parentTaskId)&&!ids.has(task.id)){ids.add(task.id);changed=true;}}
        const selected=tasks.filter(task=>ids.has(task.id));
        return ctx.store.transact(tx=>{
          for(const task of selected){if(!terminal(task)){const updated={...task,state:'cancelled' as const};tx.put('team-task',task.id,updated);queueProjectCheckpoint(tx,updated);}tx.delete('team-task-outbox',task.id);}
          return selected.filter(task=>tx.get('runtime-session',task.executingSessionId)).map(task=>task.executingSessionId);
        });
      });
      try{for(const sessionId of sessions)await runtime.cancel(sessionId);return {quiescent:true};}
      catch(error){if(error instanceof AppError&&error.code==='NOT_QUIESCENT')return {quiescent:false,reason:error.message};throw error;}
    },
    message:input=>serial(async()=>{
      requestId(input.id);required(input.text);
      await ctx.store.transact(tx=>{
        local(tx,input.fromSessionId);local(tx,input.toSessionId);
        if(input.taskId){const task=tx.get<TaskRecord>('team-task',input.taskId);if(!task)throw new AppError('TASK_NOT_FOUND','Unknown local task');admitted(tx,task);}
        const old=tx.get<MessageInput>('team-message',input.id);if(old&&!isDeepStrictEqual(old,input))throw new AppError('REQUEST_CONFLICT','Message ID names another message');
        tx.put('team-message',input.id,input);history(tx,`message:${input.id}`,[input.fromSessionId,input.toSessionId],'user',{content:[{type:'text',text:input.text}],fromSessionId:input.fromSessionId,toSessionId:input.toSessionId});envelope(tx,{id:`message:${input.id}`,sessionId:input.toSessionId,text:JSON.stringify(input)});
      });await flush();
    }),
    ask:input=>serial(async()=>{
      requestId(input.id);required(input.question);required(input.recommendation);
      const task=await get(input.taskId);const tasks=await ctx.store.list<TaskRecord>('team-task');
      for(const id of input.blockedTaskIds){const blocked=await get(id);if(blocked.projectId!==task.projectId||blocked.generation!==task.generation)throw new AppError('INVALID_DEPENDENCY','Decision can affect only the same local project generation');}
      const decision=await ctx.store.transact(tx=>{
        admitted(tx,task);const old=tx.get<Decision>('team-decision',input.id);
        if(old){const {state:_,answer:__,answerRequestId:___,...original}=old;if(!isDeepStrictEqual(original,input))throw new AppError('REQUEST_CONFLICT','Decision ID names another question');return old;}
        const result:Decision={...input,state:'pending'};tx.insert('team-decision',input.id,result);
        for(const affected of affectedTasks(tasks,input.blockedTaskIds)){const record=tx.get<TaskRecord>('team-task',affected)!;if(!terminal(record))tx.put('team-task',affected,{...record,state:'waiting_decision'});}
        history(tx,`decision:${result.id}`,[task.executingSessionId],'decision',JSON.parse(JSON.stringify(result)));tx.emit('team.decision',JSON.parse(JSON.stringify(result)));return result;
      });return decision;
    }),
    answer:input=>serial(async()=>{
      requestId(input.requestId);required(input.text);
      const decision=await ctx.store.read<Decision>('team-decision',input.id);if(!decision)throw new AppError('DECISION_NOT_FOUND','Unknown local decision');
      const task=await get(decision.taskId);const tasks=await ctx.store.list<TaskRecord>('team-task');
      await ctx.store.transact(tx=>{
        projectAdmission(tx,task);
        if(decision.state==='answered'){if(decision.answer!==input.text||decision.answerRequestId!==input.requestId)throw new AppError('REQUEST_CONFLICT','Decision already has a different answer');return;}
        tx.put('team-decision',decision.id,{...decision,state:'answered',answer:input.text,answerRequestId:input.requestId});
        const affected=affectedTasks(tasks,decision.blockedTaskIds);
        const recipients=new Set(tasks.filter(t=>t.id===task.id||affected.has(t.id)).filter(t=>{
          const current=tx.get<TaskRecord>('team-task',t.id)!;const session=tx.get<SessionRecord>('runtime-session',t.executingSessionId);
          return !terminal(current)&&!session?.cancelled;
        }).map(t=>t.executingSessionId));
        for(const sessionId of recipients)envelope(tx,{id:`answer:${decision.id}:${sessionId}`,sessionId,text:JSON.stringify({decisionId:decision.id,requestId:input.requestId,answer:input.text})});
        history(tx,`answer:${decision.id}`,[task.executingSessionId],'decision',{id:decision.id,taskId:task.id,state:'answered',answer:input.text});tx.emit('team.answered',{id:decision.id,answer:input.text});
      });await refresh();await flush();
    }),
    steer:input=>serial(async()=>{
      requestId(input.requestId);required(input.text);const task=await get(input.taskId);
      await ctx.store.transact(tx=>{admitted(tx,task);history(tx,`steer:${task.id}:${input.requestId}`,[task.executingSessionId,task.leadSessionId],'user',{content:[{type:'text',text:input.text}]});for(const sessionId of new Set([task.executingSessionId,task.leadSessionId]))envelope(tx,{id:`steer:${task.id}:${input.requestId}:${sessionId}`,sessionId,text:JSON.stringify({...input,kind:'user-steering'})});});await flush();
    }),
    report:input=>serial(async()=>{
      requestId(input.requestId);const task=await get(input.taskId);
      const children=(await ctx.store.list<TaskRecord>('team-task')).filter(t=>t.parentTaskId===task.id);
      if(children.some(t=>!terminal(t)))throw new AppError('CHILDREN_ACTIVE','Settle delegated children before reporting a terminal outcome');
      const testReceipts=(await ctx.store.list<ExecutionReceipt>('learning-execution')).filter(r=>r.sessionId===task.executingSessionId).map(r=>r.id);
      const historyPaths=(await ctx.store.list<ExportReceipt>('export-file')).filter(r=>r.path.startsWith(`history/${component(ctx.instanceId)}/${component(task.executingSessionId)}/`)&&!r.path.endsWith('/index.md')).map(r=>r.path);
      await ctx.store.transact(tx=>{
        admitted(tx,task);const id=`${task.id}:${input.requestId}`;const old=tx.get('team-report',id);
        if(old){if(!isDeepStrictEqual(old,input))throw new AppError('REQUEST_CONFLICT','Report ID names another outcome');return;}
        if(terminal(task))throw new AppError('TASK_TERMINAL','Task already has a final outcome');
        tx.insert('team-report',id,input);const updated={...task,state:input.state,outcome:input.outcome};tx.put('team-task',task.id,updated);queueProjectCheckpoint(tx,updated);
        const session=tx.get<SessionRecord>('runtime-session',task.executingSessionId);
        if(session)queueLearningCompletion(tx,{sessionId:task.executingSessionId,at:new Date(ctx.clock.now()).toISOString(),event:{id:`completion:${ctx.instanceId}:${task.id}`,taskId:task.id,instanceId:ctx.instanceId,agentId:task.agentId,model:session.session.model,historyPaths,changedCommits:strings(object(input.outcome).changedCommits),testReceipts,outcome:input.outcome}});
        if(task.returnSessionId)envelope(tx,{id:`report:${id}`,sessionId:task.returnSessionId,text:JSON.stringify(input)});
        history(tx,`report:${id}`,[task.executingSessionId,...(task.returnSessionId?[task.returnSessionId]:[])],'delegation',JSON.parse(JSON.stringify(input)));tx.emit('team.reported',JSON.parse(JSON.stringify(input)));
      });await refresh();await flush();
    }),
  };return team;
}
