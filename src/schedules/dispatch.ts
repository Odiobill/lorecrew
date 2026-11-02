import type { InstanceContext } from '../instance/open.js';
import type { Runtime } from '../runtime/types.js';
import type { TaskRecord } from '../team/types.js';
import { stableId } from '../runtime/admission.js';
import type { Occurrence } from './types.js';
export const scheduleWorkload=(id:string)=>`schedule:${id}`;
export function scheduleDispatch(ctx:InstanceContext,runtime:Runtime){
 return {
  async send(occurrence:Occurrence):Promise<Occurrence>{
   const s=occurrence.schedule;
   const text=`${s.instructions}\n\nScheduled occurrence: ${occurrence.utc} (${occurrence.localKey}).${occurrence.skipped?` Coalesced ${occurrence.skipped.count} missed occurrences from ${occurrence.skipped.fromUtc} through ${occurrence.skipped.toUtc}.`:''}`;
   if(s.projectId){
    const task=await runtime.team.createTask({requestId:occurrence.requestId,projectId:s.projectId,leadAgentId:s.agentId,objective:text},occurrence.authority);
    return {...occurrence,state:'running',taskId:task.id,sessionId:task.executingSessionId};
   }
   const session=await runtime.createSession({requestId:occurrence.requestId,agentId:s.agentId,background:true,workload:{workloadId:scheduleWorkload(s.id),generation:occurrence.generation}},occurrence.authority);
   await runtime.submit({sessionId:session.id,requestId:occurrence.requestId,text});
   return {...occurrence,state:'running',sessionId:session.id};
  },
  async status(occurrence:Occurrence):Promise<Occurrence['state']>{
   if(!occurrence.sessionId)return 'pending';
   if(occurrence.taskId){
    const root=await runtime.team.getTask(occurrence.taskId);const tasks=await ctx.store.list<TaskRecord>('team-task');const ids=new Set([root.id]);
    for(let changed=true;changed;){changed=false;for(const task of tasks)if(task.parentTaskId&&ids.has(task.parentTaskId)&&!ids.has(task.id)){ids.add(task.id);changed=true;}}
    if(tasks.some(t=>ids.has(t.id)&&!['completed','failed','cancelled'].includes(t.state)))return 'running';
    return root.state==='completed'?'completed':root.state==='cancelled'?'cancelled':'failed';
   }
   const snapshot=await runtime.snapshot(occurrence.sessionId);
   return ['completed','failed','cancelled'].includes(snapshot.status)?snapshot.status as Occurrence['state']:'running';
  },
  async stop(occurrences:Occurrence[],workloadId:string){
   for(const occurrence of occurrences){
    if(!occurrence.schedule.projectId)continue;
    // The stable task ID is known even if the Team receipt was lost.
    const taskId=occurrence.taskId??stableId(ctx.instanceId,'team-task',occurrence.requestId);
    const proof=await runtime.team.stopTaskAndProve(taskId);if(!proof.quiescent)return proof;
   }
   return runtime.stopWorkloadAndProve(workloadId);
  },
 };
}
