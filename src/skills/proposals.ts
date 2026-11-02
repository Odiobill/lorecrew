import { assertImportedResources } from './import/resources.js';
import { readFile } from 'node:fs/promises';
import { AppError, type Json } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Concept, Vault } from '../vault/types.js';
import type { SkillProposal } from '../learning/types.js';
import { orderedVault, vaultSnapshotLocked } from '../vault/write.js';
import { recoverPendingReplacements } from '../sync/recovery.js';
import { safePath } from '../vault/indexes.js';
import { parseConcept, revisionOf, validatePath } from '../vault/parse.js';
import { skillDefinition, retainedSkillResources, skillSnapshotHash } from './catalog.js';
import { object } from '../learning/evidence.js';
export interface SkillSnapshot {concept:Concept;raw:string;resources:Concept[]}
export interface ProposalRecord {proposal:SkillProposal;candidate:SkillSnapshot;baseline:SkillSnapshot|null;lessons:Concept[];fixtures:Concept[]}
export const proposalPath=(id:string)=>`learning/skill-proposals/${revisionOf(id)}.md`;
export const historyPath=(id:string,revision:string)=>`learning/skill-history/${revisionOf(id)}/${revision}.md`;
export const note=(type:string,title:string,value:unknown,body='')=>`---\n${JSON.stringify({type,title,lorecrew:value})}\n---\n${body}\n`;
export const hashSnapshot=(value:SkillSnapshot)=>skillSnapshotHash(value.concept.revision,value.resources);
export function activeSkill(concepts:Concept[],qualifiedId:string){
 const matches=concepts.filter(c=>{const d=skillDefinition(c);return d?.qualifiedId===qualifiedId&&d.skill.status==='active';});
 if(matches.length>1)throw new AppError('AMBIGUOUS_SKILL','Multiple active skill definitions');return matches[0];
}
export async function skillSnapshot(ctx:InstanceContext,qualifiedId:string,candidatePath?:string):Promise<SkillSnapshot|null>{
 return orderedVault(ctx,async()=>{await recoverPendingReplacements(ctx);const concepts=await vaultSnapshotLocked(ctx);const concept=candidatePath?concepts.find(c=>c.path===candidatePath):activeSkill(concepts,qualifiedId);if(!concept)return null;
 const definition=skillDefinition(concept);if(!definition||definition.qualifiedId!==qualifiedId)throw new AppError('INVALID_SKILL','Candidate identity differs');
 const raw=await readFile(await safePath(ctx.vaultDir,concept.path),'utf8');if(revisionOf(raw)!==concept.revision)throw new AppError('REVISION_CONFLICT','Skill changed during snapshot');
 const resources=retainedSkillResources(concept,concepts)??definition.skill.resources.map(path=>{const r=concepts.find(c=>c.path===path);if(!r)throw new AppError('SKILL_RESOURCE_MISSING','Skill resource is unavailable',{path});return r;});
 assertImportedResources(concept,resources);return {concept,raw,resources};});
}
export async function readProposal(vault:Vault,id:string):Promise<ProposalRecord>{
 const c=await vault.read(proposalPath(id));const record=object(c.metadata.lorecrew) as unknown as ProposalRecord;
 if(c.metadata.type!=='SkillProposal'||record.proposal?.id!==id)throw new AppError('INVALID_PROPOSAL','Invalid saved skill proposal');return record;
}
export async function createProposal(ctx:InstanceContext,vault:Vault,proposal:SkillProposal,actor:string){
 if(!proposal.id?.trim()||!proposal.qualifiedId?.trim()||typeof proposal.expectedImprovement!=='string'||!Array.isArray(proposal.checks)||!Array.isArray(proposal.lessonPaths))throw new AppError('INVALID_PROPOSAL','Invalid skill proposal');
 validatePath(proposal.candidatePath);for(const path of proposal.lessonPaths)validatePath(path);
 if(new Set(proposal.checks.map(c=>c.name)).size!==proposal.checks.length||proposal.checks.some(c=>!c.name.trim()||c.command!=='node --test'))throw new AppError('INVALID_CHECK','Checks require unique names and literal node --test');
 for(const check of proposal.checks)validatePath(check.fixturePath);
 if(proposal.checks.length&&!proposal.checks.some(c=>c.name===proposal.expectedImprovement))throw new AppError('INVALID_CHECK','expectedImprovement must name the declared improvement check');
 const key=revisionOf(proposal.id);let saved=await ctx.store.read<{request:string;record:ProposalRecord}>('skill-proposal-intent',key);const request=JSON.stringify(proposal);
 if(saved&&saved.request!==request)throw new AppError('REQUEST_MISMATCH','Proposal ID already used');
 if(!saved){const candidate=await skillSnapshot(ctx,proposal.qualifiedId,proposal.candidatePath);if(!candidate||skillDefinition(candidate.concept)?.skill.status!=='candidate')throw new AppError('INVALID_SKILL','An inactive candidate is required');
 const baseline=await skillSnapshot(ctx,proposal.qualifiedId);if((baseline?.concept.revision??null)!==proposal.baseRevision)throw new AppError('REVISION_CONFLICT','Active skill differs from proposal baseline');
 const lessons=await Promise.all(proposal.lessonPaths.map(path=>vault.read(path)));const fixtures=await Promise.all(proposal.checks.map(c=>vault.read(c.fixturePath)));
 saved=await ctx.store.transact(tx=>{const old=tx.get<{request:string;record:ProposalRecord}>('skill-proposal-intent',key);if(old){if(old.request!==request)throw new AppError('REQUEST_MISMATCH','Proposal ID already used');return old;}const value={request,record:{proposal,candidate,baseline,lessons,fixtures}};tx.insert('skill-proposal-intent',key,value);return value;});}
 return createCapturedProposal(ctx,vault,saved.record,actor);
}
export const json=(v:unknown)=>v as Json;

/** Publication from an already reviewed immutable capture. Never recapture a newer baseline. */
export async function createCapturedProposal(ctx:InstanceContext,vault:Vault,record:ProposalRecord,actor:string):Promise<{revision:string}>{
 const {proposal,candidate,baseline}=record;
 for(const snapshot of [candidate,...baseline?[baseline]:[]]){
  assertImportedResources(snapshot.concept,snapshot.resources);const parsed=parseConcept(snapshot.concept.path,snapshot.raw);
  if(parsed.revision!==snapshot.concept.revision||JSON.stringify(parsed)!==JSON.stringify(snapshot.concept)||skillDefinition(parsed)?.qualifiedId!==proposal.qualifiedId)throw new AppError('INVALID_PROPOSAL','Captured skill identity or bytes differ');
 }
 if(skillDefinition(candidate.concept)?.skill.status!=='candidate'||candidate.concept.path!==proposal.candidatePath||(baseline?.concept.revision??null)!==proposal.baseRevision)throw new AppError('INVALID_PROPOSAL','Captured proposal differs from its candidate or baseline');
 return vault.propose({id:`skill-proposal:${revisionOf(proposal.id)}`,path:proposalPath(proposal.id),expectedRevision:null,actor,content:note('SkillProposal',proposal.qualifiedId,record,'Inactive candidate; checks and source snapshots retained.')});
}
