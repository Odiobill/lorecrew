import type { Team, TemporaryIdentity } from '../team/types.js';
import type { AgentDefinition } from '../agents/types.js';
import type { Json } from '../contracts/base.js';
import type { ToolRegistration } from '@earendil-works/pi-durable';
import type { Model, Api } from '@earendil-works/pi-ai';
export interface SessionRef { thinkingPreference?:import('./thinking.js').ThinkingPreference; id:string; agentId:string; projectId?:string; workloadId?:string; instanceId:string; agentRevision:string; model:{provider:string;modelId:string} }
export interface ModelDescriptor { provider:string; modelId:string; name:string; available:boolean; supportedThinkingLevels:import('@earendil-works/pi-ai').ModelThinkingLevel[] }
export interface HistoryEntry { id:string; kind:'user'|'assistant'|'tool'|'decision'|'delegation'; at:string; data:Json }
export interface SessionSnapshot { createdAt?:string; updatedAt?:string; session:SessionRef; status:'idle'|'running'|'waiting'|'blocked'|'completed'|'cancelled'|'failed'; messages:HistoryEntry[]; tools:Json[]; usage:Json; blockedReason?:string; stopState?:'requested'|'confirmed' }
export interface CreateSession {requestId:string;agentId:string;projectId?:string;teamTaskId?:string;parentSessionId?:string;temporaryIdentity?:TemporaryIdentity;workspaceRole?:'lead';workload?:{workloadId:string;generation:number};background?:boolean}
export interface RuntimeAttentionState {pendingWork:boolean;unconfirmedStop:boolean;failure?:string;blockedReason?:string}
export interface Runtime {
  repositories?:import('../repositories/workflow.js').RepositoryWorkflow;
  projectCheckpoints?:import('../projects/checkpoints.js').ProjectCheckpoints;
  checkpointBoundary?(projectId:string,taskIds:string[]):Promise<{quiescent:boolean;revision:string;reason?:string}>;
  attentionState(sessionId:string):Promise<RuntimeAttentionState>;
  readonly observationIndexed?:true;
  readonly curator:ReturnType<typeof import('../learning/curator.js').openCurator>;
  readonly learning:import('../learning/types.js').Learning;
  readonly knowledge:import('../knowledge/types.js').Knowledge;
  readonly skills:ReturnType<typeof import('../skills/activate.js').openSkillEvolution>&{catalog:import('../skills/catalog.js').SkillCatalog;loadSkill:ReturnType<typeof import('../skills/load.js').openSkillLoader>['loadSkill']};
  readonly team:Team;
  reloadAgent(input:{sessionId:string;expectedRevision:string;requestId:string}):Promise<SessionRef>;
  reloadProviders():Promise<void>;
  quiesceCurator():Promise<{quiescent:boolean;reason?:string}>;
  createSession(input:CreateSession,expectedAuthority?:import('../projects/authority-domain.js').AuthorityScope):Promise<SessionRef>;
  submit(input:{sessionId:string;requestId:string;text:string}):Promise<{submissionId:string}>;
  snapshot(sessionId:string):Promise<SessionSnapshot>;
  history(sessionId:string,afterEntryId?:string):Promise<HistoryEntry[]>;
  cancel(sessionId:string):Promise<void>;
  stopWorkloadAndProve(workloadId:string):Promise<{quiescent:boolean;reason?:string}>;
  stopAndProve(projectId:string):Promise<{quiescent:boolean;reason?:string}>;
  listModels():Promise<ModelDescriptor[]>;
  close():Promise<void>;
}
export interface ExtensionSnapshot {name:string;tools:Array<Pick<ToolRegistration,'name'|'description'|'parameters'|'replay'|'callers'|'structuredOutputSchema'>>}
export interface SessionRecord {
  authority?:import('../projects/authority-domain.js').AuthorityScope;
  createdAt?:string;
  session:SessionRef; extensionSnapshots:ExtensionSnapshot[]; input:CreateSession; agent:AgentDefinition; conversationId?:number;
  executionContextId?:string; generation?:number; workspaceId?:string; workspaceBlockedReason?:string; cwd?:string; modelDescriptor?:Model<Api>;
  cancelled?:true; cancellationSettled?:true; finished?:true; blockedReason?:string; reloadBlockedReason?:string;
}
export interface EffectRecord { id:string;sessionId:string;taskId:number;tool:string; checkpointFiles?:Array<{path:string;hash:string|null}>;state:'started'|'settled' }
export interface SubmissionRecord { id:string;sessionId:string;requestId:string;text:string;piId?:number; cancelled?:true }
