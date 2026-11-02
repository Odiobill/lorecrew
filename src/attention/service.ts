import type {RepositoryProblem} from '../repositories/types.js';
import type {Assignment,HandoffState} from '../projects/types.js';
import {inputHash} from '../repositories/inspect.js';
import { AppError } from '../contracts/base.js';
import type { SessionRecord,RuntimeAttentionState } from '../runtime/types.js';
import type { TaskRecord,Decision } from '../team/types.js';
import type { Occurrence } from '../schedules/types.js';
import type { InboxOptions,InboxItem,InboxResult,StoredResult } from './types.js';
import { classifyOrigin,rootTask,outcomeId } from './origin.js';
import { revision,taskRevision } from './revision.js';
import { stableId } from '../runtime/admission.js';
export function openInbox({ctx,runtime,vault}:InboxOptions){
 async function projection(){
  const [tasks,records,occurrences,decisions,reports,outbox]=await Promise.all([ctx.store.list<TaskRecord>('team-task'),ctx.store.list<SessionRecord>('runtime-session'),ctx.store.list<Occurrence>('schedule-occurrence'),ctx.store.list<Decision>('team-decision'),ctx.store.list<StoredResult>('inbox-result'),ctx.store.list<{id:string;failure?:string}>('schedule-outbox')]);
  const local=records.filter(r=>r.session.instanceId===ctx.instanceId),observations=new Map<string,RuntimeAttentionState>();
  for(const r of local)observations.set(r.session.id,await runtime.attentionState(r.session.id));
  const transferred=new Set<string>();
  for(const handoff of await ctx.store.list<HandoffState>('project-handoff')){const assignment=handoff.assignment;if(handoff.phase!=='published'||!handoff.quiescenceProven||handoff.targetInstanceId===ctx.instanceId||assignment?.ownerId!==handoff.targetInstanceId||assignment.generation!==handoff.expectedGeneration+1||assignment.checkpoint?.manifestId!==handoff.transitionId)continue;const revoked=await ctx.store.read<{assignment:Assignment}>('assignment-revocations',JSON.stringify([handoff.projectId,handoff.expectedGeneration])),proof=await ctx.store.read<{reference:unknown}>('checkpoint-handoff-transfer-proof',handoff.transitionId);if(revoked?.assignment.ownerId!==ctx.instanceId||revoked.assignment.generation!==handoff.expectedGeneration||revoked.assignment.repositoryKey!==assignment.repositoryKey||inputHash(proof?.reference??null)!==inputHash(assignment.checkpoint)||local.some(record=>record.session.projectId===handoff.projectId&&observations.get(record.session.id)?.unconfirmedStop))continue;transferred.add(handoff.projectId);}
  const origin=(sessionId:string,taskId?:string)=>classifyOrigin(ctx.instanceId,tasks,occurrences,{sessionId,...taskId?{taskId}:{}},local.find(r=>r.session.id===sessionId));
  const items:InboxItem[]=[],results:Array<InboxResult&{kind:'completed'|'failed'|'report'|'finding'}>=[];const deciding=new Set<string>();
  for(const d of decisions.filter(d=>d.state==='pending')){if(transferred.has(tasks.find(t=>t.id===d.taskId)?.projectId??''))continue;for(const id of [d.taskId,...d.blockedTaskIds]){const t=tasks.find(t=>t.id===id);if(t)deciding.add(t.id);}items.push({id:'decision:'+d.id,revision:revision({question:d.question,recommendation:d.recommendation,blockedTaskIds:[...d.blockedTaskIds].sort(),taskId:d.taskId,state:d.state}),class:'action',kind:'decision',title:d.question,href:'#tasks/'+encodeURIComponent(d.taskId),source:{kind:'decision',decisionId:d.id,taskId:d.taskId}});}
  const ordered=[...occurrences].sort((a,b)=>a.utc.localeCompare(b.utc)||a.id.localeCompare(b.id));
  const latest=new Map<string,string>(),latestFailure=new Map<string,string>();
  const terminal=(task:TaskRecord)=>['completed','failed','cancelled'].includes(task.state);
  const routineInfo=new Map(ordered.map(o=>{
   const root=tasks.find(t=>!t.parentTaskId&&(o.taskId??stableId(ctx.instanceId,'team-task',o.requestId))===t.id);
   const subtree=root?tasks.filter(t=>rootTask(tasks,t).id===root.id):[];
   const sessions=root?subtree.map(t=>t.executingSessionId):[o.sessionId??stableId(ctx.instanceId,o.requestId)];
   const states=sessions.map(id=>observations.get(id));
   const requestFailure=subtree.some(t=>!terminal(t)&&observations.get(t.executingSessionId)?.failure);
   const dispatchFailure=!root&&!states.some(Boolean)?outbox.find(item=>item.id===o.id)?.failure:undefined;
   const failed=root?.state==='failed'||requestFailure||!root&&states.some(state=>state?.failure)||o.state==='failed'||!!dispatchFailure;
   const settled=states.every(state=>!state?.pendingWork&&!state?.unconfirmedStop);
   const successful=(root?root.state==='completed'&&subtree.every(terminal):o.state==='completed')&&settled&&!requestFailure&&!states.some(state=>state?.blockedReason)&&!dispatchFailure;
   return [o.id,{root,states,failed,settled,successful,dispatchFailure}] as const;
  }));
  for(const o of ordered){latest.set(o.scheduleId,o.id);const info=routineInfo.get(o.id)!;if(info.failed)latestFailure.set(o.scheduleId,o.id);else if(info.successful)latestFailure.delete(o.scheduleId);}
  const disabled=new Set((await vault.list()).filter(c=>c.metadata.type==='Schedule').flatMap(c=>{const value=c.metadata.schedule as {id?:string;enabled?:boolean}|undefined;return value?.id&&value.enabled===false?[value.id]:[];}));
  const retired=(scheduleId:string)=>disabled.has(scheduleId)&&ordered.filter(o=>o.scheduleId===scheduleId).every(o=>routineInfo.get(o.id)!.settled);
  function action(id:string,title:string,href:string,source:InboxItem['source'],state:RuntimeAttentionState|undefined,reason?:string){
   const text=state?.unconfirmedStop?'Stop or external effect is not confirmed':reason??state?.blockedReason??state?.failure;
   if(!text)return false;items.push({id,revision:revision({reason:text}),class:'action',kind:state?.failure&&!reason&&!state.unconfirmedStop?'failed':'blocked',title:title+' · '+text,href,source});return true;
  }
  for(const root of tasks.filter(t=>!t.parentTaskId)){
   const source=origin(root.executingSessionId,root.id),subtree=tasks.filter(t=>rootTask(tasks,t).id===root.id),states=subtree.map(t=>observations.get(t.executingSessionId));
   const uncertain=states.find(s=>s?.unconfirmedStop),blocked=states.find(s=>s?.blockedReason&&s.blockedReason!=='waiting_decision'),canonical=subtree.find(t=>t.state==='blocked'&&!(deciding.has(t.id)&&(!t.blockedReason||t.blockedReason==='waiting_decision'))),requestFailure=subtree.filter(t=>!terminal(t)).map(t=>observations.get(t.executingSessionId)).find(s=>s?.failure);
   const id=outcomeId(source),href='#tasks/'+encodeURIComponent(root.id);
   // A newer attempt cannot retire a failure; only successful recovery can. Stop uncertainty always survives.
   const relevant=source.kind!=='schedule'||latest.get(source.scheduleId)===source.occurrenceId;
   const failedRoutine=source.kind==='schedule'&&latestFailure.get(source.scheduleId)===source.occurrenceId&&!retired(source.scheduleId);
   const failure=failedRoutine?(requestFailure?.failure??'Routine failed'):source.kind!=='schedule'?requestFailure?.failure:undefined;
   const rootResult=source.kind==='user_task'&&['completed','failed'].includes(root.state)?{id,revision:taskRevision(root),source,title:root.objective,content:root.outcome??{state:root.state},sourcePaths:[],kind:root.state==='failed'?'failed' as const:'completed' as const}:undefined;
   if(rootResult)results.push(rootResult);
   if(uncertain&&action(id,root.objective,href,source,uncertain))continue;
   if(!transferred.has(root.projectId)&&(failure||relevant&&(blocked||canonical))&&action(id,root.objective,href,source,blocked??requestFailure,canonical?.blockedReason??(requestFailure?undefined:failure)??(canonical?'Work is blocked':undefined)))continue;
   if(rootResult)items.push({id:rootResult.id,revision:rootResult.revision,source:rootResult.source,title:rootResult.title,class:'result',kind:rootResult.kind,href:'#results/'+encodeURIComponent(id)});
  }
  for(const r of local.filter(r=>!tasks.some(t=>t.executingSessionId===r.session.id))){
   const state=observations.get(r.session.id)!,source=origin(r.session.id),id=outcomeId(source);if(r.session.projectId&&transferred.has(r.session.projectId)&&!state.unconfirmedStop)continue;
   const relevant=source.kind!=='schedule'||latest.get(source.scheduleId)===source.occurrenceId;
   const failed=source.kind==='schedule'&&latestFailure.get(source.scheduleId)===source.occurrenceId;
   if(state.unconfirmedStop||source.kind!=='schedule'||!retired(source.scheduleId)&&(failed||relevant&&!state.failure))action(id,r.agent.name,'#conversations/'+encodeURIComponent(r.session.id),source,state);
  }
  // Dispatch may fail before it creates any session. Its exact durable outbox,
  // rather than a potentially stale schedule diagnostic, owns that intervention.
  for(const o of ordered){const info=routineInfo.get(o.id)!;if(!info.dispatchFailure||latestFailure.get(o.scheduleId)!==o.id||retired(o.scheduleId)||items.some(item=>item.id==='run:'+o.id))continue;
   const source={kind:'schedule' as const,occurrenceId:o.id,scheduleId:o.scheduleId};action('run:'+o.id,o.schedule.instructions,'#routines',source,undefined,info.dispatchFailure);
  }
  for(const report of reports){results.push(report);if(!items.some(i=>i.id===report.id))items.push({id:report.id,revision:report.revision,class:'result',kind:report.kind,title:report.title,source:report.source,href:'#results/'+encodeURIComponent(report.id)});}
  for(const problem of await ctx.store.list<RepositoryProblem>('repository-problem'))if(problem.state==='active')items.push({id:'repository:'+problem.id,revision:problem.revision,class:'action',kind:'blocked',title:(problem.repositoryKind==='vault'?'Knowledge vault':problem.repositoryId)+' · '+problem.code,href:'#settings',source:{kind:'repository',repositoryKind:problem.repositoryKind,repositoryId:problem.repositoryId,problemId:problem.id}});
  items.sort((a,b)=>(a.kind==='decision'?0:a.class==='action'?1:2)-(b.kind==='decision'?0:b.class==='action'?1:2)||a.id.localeCompare(b.id));return {items,results,origin};
 }
 async function result(id:string,expected?:string):Promise<InboxResult>{
  if(expected){const old=await ctx.store.read<StoredResult>('inbox-result-version',stableId(id,expected));if(old)return {id:old.id,revision:old.revision,source:old.source,title:old.title,content:old.content,sourcePaths:old.sourcePaths};}
  const value=(await projection()).results.find(r=>r.id===id);if(!value)throw new AppError('NOT_FOUND','Result not found');if(expected&&value.revision!==expected)throw new AppError('REVISION_CONFLICT','This result revision is no longer available. Reload the result.');return {id:value.id,revision:value.revision,source:value.source,title:value.title,content:value.content,sourcePaths:value.sourcePaths};
 }
 return {async list(){const [view,seen]=await Promise.all([projection(),ctx.store.list<{id:string;revision:string}>('ui-inbox-seen')]);const items=view.items.filter(i=>i.class==='action'||!seen.some(m=>m.id===i.id&&m.revision===i.revision));return {items,count:items.length};},result,async resultsForSession(sessionId:string){const view=await projection(),source=view.origin(sessionId);return view.results.filter(r=>r.id===outcomeId(source)).map(r=>({id:r.id,revision:r.revision,title:r.title,kind:r.kind,href:'#results/'+encodeURIComponent(r.id)}));}};
}
