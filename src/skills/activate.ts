import { archiveSkill } from './history.js';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault, VaultProposal } from '../vault/types.js';
import type { SessionRecord } from '../runtime/types.js';
import type { SkillProposal, SkillEvaluation } from '../learning/types.js';
import type { LearningAssignment } from '../learning/curator.js';
import type { ProcessSupervisor } from '../workspaces/processes.js';
import type { Tx } from '../storage/store.js';
import { assertAdmission } from '../runtime/admission.js';
import { object } from '../learning/evidence.js';
import { parseConcept, revisionOf } from '../vault/parse.js';
import { skillDefinition, skillContentHash, skillHistory } from './catalog.js';
import { createProposal, hashSnapshot, historyPath, json, note, proposalPath, readProposal, skillSnapshot, type SkillSnapshot } from './proposals.js';
import { evaluateSkill, evaluationPath, validatesEvaluation, type EvaluationRecord } from './validate.js';
export interface EvolutionContext {ctx:InstanceContext;vault:Vault;supervisor:ProcessSupervisor;boundary:(record:SessionRecord,signal:AbortSignal)=>Promise<void>}
export function openSkillEvolution({ctx,vault,supervisor,boundary}:EvolutionContext){
 const operations=new Map<Promise<unknown>,{sessionId:string|undefined;controller:AbortController}>();let closing=false;let evaluationTail:Promise<unknown>=Promise.resolve();
 function track<T>(sessionId:string|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(closing)return Promise.reject(new AppError('RUNTIME_CLOSED','Skill evolution is closing'));
  const controller=new AbortController();const promise=Promise.resolve().then(()=>work(controller.signal));operations.set(promise,{sessionId,controller});promise.then(()=>operations.delete(promise),()=>operations.delete(promise));return promise;
 }
 function curatorGuard(record:SessionRecord){return (tx:Tx)=>{
  assertAdmission(ctx,tx,record);const assignment=tx.get<LearningAssignment>('learning-assignment','curator');
  if(record.input.workload?.workloadId!=='curator'||assignment?.ownerId!==ctx.instanceId||assignment.agentId!==record.session.agentId||assignment.generation!==record.input.workload.generation)throw new AppError('NOT_CURATOR','Only the assigned local curator may evaluate or automatically activate');
 };}
 async function curator(sessionId:string){const record=await ctx.store.read<SessionRecord>('runtime-session',sessionId);if(!record)throw new AppError('NOT_CURATOR','A current curator session is required');await ctx.store.transact(curatorGuard(record));return record;}
 async function enter(record:SessionRecord,signal:AbortSignal){signal.throwIfAborted();await ctx.store.transact(curatorGuard(record));await boundary(record,signal);signal.throwIfAborted();await ctx.store.transact(curatorGuard(record));}
 async function activate(input:{proposalId:string;expectedActiveRevision:string|null;mode:'validated'|'explicit_unvalidated';sessionId?:string;userId?:string},signal:AbortSignal){
  const record=input.mode==='validated'?await curator(input.sessionId!):undefined;const actor=record?`agent:${record.session.agentId}`:userActor(input.userId!);if(record)await enter(record,signal);
  const key=revisionOf(JSON.stringify([input.proposalId,input.expectedActiveRevision,input.mode,actor]));const stored=await ctx.store.read<VaultProposal>('skill-activation-intent',key);
  if(stored){signal.throwIfAborted();return vault.propose(stored,record?curatorGuard(record):undefined);}
  const proposal=await readProposal(vault,input.proposalId);const candidate=await skillSnapshot(ctx,proposal.proposal.qualifiedId,proposal.proposal.candidatePath);if(!candidate||skillDefinition(candidate.concept)?.skill.status!=='candidate')throw new AppError('INVALID_SKILL','Proposal candidate is missing');
  const active=await skillSnapshot(ctx,proposal.proposal.qualifiedId);if((active?.concept.revision??null)!==input.expectedActiveRevision||proposal.proposal.baseRevision!==input.expectedActiveRevision)throw new AppError('REVISION_CONFLICT','Active revision changed');
  const preconditions=[{path:candidate.concept.path,revision:candidate.concept.revision},...candidate.resources.map(c=>({path:c.path,revision:c.revision}))];let evaluation:SkillEvaluation|undefined;let evidencePath:string|undefined;
  if(record){
   if(hashSnapshot(candidate)!==hashSnapshot(proposal.candidate)||(active?hashSnapshot(active):null)!==(proposal.baseline?hashSnapshot(proposal.baseline):null))throw new AppError('REVISION_CONFLICT','Evaluated candidate or baseline resources changed');
   evidencePath=evaluationPath(proposal);const c=await vault.read(evidencePath).catch(error=>{if(error instanceof AppError&&error.code==='NOT_FOUND')throw new AppError('SKILL_NOT_ELIGIBLE','No evaluation is recorded');throw error;});const saved=c.metadata.lorecrew as unknown as EvaluationRecord;evaluation=saved.evaluation;
   if(!validatesEvaluation(proposal,saved,await vault.list())||c.metadata.type!=='SkillEvaluation'||saved.proposalHash!==revisionOf(JSON.stringify(proposal))||evaluation?.candidateHash!==hashSnapshot(candidate)||evaluation.baselineRevision!==input.expectedActiveRevision||!evaluation.eligible||!evaluation.improved||evaluation.regressions.length||!evaluation.checks.length||!evaluation.checks.every(c=>c.after==='pass'&&c.before!=='unavailable')||!evaluation.checks.some(c=>c.name===proposal.proposal.expectedImprovement&&c.before==='fail'&&c.after==='pass'))throw new AppError('SKILL_NOT_ELIGIBLE','Declared checks have no proven improvement without regressions');
   for(const path of evaluation.checks.flatMap(c=>c.evidencePaths)){const evidence=await vault.read(path);if(saved.artifactHashes[path]!==evidence.revision)throw new AppError('REVISION_CONFLICT','Evaluation evidence changed');preconditions.push({path,revision:evidence.revision});}
   preconditions.push({path:c.path,revision:c.revision},...active?.resources.map(r=>({path:r.path,revision:r.revision}))??[]);
  }
  const proposalConcept=await vault.read(proposalPath(input.proposalId));preconditions.push({path:proposalConcept.path,revision:proposalConcept.revision});
  if(active)await archiveSkill(ctx,vault,proposal.proposal.qualifiedId,active,actor);
  const lore=object(candidate.concept.metadata.lorecrew);const metadata={...candidate.concept.metadata};delete metadata.verified;delete metadata.id;
  const content=`---\n${JSON.stringify({...metadata,evidenceState:record?'validated':'tentative',lorecrew:{...lore,skill:{...object(lore.skill),status:'active',activation:{mode:input.mode,actor,proposalId:input.proposalId,candidateHash:hashSnapshot(candidate),candidateRevision:candidate.concept.revision,contentHash:skillContentHash(candidate.concept),...(evidencePath?{evaluationPath:evidencePath}:{}),resources:candidate.resources}}}})}\n---\n${candidate.concept.body}`;
  const path=active?.concept.path??`skills/active/${revisionOf(proposal.proposal.qualifiedId)}.md`;const intent:VaultProposal={id:`skill-activate:${key}`,path,expectedRevision:input.expectedActiveRevision,content,actor,preconditions};
  await ctx.store.transact(tx=>{if(record)curatorGuard(record)(tx);tx.put('skill-activation-intent',key,intent);});if(record)await enter(record,signal);signal.throwIfAborted();return vault.propose(intent,record?curatorGuard(record):undefined);
 }
 const api={
  isRunning(sessionId:string){return [...operations.values()].some(operation=>operation.sessionId===sessionId);},
  proposeSkill(input:{proposal:SkillProposal;sessionId:string}){return track(input.sessionId,async signal=>{const record=await ctx.store.read<SessionRecord>('runtime-session',input.sessionId);if(!record)throw new AppError('SESSION_NOT_FOUND','A current local session is required');signal.throwIfAborted();await ctx.store.transact(tx=>assertAdmission(ctx,tx,record));return createProposal(ctx,vault,input.proposal,`agent:${record.session.agentId}`);});},
  evaluateProposal(input:{proposalId:string;sessionId:string}){return track(input.sessionId,signal=>new Promise<SkillEvaluation>((resolve,reject)=>{
   // Only waiting admission may detach promptly. Running work still joins its abort/process proof.
   const abortQueued=()=>reject(signal.reason);signal.addEventListener('abort',abortQueued,{once:true});if(signal.aborted)abortQueued();
   const next=evaluationTail.then(async()=>{
    signal.removeEventListener('abort',abortQueued);signal.throwIfAborted();
    const record=await curator(input.sessionId);await enter(record,signal);const proposal=await readProposal(vault,input.proposalId);
    return evaluateSkill({ctx,vault,supervisor,record,proposal,boundary:()=>enter(record,signal),signal});
   });
   // Keep the actual queue chained to its predecessor even if this caller cancels while waiting.
   evaluationTail=next.catch(()=>{});next.then(resolve,reject);
  }));},
  activateProposal(input:{proposalId:string;expectedActiveRevision:string|null;mode:'validated';sessionId:string}){if(input.mode!=='validated')return Promise.reject(new AppError('USER_ACTION_REQUIRED','Explicit unvalidated activation is a separate user action'));return track(input.sessionId,signal=>activate(input,signal));},
  activateUnvalidated(input:{proposalId:string;expectedActiveRevision:string|null;userId:string}){return track(undefined,signal=>activate({...input,mode:'explicit_unvalidated'},signal));},
  rollbackSkill(input:{qualifiedId:string;expectedActiveRevision:string;targetRevision:string;userId:string}){return track(undefined,async signal=>{
   const actor=userActor(input.userId);const key=revisionOf(JSON.stringify(input));const replay=await ctx.store.read<VaultProposal>('skill-rollback-intent',key);if(replay){signal.throwIfAborted();await vault.propose(replay);return;}const target=await vault.read(historyPath(input.qualifiedId,input.targetRevision));const history=object(target.metadata.lorecrew);const snapshot=skillHistory([target],input.qualifiedId,input.targetRevision);
   if(target.metadata.type!=='SkillHistory'||history.qualifiedId!==input.qualifiedId||!snapshot||revisionOf(snapshot.raw)!==input.targetRevision||skillDefinition(parseConcept(snapshot.concept.path,snapshot.raw))?.qualifiedId!==input.qualifiedId)throw new AppError('INVALID_HISTORY','Retained skill revision is invalid');
   const active=await skillSnapshot(ctx,input.qualifiedId);if(active?.concept.revision!==input.expectedActiveRevision)throw new AppError('REVISION_CONFLICT','Active revision changed');await archiveSkill(ctx,vault,input.qualifiedId,active,actor);signal.throwIfAborted();
   const intent:VaultProposal={id:`skill-rollback:${key}`,path:active.concept.path,expectedRevision:input.expectedActiveRevision,content:snapshot.raw,actor,preconditions:[{path:target.path,revision:target.revision}]};await ctx.store.transact(tx=>tx.put('skill-rollback-intent',key,intent));await vault.propose(intent);
   await ctx.store.transact(tx=>tx.emit('skill.rolled-back',json({...input,actor})));});},
  async quiesce(sessionIds?:string[]){const pending=[...operations].filter(([,v])=>!sessionIds||v.sessionId&&sessionIds.includes(v.sessionId));for(const [,v]of pending)v.controller.abort();await Promise.allSettled(pending.map(([p])=>p));await vault.list();},
  async close(){closing=true;await api.quiesce();},
 };
 return api;
}
function userActor(userId:string){if(typeof userId!=='string'||!userId.trim())throw new AppError('USER_ACTION_REQUIRED','Authenticated user attribution is required');return `user:${userId}`;}
