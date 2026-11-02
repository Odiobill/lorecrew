import { AppError } from '../contracts/base.js';
import type { TaskRecord, Decision } from './types.js';
export const terminal=(task:TaskRecord)=>['completed','cancelled','failed'].includes(task.state);
/** Include all transitive dependency consumers, but never unrelated siblings. */
export function affectedTasks(tasks:TaskRecord[],ids:string[]):Set<string> {
  const affected=new Set(ids);let changed=true;
  while(changed){changed=false;for(const task of tasks)if(!affected.has(task.id)&&task.dependsOn.some(id=>affected.has(id))){affected.add(task.id);changed=true;}}
  return affected;
}
export function assertDependencies(tasks:TaskRecord[],candidate:TaskRecord) {
  const all=new Map([...tasks,candidate].map(t=>[t.id,t]));const active=new Set<string>();const done=new Set<string>();
  function visit(id:string) {
    if(active.has(id))throw new AppError('DEPENDENCY_CYCLE','Task dependencies contain a cycle');
    if(done.has(id))return;
    const task=all.get(id);if(!task)throw new AppError('TASK_NOT_FOUND','Unknown dependency');
    if(task.projectId!==candidate.projectId||task.generation!==candidate.generation)throw new AppError('INVALID_DEPENDENCY','Dependencies must belong to the same local project generation');
    active.add(id);for(const dep of task.dependsOn)visit(dep);
    // A parent must join its children before its own terminal report.
    for(const child of all.values())if(child.parentTaskId===id)visit(child.id);
    active.delete(id);done.add(id);
  }
  visit(candidate.id);
}
export function taskState(task:TaskRecord,tasks:TaskRecord[],decisions:Decision[]):TaskRecord['state'] {
  if(terminal(task))return task.state;
  if(decisions.some(d=>d.state==='pending'&&affectedTasks(tasks,d.blockedTaskIds).has(task.id)))return 'waiting_decision';
  const deps=task.dependsOn.map(id=>tasks.find(t=>t.id===id));
  if(deps.some(t=>t?.state==='failed'||t?.state==='cancelled'))return 'blocked';
  if(deps.some(t=>t?.state!=='completed'))return 'pending';
  return 'running';
}
