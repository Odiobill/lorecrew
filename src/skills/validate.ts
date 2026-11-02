import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Concept, Vault } from '../vault/types.js';
import type { SessionRecord } from '../runtime/types.js';
import type { ProcessSupervisor } from '../workspaces/processes.js';
import type { ExecutionReceipt, SkillEvaluation } from '../learning/types.js';
import { runCuratorFixture } from '../learning/tools.js';
import { containsCredentials } from '../vault/indexes.js';
import { revisionOf } from '../vault/parse.js';
import { hashSnapshot, note, type ProposalRecord, type SkillSnapshot } from './proposals.js';
export const evaluationPath=(record:ProposalRecord)=>`learning/skill-evaluations/${revisionOf(JSON.stringify(record))}.md`;
export interface EvaluationRecord {evaluation:SkillEvaluation;proposalHash:string;artifactHashes:Record<string,string>;executor:string;at:string}
function fixtureFiles(fixture:Concept):Array<{path:string;content:string}>{
 const files=fixture.metadata.files;
 if(fixture.metadata.type!=='SkillFixture'||!Array.isArray(files)||files.length<1||files.length>15||files.some(f=>!f||typeof f!=='object'||Array.isArray(f)||typeof f.path!=='string'||typeof f.content!=='string'||f.content.length>30000||f.path==='skill-subject.mjs'||!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.mjs$/.test(f.path)||f.path.includes('..'))||!files.some(f=>(f as {path:string}).path.endsWith('.test.mjs'))||new Set(files.map(f=>(f as {path:string}).path)).size!==files.length)throw new AppError('INVALID_FIXTURE','Use bounded unique flat .mjs files; skill-subject.mjs is reserved');
 return files as Array<{path:string;content:string}>;
}
export async function evaluateSkill(input:{ctx:InstanceContext;vault:Vault;supervisor:ProcessSupervisor;record:SessionRecord;proposal:ProposalRecord;boundary:()=>Promise<void>;signal:AbortSignal}):Promise<SkillEvaluation>{
 const {ctx,vault,supervisor,record,proposal,boundary,signal}=input;const path=evaluationPath(proposal);
 const previous=await vault.read(path).catch(error=>{if(error instanceof AppError&&error.code==='NOT_FOUND')return undefined;throw error;});if(previous)return (previous.metadata.lorecrew as unknown as EvaluationRecord).evaluation;
 const checks:SkillEvaluation['checks']=[];let candidateFixturesPass=true;const fixtureRegressions:string[]=[];const artifactHashes:Record<string,string>={};
 for(const [index,check] of proposal.proposal.checks.entries()){
  const fixture=proposal.fixtures[index]!;const files=fixtureFiles(fixture);const outcomes:Array<'pass'|'fail'|'unavailable'>=[];const evidencePaths:string[]=[];let baselineFixturePassed=false;
  for(const [phase,subject] of [['before',proposal.baseline],['after',proposal.candidate]] as const){
   await boundary();signal.throwIfAborted();const requestId=`skill-check:${revisionOf(JSON.stringify([path,check.name,phase,record.session.id]))}`;
   let receipt=await ctx.store.read<ExecutionReceipt>('learning-execution',requestId);
   if(!receipt){const launched=await ctx.store.transact(tx=>{if(tx.get('skill-check-start',requestId))return false;tx.insert('skill-check-start',requestId,{requestId});return true;});
    if(launched){await runCuratorFixture(ctx,supervisor,record,[...files,{path:'skill-subject.mjs',content:`export default ${JSON.stringify(subject?{concept:subject.concept,resources:subject.resources}:null)};`}],requestId,{abortSignal:signal},{subjectHash:subject?hashSnapshot(subject):null,subjectRevision:subject?.concept.revision??null,fixtureRevision:fixture.revision,checkName:check.name,phase});receipt=await ctx.store.read<ExecutionReceipt>('learning-execution',requestId);}
   }
   if(phase==='before')baselineFixturePassed=receipt?.exitCode===0;
   else if(receipt?.exitCode!==0){candidateFixturesPass=false;if(baselineFixturePassed&&checkOutcome(receipt,check.name)==='pass')fixtureRegressions.push(`fixture:${check.name}`);}
   // An infrastructure/file-load error is unavailable, not evidence of baseline failure.
   let outcome=checkOutcome(receipt,check.name);
   const evidencePath=`learning/skill-checks/${revisionOf(requestId)}.md`;
   if(receipt&&containsCredentials(receipt)){outcome='unavailable';await ctx.store.transact(tx=>tx.put('learning-held',requestId,{reason:'Credentials in skill check receipt'}));}
   else {const value={receipt:receipt??null,phase,check,fixtureRevision:fixture.revision,subjectHash:subject?hashSnapshot(subject):null,subjectRevision:subject?.concept.revision??null,outcome,sessionId:record.session.id};
    const written=await vault.propose({id:requestId,path:evidencePath,expectedRevision:null,actor:`agent:${record.session.agentId}`,content:note('SkillCheck',`${check.name} ${phase}`,value,'Actual supervised fixture result. Full process output is local-only.')});evidencePaths.push(evidencePath);artifactHashes[evidencePath]=written.revision;
   }
   outcomes.push(outcome);
  }
  checks.push({name:check.name,before:outcomes[0]!,after:outcomes[1]!,evidencePaths});
 }
 const improvement=checks.find(c=>c.name===proposal.proposal.expectedImprovement);const improved=improvement?.before==='fail'&&improvement.after==='pass';const regressions=[...checks.filter(c=>c.before==='pass'&&c.after!=='pass').map(c=>c.name),...fixtureRegressions];
 const evaluation:SkillEvaluation={proposalId:proposal.proposal.id,candidateHash:hashSnapshot(proposal.candidate),baselineRevision:proposal.baseline?.concept.revision??null,checks,improved,regressions,eligible:improved&&candidateFixturesPass&&checks.every(c=>c.after==='pass'&&c.before!=='unavailable')&&regressions.length===0};
 const value:EvaluationRecord={evaluation,proposalHash:revisionOf(JSON.stringify(proposal)),artifactHashes,executor:`agent:${record.session.agentId}`,at:new Date(ctx.clock.now()).toISOString()};
 await vault.propose({id:`skill-evaluation:${revisionOf(path)}`,path,expectedRevision:null,actor:value.executor,content:note('SkillEvaluation',proposal.proposal.qualifiedId,value)});return evaluation;
}

export function checkOutcome(receipt:ExecutionReceipt|undefined,name:string):'pass'|'fail'|'unavailable'{
 const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const named=receipt&&new RegExp(`^(not )?ok \\d+ - ${escaped}(?: #.*)?$`,'m').exec(receipt.output);
 if(!named||/ # (?:SKIP|TODO)/i.test(named[0])||/# cancelled [1-9]/.test(receipt!.output))return 'unavailable';
 return named[1]?'fail':'pass';
}
/** Recompute portable evidence rather than trusting an edited eligibility flag. */
export function validatesEvaluation(proposal:ProposalRecord,saved:EvaluationRecord,concepts:Concept[]):boolean{
 const ev=saved.evaluation;if(!ev||ev.checks.length!==proposal.proposal.checks.length||saved.proposalHash!==revisionOf(JSON.stringify(proposal)))return false;
 return proposal.proposal.checks.every((check,index)=>{
  const result=ev.checks[index];if(!result||result.name!==check.name||result.evidencePaths.length!==2)return false;
  return (['before','after'] as const).every((phase,part)=>{
   const evidence=concepts.find(c=>c.path===result.evidencePaths[part]);if(evidence?.metadata.type!=='SkillCheck'||saved.artifactHashes[evidence.path]!==evidence.revision)return false;
   const value=evidence.metadata.lorecrew as unknown as {receipt:ExecutionReceipt;check:unknown;phase:string;outcome:string;subjectHash:string|null;subjectRevision:string|null;fixtureRevision:string};const receipt=value.receipt;const subject=phase==='before'?proposal.baseline:proposal.candidate;
   const binding={subjectHash:subject?hashSnapshot(subject):null,subjectRevision:subject?.concept.revision??null,fixtureRevision:proposal.fixtures[index]!.revision,checkName:check.name,phase};
   return (phase!=='after'||receipt?.exitCode===0)&&isDeepStrictEqual(receipt?.skillCheck,binding)&&isDeepStrictEqual(value.check,check)&&value.phase===phase&&value.subjectHash===binding.subjectHash&&value.subjectRevision===binding.subjectRevision&&value.fixtureRevision===binding.fixtureRevision&&value.outcome===checkOutcome(receipt,check.name)&&result[phase]===value.outcome;
  });
 });
}
