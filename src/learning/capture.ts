import { parseConcept } from '../vault/parse.js';
import { queueCuratorLesson } from './curator.js';
import { isDeepStrictEqual } from 'node:util';
import type { InstanceContext } from '../instance/open.js';
import type { Vault, Concept } from '../vault/types.js';
import { AppError, type Json } from '../contracts/base.js';
import { revisionOf, validatePath } from '../vault/parse.js';
import { relativeLink, component } from '../export/history.js';
import { redact } from '../export/redact.js';
import type { ExportReceipt } from '../export/types.js';
import type { Tx } from '../storage/store.js';
import { canonical, subjectHash } from './hash.js';
import { boundTo, executionOf, object, strings, validEvidence } from './evidence.js';
import type { EvidenceInput, EvidenceRecord, ExecutionReceipt, Learning, LearningEvent } from './types.js';
export interface CompletionLearning {event:LearningEvent;sessionId:string;at:string}
interface CaptureIntent {event:LearningEvent;path:string;lessonId:string;content:string}
interface LearningSources {generation:number;receiptIds:string[];historyPaths:string[]}
interface DirtyLearning {sessionId:string;taskId:string;generation:number}
interface DrainedLearning extends LearningSources {path:string;sourcePaths:string[];at:string}
const emptySources=():LearningSources=>({generation:0,receiptIds:[],historyPaths:[]});
/** Called in the same transaction as the immutable local source receipt. */
export function recordLearningSource(tx:Tx,sessionId:string,source:{receiptId:string}|{historyPath:string}):void {
 const current=tx.get<LearningSources>('learning-sources',sessionId)??emptySources();
 const field='receiptId' in source?'receiptIds':'historyPaths';const id='receiptId' in source?source.receiptId:source.historyPath;
 if(current[field].includes(id))return;
 const next={...current,[field]:[...current[field],id],generation:current.generation+1};tx.put('learning-sources',sessionId,next);
 const taskId=tx.get<{taskId:string}>('learning-session',sessionId)?.taskId;
 if(taskId)tx.put<DirtyLearning>('learning-dirty',sessionId,{sessionId,taskId,generation:next.generation});
}
export function queueLearningCompletion(tx:Tx,item:CompletionLearning):void {
 tx.insert('learning-completion',item.event.taskId,item);tx.put('learning-session',item.sessionId,{taskId:item.event.taskId});
 tx.put<DirtyLearning>('learning-dirty',item.sessionId,{sessionId:item.sessionId,taskId:item.event.taskId,generation:tx.get<LearningSources>('learning-sources',item.sessionId)?.generation??0});
}
const queues=new WeakMap<InstanceContext,Promise<void>>();
const doc=(metadata:Record<string,unknown>,body:string)=>`---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
const printable=(value:Json|undefined)=>value===undefined?'Unknown (not recorded)':typeof value==='string'?value:JSON.stringify(value,null,2);
export function openLearning({ctx,vault}:{ctx:InstanceContext;vault:Vault}):Learning {
 const serial=<T>(fn:()=>Promise<T>)=>{const result=(queues.get(ctx)??Promise.resolve()).then(fn);queues.set(ctx,result.then(()=>{},()=>{}));return result;};
 const safe=(value:string)=>{const checked=redact(value,{});return checked.held?'Held: possible_secret. Original remains local.':value;};
 async function knownPaths(paths:string[]):Promise<string[]> {const result:string[]=[];for(const path of new Set(paths)){validatePath(path);try{await vault.read(path);result.push(path);}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}}return result;}
 async function publishReceipt(receipt:ExecutionReceipt):Promise<string> {
  const path=`evidence/executions/${component(ctx.instanceId)}/${revisionOf(receipt.id)}.md`;
  if(redact(JSON.stringify(receipt),{}).held){await ctx.store.transact(tx=>tx.put('learning-held',receipt.id,{id:receipt.id,reason:'possible_secret'}));throw new AppError('EVIDENCE_HELD','Execution receipt contains possible secrets; retained locally');}
  const published=await vault.propose({id:`execution:${ctx.instanceId}:${receipt.id}`,path,expectedRevision:null,actor:`process:learning:${ctx.instanceId}`,content:doc({type:'ExecutionReceipt',title:'Executed command receipt',lorecrew:{execution:receipt,originId:ctx.instanceId}},`# Executed check\n\nCommand: ${receipt.command}\nExit code: ${receipt.exitCode}\nExecutor instance: ${ctx.instanceId}; session: ${receipt.sessionId}\nRecorded at: ${receipt.at}\nLoaded subjects before execution: ${JSON.stringify(receipt.subjects??[])}\n\nOutput summary (bounded):\n\n${receipt.output}\n\nFull output is ${receipt.localArtifact?'local-only on the originating instance; no shared artifact link is claimed':'not retained'}.\nThis receipt establishes execution, not the causal explanation.`)});
  let current:Concept;try{current=await vault.read(path);}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;throw new AppError('EVIDENCE_UNAVAILABLE','Shared execution receipt was removed');}
  if(current.revision!==published.revision)throw new AppError('EVIDENCE_UNAVAILABLE','Shared execution receipt was changed');return path;
 }
 async function captureLesson(event:LearningEvent){
  const key=revisionOf(canonical([event.instanceId,event.taskId]));const prior=await ctx.store.read<CaptureIntent>('learning-capture',key);
  if(prior&&!isDeepStrictEqual(prior.event,event))throw new AppError('LEARNING_CONFLICT','Task already has a different learning event');
  const captured=await ctx.store.read<{lessonId:string;path:string}>('learning-captured',key);if(prior&&captured)return captured;
  let intent=prior;
  if(!intent){
   const lessonId=`lesson:${key}`;const path=`lessons/${component(event.instanceId)}/${key}.md`;const outcome=object(event.outcome);
   const sourcePaths=await knownPaths(event.historyPaths);const receipts:string[]=[];
   for(const id of event.testReceipts){const r=await ctx.store.read<ExecutionReceipt>('learning-execution',id);if(r){try{receipts.push(await publishReceipt(r));}catch(error){if(!(error instanceof AppError)||!['EVIDENCE_HELD','EVIDENCE_UNAVAILABLE'].includes(error.code))throw error;}}}
   const held=redact(JSON.stringify(event),{}).held;
   const title=held?'Task lesson: content held':`Task lesson: ${printable(outcome.summary??event.outcome).slice(0,120)}`;
   const body=held?'Held: possible_secret. Original remains local.':safe(`# ${title}\n\nRecorded report (agent assertion, not independent validation):\n${printable(event.outcome)}\n\n## Symptoms\n${printable(outcome.symptoms)}\n\n## Versions\n${printable(outcome.versions)}\n\n## Diagnosis / hypothesis\n${printable(outcome.diagnosis??outcome.hypothesis)}\n\n## Remedy\n${printable(outcome.remedy)}\n\n## Rejected attempts\n${printable(outcome.rejectedAttempts)}\n\n## Tests\n${receipts.length?'Executed command receipts are linked below. Test intent and causal coverage remain unvalidated.':'No executed test receipts available. Reported test claims remain unverified.'}\n\n## Changed commits (reported, not independently checked)\n${event.changedCommits.length?event.changedCommits.join('\n'):'Unknown (not recorded)'}\n\n## Provenance\nOrigin: ${event.instanceId}; task: ${event.taskId}; agent: ${event.agentId}; model: ${event.model.provider}/${event.model.modelId}.\n${sourcePaths.length?'Shared history available at capture:':'Shared history unavailable at capture; the recorded task report is embedded above. Later provenance notes may append.'}`);
   const sources=[...sourcePaths,...receipts];const content=doc({type:'Lesson',id:lessonId,title,description:'Tentative lesson from a recorded task report',claims:['reported-remedy'],applicability:{},evidenceState:'tentative',sourcePaths:sources,lorecrew:{learningEventId:held?revisionOf(event.id):event.id,originId:held?ctx.instanceId:event.instanceId,taskId:held?revisionOf(event.taskId):event.taskId}},`${body}\n\n${sources.map(p=>`- [Source](${relativeLink(path,p)})`).join('\n')}`);
   intent={event,path,lessonId,content};await ctx.store.transact(tx=>tx.insert('learning-capture',key,intent!));
  }
  await vault.propose({id:`capture:${key}`,path:intent.path,expectedRevision:null,actor:`process:learning:${ctx.instanceId}`,content:intent.content});
  await ctx.store.transact(tx=>{tx.put('learning-captured',key,{path:intent!.path,lessonId:intent!.lessonId});queueCuratorLesson(tx,parseConcept(intent!.path,intent!.content));});return {lessonId:intent.lessonId,path:intent.path};
 }
 async function recordEvidence(record:EvidenceRecord){
  if(!validEvidence(record))throw new AppError('INVALID_EVIDENCE','Evidence requires a revision, named claims/context, executor and timestamp');
  const path=`evidence/records/${component(ctx.instanceId)}/${revisionOf(record.id)}.md`;
  try{const existing=await vault.read(path);if(isDeepStrictEqual(object(existing.metadata.lorecrew).evidence,record))return;throw new AppError('LEARNING_CONFLICT','Evidence ID already names a different record');}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}
  validatePath(record.subjectId);const subject=await vault.read(record.subjectId);
  if(subjectHash(subject)!==record.subjectHash)throw new AppError('EVIDENCE_REVISION','Evidence must name the current substantive subject hash');
  const claims=strings(subject.metadata.claims);if(record.claimIds.some(id=>!claims.includes(id)))throw new AppError('EVIDENCE_CLAIMS','Evidence names an undeclared claim');
  const artifacts:Concept[]=[];for(const path of record.artifactPaths){validatePath(path);artifacts.push(await vault.read(path));}
  if(record.kind!=='review'){
   const receipts=artifacts.map(executionOf);if(!receipts.length||receipts.some(r=>!r||!boundTo(r,record.subjectId,record.subjectHash))||record.outcome!==(receipts.some(r=>r!.exitCode!==0)?'fail':'pass'))throw new AppError('EVIDENCE_RECEIPT','Machine evidence must agree with shared executed-command receipts');
  }
  if(redact(JSON.stringify(record),{}).held)throw new AppError('EVIDENCE_HELD','Evidence contains possible secrets');
  const verified=record.kind!=='review'&&record.outcome==='pass'?{subjectHash:record.subjectHash,claimIds:record.claimIds,context:record.context,at:record.at,executor:record.executor}:undefined;
  await vault.propose({id:`evidence:${ctx.instanceId}:${record.id}`,path,expectedRevision:null,actor:`process:learning:${ctx.instanceId}`,content:doc({type:'Evidence',title:`${record.kind}: ${record.outcome}`,sourcePaths:[record.subjectId,...record.artifactPaths],...(verified?{verified}:{}),lorecrew:{evidence:record,artifactHashes:Object.fromEntries(artifacts.map(c=>[c.path,c.revision]))}},`# ${record.kind}: ${record.outcome}\n\nSubject: [${record.subjectId}](${relativeLink(path,record.subjectId)})\nExact subject hash: ${record.subjectHash}\nClaims: ${record.claimIds.join(', ')}\nContext: ${JSON.stringify(record.context)}\nExecutor: ${record.executor}\nAt: ${record.at}\n\nAdaptation / rationale: ${record.rationale??'Unknown (not recorded)'}\n\nOnly the named claims and context are covered.\n\n${record.artifactPaths.map(p=>`- [Executed check](${relativeLink(path,p)})`).join('\n')}`)});
 }
 async function contributeEvidence(input:EvidenceInput){
  const id=revisionOf(canonical([ctx.instanceId,input.sessionId,input.id]));
  const prior=await ctx.store.read<{input:EvidenceInput;record:EvidenceRecord}>('learning-evidence-intent',id);
  if(prior){if(!isDeepStrictEqual(prior.input,input))throw new AppError('LEARNING_CONFLICT','Evidence request has different arguments');await recordEvidence(prior.record);return;}
  const receipts:ExecutionReceipt[]=[];for(const receiptId of input.receiptIds){const receipt=await ctx.store.read<ExecutionReceipt>('learning-execution',receiptId);if(!receipt||receipt.sessionId!==input.sessionId||input.kind!=='review'&&!boundTo(receipt,input.subjectId,input.subjectHash))throw new AppError('EVIDENCE_RECEIPT','Receipt must belong to the executing session');receipts.push(receipt);}
  if(input.kind!=='review'&&!receipts.length)throw new AppError('EVIDENCE_RECEIPT','Tests and reuse require actual execution receipts');
  const paths:string[]=[];for(const receipt of receipts)paths.push(await publishReceipt(receipt));
  const record:EvidenceRecord={id,subjectId:input.subjectId,subjectHash:input.subjectHash,claimIds:input.claimIds,context:input.context,kind:input.kind,outcome:input.kind==='review'?'unknown':receipts.some(r=>r.exitCode!==0)?'fail':'pass',executor:`${ctx.instanceId}:${input.sessionId}`,at:new Date(ctx.clock.now()).toISOString(),artifactPaths:paths,...(input.rationale!==undefined?{rationale:input.rationale}:{})};
  await ctx.store.transact(tx=>tx.insert('learning-evidence-intent',id,{input,record}));await recordEvidence(record);
 }
 async function initializeSourceIndex(){
  if(await ctx.store.read('learning-source-index','v1'))return;
  // One-time upgrade for completions/receipts written before source tracking.
  // Producers may run while these snapshots are read; helpers merge into the
  // latest transactional generation rather than replacing concurrent arrivals.
  const [completions,receipts,exports]=await Promise.all([ctx.store.list<CompletionLearning>('learning-completion'),ctx.store.list<ExecutionReceipt>('learning-execution'),ctx.store.list<ExportReceipt>('export-file')]);
  await ctx.store.transact(tx=>{
   if(tx.get('learning-source-index','v1'))return;
   for(const receipt of receipts)recordLearningSource(tx,receipt.sessionId,{receiptId:receipt.id});
   for(const exported of exports){const parts=exported.path.split('/');if(parts.length===4&&parts[0]==='history'&&parts[1]===component(ctx.instanceId)&&parts[3]!=='index.md')recordLearningSource(tx,decodeURIComponent(parts[2]!),{historyPath:exported.path});}
   for(const item of completions){tx.put('learning-session',item.sessionId,{taskId:item.event.taskId});tx.put<DirtyLearning>('learning-dirty',item.sessionId,{sessionId:item.sessionId,taskId:item.event.taskId,generation:tx.get<LearningSources>('learning-sources',item.sessionId)?.generation??0});}
   tx.put('learning-source-index','v1',{initialized:true});
  });
 }
 async function drain(){
  await initializeSourceIndex();
  for(const pending of await ctx.store.list<DirtyLearning>('learning-dirty')){
   const item=await ctx.store.read<CompletionLearning>('learning-completion',pending.taskId);if(!item)continue;
   const current=await ctx.store.read<LearningSources>('learning-sources',item.sessionId)??emptySources();
   const previous=await ctx.store.read<DrainedLearning>('learning-drained',item.event.id);
   try{
    const captured=await captureLesson(item.event);
    const sources=await knownPaths(previous?.sourcePaths??[]);
    for(const id of current.receiptIds.filter(id=>!previous?.receiptIds?.includes(id))){const receipt=await ctx.store.read<ExecutionReceipt>('learning-execution',id);if(!receipt)continue;try{sources.push(await publishReceipt(receipt));}catch(error){if(!(error instanceof AppError)||!['EVIDENCE_HELD','EVIDENCE_UNAVAILABLE'].includes(error.code))throw error;}}
    for(const path of current.historyPaths.filter(path=>!previous?.historyPaths?.includes(path))){const receipt=await ctx.store.read<ExportReceipt>('export-file',path);if(!receipt)continue;try{const c=await vault.read(receipt.path);if(c.revision===receipt.hash)sources.push(receipt.path);}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;}}
    if(sources.length){const key=revisionOf(canonical([item.event.id,sources.sort()]));const path=`evidence/provenance/${key}.md`;await vault.propose({id:`learning-provenance:${key}`,path,expectedRevision:null,actor:`process:learning:${ctx.instanceId}`,content:doc({type:'LearningProvenance',title:'Task evidence received',sourcePaths:sources,lorecrew:{subjectId:captured.path,eventId:item.event.id}},`# Later task provenance\n\n[Captured lesson](${relativeLink(path,captured.path)})\nOrigin: ${item.event.instanceId}; task: ${item.event.taskId}.\nExecution receipts do not by themselves validate lesson claims.\n\n${sources.map(p=>`- [Source](${relativeLink(path,p)})`).join('\n')}`)});}
    await ctx.store.transact(tx=>{
     if(tx.get('learning-error',item.event.id))tx.delete('learning-error',item.event.id);
     if(tx.get<DrainedLearning>('learning-drained',item.event.id)?.generation!==current.generation)tx.put<DrainedLearning>('learning-drained',item.event.id,{...current,path:captured.path,sourcePaths:sources,at:new Date(ctx.clock.now()).toISOString()});
     // An arrival racing publication retains a newer dirty generation for the next pass.
     if(tx.get<DirtyLearning>('learning-dirty',item.sessionId)?.generation===current.generation)tx.delete('learning-dirty',item.sessionId);
    });
   }catch(error){const code=error instanceof AppError?error.code:'CAPTURE_FAILED';if((await ctx.store.read<{error:string}>('learning-error',item.event.id))?.error!==code)await ctx.store.transact(tx=>tx.put('learning-error',item.event.id,{eventId:item.event.id,error:code,at:new Date(ctx.clock.now()).toISOString()}));}
  }
 }
 return {captureLesson:event=>serial(()=>captureLesson(event)),recordEvidence:record=>serial(()=>recordEvidence(record)),contributeEvidence:input=>serial(()=>contributeEvidence(input)),drain:()=>serial(drain),close:async()=>{await queues.get(ctx);}};
}
