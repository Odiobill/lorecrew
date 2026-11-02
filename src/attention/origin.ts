import type { InstanceContext } from '../instance/open.js';
import type { SessionRecord } from '../runtime/types.js';
import type { TaskRecord } from '../team/types.js';
import type { Occurrence } from '../schedules/types.js';
import type { AttentionOrigin } from './types.js';
import { stableId } from '../runtime/admission.js';
import { AppError } from '../contracts/base.js';
export function rootTask(tasks:TaskRecord[],task:TaskRecord):TaskRecord {
 const visited=new Set<string>();while(task.parentTaskId){if(visited.has(task.id))throw new AppError('INVALID_TASK','Cyclic task parentage');visited.add(task.id);const parent=tasks.find(t=>t.id===task.parentTaskId);if(!parent)throw new AppError('INVALID_TASK','Missing canonical task parent');task=parent;}return task;
}
/** Determine origin before a schedule dispatch receipt has attached its returned IDs. */
export function classifyOrigin(instanceId:string,tasks:TaskRecord[],occurrences:Occurrence[],target:{taskId?:string;sessionId:string},record?:SessionRecord):AttentionOrigin {
 const task=tasks.find(t=>t.id===target.taskId||t.executingSessionId===target.sessionId),root=task?rootTask(tasks,task):undefined;
 const occurrence=occurrences.find(o=>o.schedule.projectId?(o.taskId??stableId(instanceId,'team-task',o.requestId))===root?.id:(o.sessionId??stableId(instanceId,o.requestId))===target.sessionId);
 if(occurrence)return {kind:'schedule',occurrenceId:occurrence.id,scheduleId:occurrence.scheduleId};
 if(root)return {kind:'user_task',rootTaskId:root.id};
 if(record?.input.background&&record.session.workloadId)return {kind:'workload',sessionId:record.session.id,workloadId:record.session.workloadId};
 return {kind:'conversation',sessionId:target.sessionId};
}
export async function attentionOrigin(ctx:InstanceContext,target:{taskId?:string;sessionId:string}) {const [tasks,occurrences,record]=await Promise.all([ctx.store.list<TaskRecord>('team-task'),ctx.store.list<Occurrence>('schedule-occurrence'),ctx.store.read<SessionRecord>('runtime-session',target.sessionId)]);return classifyOrigin(ctx.instanceId,tasks,occurrences,target,record);}
export const outcomeId=(source:AttentionOrigin)=>source.kind==='user_task'?'task:'+source.rootTaskId:source.kind==='schedule'?'run:'+source.occurrenceId:source.kind==='workload'?'workload:'+source.sessionId:'session:'+source.sessionId;
