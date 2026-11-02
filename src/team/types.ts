import type { Json } from '../contracts/base.js';
export interface TaskInput {requestId:string;projectId:string;leadAgentId:string;objective:string}
export interface DelegateInput {requestId:string;parentTaskId:string;agentId:string;objective:string;deliverable:string;contextPaths:string[];dependsOn:string[];}
export interface TemporaryIdentity {id:string;sourceAgentId:string;parentTaskId:string}
export interface TaskRecord {
  authority?:import('../projects/authority-domain.js').AuthorityScope;
  id:string;projectId:string;generation:number;leadSessionId:string;executingSessionId:string;returnSessionId?:string;
  parentTaskId?:string;dependsOn:string[];objective:string;deliverable:string;contextPaths:string[];workspaceId:string;
  state:'pending'|'running'|'waiting_decision'|'blocked'|'completed'|'cancelled'|'failed';outcome?:Json;blockedReason?:string;
  agentId:string;temporaryIdentity?:TemporaryIdentity;
}
export interface Decision {id:string;taskId:string;question:string;recommendation:string;blockedTaskIds:string[];state:'pending'|'answered';answer?:string;answerRequestId?:string}
export interface MessageInput {id:string;fromSessionId:string;toSessionId:string;taskId?:string;text:string}
export interface AskInput {id:string;taskId:string;question:string;recommendation:string;blockedTaskIds:string[]}
export interface ReportInput {taskId:string;requestId:string;outcome:Json;state:'completed'|'failed'|'cancelled'}
export interface Team {
  createTask(input:TaskInput,expectedAuthority?:import('../projects/authority-domain.js').AuthorityScope):Promise<TaskRecord>;
  delegate(input:DelegateInput):Promise<TaskRecord>;
  message(input:MessageInput):Promise<void>;
  ask(input:AskInput):Promise<Decision>;
  answer(input:{id:string;requestId:string;text:string}):Promise<void>;
  steer(input:{taskId:string;requestId:string;text:string}):Promise<void>;
  report(input:ReportInput):Promise<void>;
  getTask(id:string):Promise<TaskRecord>;
  recover():Promise<void>;
  stopTaskAndProve(id:string):Promise<{quiescent:boolean;reason?:string}>;
}
