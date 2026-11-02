import type { Context } from 'hono';
import type { Static } from 'typebox';
import { posix } from 'node:path';
import { AppError } from '../contracts/base.js';
import { revisionOf, validatePath } from '../vault/parse.js';
import type { Concept } from '../vault/types.js';
import type { SessionRecord } from '../runtime/types.js';
import { mapping, pageCursor, pageOffset, searchTerms, stringList } from '../knowledge/index.js';
import { subjectHash } from '../learning/hash.js';
import { deriveEvidenceState, relevantEvidence, vaultEvidence, object, strings, executionOf } from '../learning/evidence.js';
import { skillDefinition, skillEvidenceState, skillHistory } from '../skills/catalog.js';
import type { SkillPin } from '../skills/types.js';
import type { ProposalRecord } from '../skills/proposals.js';
import { validatesEvaluation, type EvaluationRecord } from '../skills/validate.js';
import type { CuratorWork } from '../learning/curator.js';
import type { ApiOptions, Principal, Route } from './routes.js';
import * as S from './schemas.js';

function page<T>(items:T[],cursor:string|undefined,limitText:string|undefined,generation:string,query:string):{items:T[];nextCursor?:string}{
 const limit=limitText===undefined?20:Number(limitText);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AppError('INVALID_LIMIT','Page size must be from 1 to 100');
 const offset=pageOffset(cursor,generation,JSON.stringify([query,limit]));
 return {items:items.slice(offset,offset+limit),...(offset+limit<items.length?{nextCursor:pageCursor(generation,JSON.stringify([query,limit]),offset+limit)}:{})};
}
function generation(concepts:Concept[]):string{return revisionOf(JSON.stringify(concepts.map(c=>[c.path,c.revision]).sort((a,b)=>a[0]!.localeCompare(b[0]!))));}
function source(path:string,available:Set<string>,localOnly=false){return {path,available:available.has(path),...(localOnly?{localOnly:true}:{})};}
function sources(paths:string[],available:Set<string>){return [...new Set(paths)].filter(path=>{try{validatePath(path);return true;}catch{return false;}}).map(path=>source(path,available));}
function query(c:Context,name:string){return c.req.query(name);}
function trustedEvaluation(proposal:ProposalRecord,record:EvaluationRecord,concepts:Concept[]):boolean {try{return validatesEvaluation(proposal,record,concepts);}catch{return false;}}
function skillItems(concepts:Concept[]):Array<Static<typeof S.SkillItemSchema>>{
 const available=new Set(concepts.map(item=>item.path));const items:Array<Static<typeof S.SkillItemSchema>>=[];
 for(const concept of concepts){const d=skillDefinition(concept);if(d){items.push({qualifiedId:d.qualifiedId,path:concept.path,description:d.description,scope:d.skill.scope,status:d.skill.status,revision:concept.revision,evidenceState:skillEvidenceState(concept,concepts),resources:sources(d.skill.resources,available)});continue;}
  if(concept.metadata.type==='SkillHistory'){const lore=object(concept.metadata.lorecrew),snapshot=object(lore.snapshot),original=object(snapshot.concept);if(typeof lore.qualifiedId==='string'&&typeof original.revision==='string')try{if(skillHistory([concept],lore.qualifiedId,original.revision))items.push({qualifiedId:lore.qualifiedId,path:concept.path,description:'Retained prior revision',scope:String(lore.qualifiedId).split('/')[0]!,status:'history',revision:original.revision,evidenceState:'tentative',resources:[]});}catch{/* An altered archive cannot be offered as a rollback target. */}}}
 for(const item of items){if(item.status!=='candidate')continue;const newer=concepts.filter(c=>{const source=object(object(object(object(c.metadata.lorecrew).skill).management).source);return c.path!==item.path&&source.path===item.path&&source.revision===item.revision;}).map(c=>c.path);if(newer.length)item.supersededBy=newer;}
 return items;
}

export function knowledgeRoutes(options:ApiOptions,principal:(c:Context)=>Principal):Route[]{
 const {ctx,runtime}=options;
 const pageQuery=[{name:'q',schema:S.Type.String()},{name:'cursor',schema:S.Type.String()},{name:'limit',schema:S.Type.String({pattern:'^(?:[1-9]|[1-9][0-9]|100)$'})}];
 return [
  {method:'GET',path:'/knowledge/search',response:S.KnowledgeSearchSchema,query:[...pageQuery,{name:'framework',schema:S.Type.String()},{name:'version',schema:S.Type.String()}],async handle(c){
   return runtime.knowledge.search({query:query(c,'q')??'',...(query(c,'framework')?{framework:query(c,'framework')!}:{}),...(query(c,'version')?{version:query(c,'version')!}:{}),...(query(c,'cursor')?{cursor:query(c,'cursor')!}:{}),...(query(c,'limit')?{limit:Number(query(c,'limit'))}:{})});
  }},
  {method:'GET',path:'/knowledge/document',response:S.KnowledgeDocumentSchema,query:[{name:'path',schema:S.Type.String(),required:true}],async handle(c){
   const path=query(c,'path')??'';validatePath(path);
   const concepts=await runtime.knowledge.snapshot(),concept=concepts.find(item=>item.path===path);if(!concept)throw new AppError('NOT_FOUND','Knowledge document not found');
   const available=new Set(concepts.map(item=>item.path));const valid=vaultEvidence(concepts);const all=valid.filter(item=>item.record.subjectId===path);
   const relevant=relevantEvidence(concept,all.map(item=>item.record));
   const evidence=all.map(item=>({path:item.path,kind:item.record.kind,outcome:item.record.outcome,claimIds:item.record.claimIds,context:item.record.context,at:item.record.at,...(item.record.rationale?{rationale:item.record.rationale}:{}),artifacts:item.record.artifactPaths.map(path=>source(path,available,!!executionOf(concepts.find(c=>c.path===path))?.localArtifact)),appliesToCurrent:relevant.includes(item.record)}));
   const linked=concepts.filter(item=>item.metadata.type==='LearningProvenance'&&object(item.metadata.lorecrew).subjectId===path).map(item=>item.path);
   const paths=[...stringList(concept.metadata.sourcePaths),...all.map(item=>item.path),...linked];
   const state=concept.metadata.evidenceState==='contested'?'contested':deriveEvidenceState(concept,relevant);
   return {path,revision:concept.revision,title:typeof concept.metadata.title==='string'?concept.metadata.title:path,type:String(concept.metadata.type??'Document'),body:concept.body,evidenceState:state,applicability:mapping(concept.metadata.applicability),claims:strings(concept.metadata.claims),subjectHash:subjectHash(concept),sources:sources(paths,available),evidence};
  }},
  {method:'GET',path:'/skills',response:S.SkillPageSchema,query:pageQuery,async handle(c){
   const concepts=await runtime.knowledge.snapshot(),terms=searchTerms(query(c,'q')??'');
   const filtered=skillItems(concepts).filter(item=>terms.every(term=>`${item.qualifiedId} ${item.description}`.toLowerCase().includes(term))).sort((a,b)=>a.qualifiedId.localeCompare(b.qualifiedId)||a.status.localeCompare(b.status)||a.path.localeCompare(b.path));
   return page(filtered,query(c,'cursor'),query(c,'limit'),generation(concepts),query(c,'q')??'');
  }},
  {method:'GET',path:'/skills/inspection',response:S.SkillInspectionSchema,query:[{name:'qualifiedId',schema:S.Type.String(),required:true},{name:'sessionId',schema:S.Type.String()},{name:'candidatePath',schema:S.Type.String()},{name:'historyCursor',schema:S.Type.String()},{name:'historyLimit',schema:S.Type.String({pattern:'^(?:[1-9]|[1-9][0-9]|100)$'})}],async handle(c){
   const qualifiedId=query(c,'qualifiedId')??'',sessionId=query(c,'sessionId'),candidatePath=query(c,'candidatePath');if(!qualifiedId.trim())throw new AppError('INVALID_SKILL','Qualified skill ID is required');
   const concepts=await runtime.knowledge.snapshot();const matching=skillItems(concepts).filter(item=>item.qualifiedId===qualifiedId),items=matching.filter(item=>item.status!=='history').sort((a,b)=>a.status.localeCompare(b.status)||a.path.localeCompare(b.path));
   const historyPage=page(matching.filter(item=>item.status==='history').sort((a,b)=>a.path.localeCompare(b.path)),query(c,'historyCursor'),query(c,'historyLimit'),generation(concepts),`history:${qualifiedId}`);
   let pin:Static<typeof S.SkillInspectionSchema>['pin'];if(sessionId){const record=await ctx.store.read<SessionRecord>('runtime-session',sessionId);if(!record)throw new AppError('SESSION_NOT_FOUND','Local session not found');const taskId=record.input.teamTaskId??record.session.id;const stored=await ctx.store.read<SkillPin>('skill-pin',revisionOf(JSON.stringify([sessionId,taskId,qualifiedId])));if(stored)pin={sessionId,taskId,qualifiedId,path:stored.path,status:stored.status,revision:stored.loaded.revision};}
   let activation:Static<typeof S.SkillInspectionSchema>['activation'];if(candidatePath){validatePath(candidatePath);const candidate=items.find(item=>item.path===candidatePath&&item.status==='candidate');if(candidate){const proposal=concepts.filter(item=>item.metadata.type==='SkillProposal').map(item=>object(item.metadata.lorecrew)).find(lore=>{const request=object(lore.proposal),snapshot=object(object(lore.candidate).concept);return request.qualifiedId===qualifiedId&&request.candidatePath===candidatePath&&snapshot.revision===candidate.revision;});const request=object(proposal?.proposal);if(typeof request.id==='string'&&(typeof request.baseRevision==='string'||request.baseRevision===null))activation={proposalId:request.id,baseRevision:request.baseRevision};}}
   return {items,history:historyPage.items,...(historyPage.nextCursor?{historyNextCursor:historyPage.nextCursor}:{}),...(pin?{pin}:{}),...(activation?{activation}:{})};
  }},
  {method:'POST',path:'/skills/load',body:S.SkillLoadInputSchema,response:S.LoadedSkillSchema,idempotent:true,async handle(_c,body,requestId){
   const input=body as Static<typeof S.SkillLoadInputSchema>;
   const record=await ctx.store.read<SessionRecord>('runtime-session',input.sessionId);if(!record)throw new AppError('SESSION_NOT_FOUND','Local session not found');
   const receipt=await ctx.store.read('skill-load',revisionOf(JSON.stringify([input.sessionId,requestId])));
   if(record.cancelled&&!receipt)throw new AppError('SESSION_CANCELLED','Session has been cancelled');
   return runtime.skills.loadSkill({...input,taskId:record.input.teamTaskId??record.session.id,requestId});
  }},
  {method:'POST',path:'/skills/activate',body:S.SkillActivateInputSchema,response:S.RevisionSchema,idempotent:true,browserOnly:true,async handle(c,body){
   const input=body as Static<typeof S.SkillActivateInputSchema>;
   return runtime.skills.activateUnvalidated({proposalId:input.proposalId,expectedActiveRevision:input.expectedActiveRevision,userId:principal(c).id});
  }},
  {method:'POST',path:'/skills/rollback',body:S.SkillRollbackInputSchema,response:S.OkSchema,idempotent:true,browserOnly:true,async handle(c,body){
   const input=body as Static<typeof S.SkillRollbackInputSchema>;
   await runtime.skills.rollbackSkill({...input,userId:principal(c).id});return {ok:true};
  }},
  {method:'GET',path:'/learning/lessons',response:S.LearningPageSchema,query:pageQuery,async handle(c){
   const concepts=await runtime.knowledge.snapshot(),available=new Set(concepts.map(item=>item.path)),evidence=vaultEvidence(concepts),terms=searchTerms(query(c,'q')??'');
   const items=concepts.map(item=>({item,state:item.metadata.evidenceState==='contested'?'contested':deriveEvidenceState(item,evidence.filter(e=>e.record.subjectId===item.path).map(e=>e.record))})).filter(({item,state})=>item.metadata.type==='Lesson'||state==='contested').map(({item,state})=>({path:item.path,revision:item.revision,type:String(item.metadata.type),title:typeof item.metadata.title==='string'?item.metadata.title:item.path,state,sourcePaths:sources([...new Set([...stringList(item.metadata.sourcePaths),...evidence.filter(e=>e.record.subjectId===item.path).map(e=>e.path)])],available),details:{}})).filter(item=>terms.every(term=>`${item.title} ${item.path} ${item.state}`.toLowerCase().includes(term))).sort((a,b)=>a.path.localeCompare(b.path));
   return page(items,query(c,'cursor'),query(c,'limit'),generation(concepts),query(c,'q')??'');
  }},
  {method:'GET',path:'/learning/proposals',response:S.LearningPageSchema,query:pageQuery,async handle(c){
   const concepts=await runtime.knowledge.snapshot(),available=new Set(concepts.map(item=>item.path)),terms=searchTerms(query(c,'q')??'');
   const activeIds=new Set(concepts.filter(item=>item.metadata.type==='Skill'&&object(object(object(item.metadata.lorecrew).skill).activation).proposalId).map(item=>String(object(object(object(item.metadata.lorecrew).skill).activation).proposalId)));
   const evaluations=new Map(concepts.filter(item=>item.metadata.type==='SkillEvaluation').map(item=>{const ev=object(object(item.metadata.lorecrew).evaluation);return [String(ev.proposalId),item] as const;}));
   const items=concepts.filter(item=>['SkillProposal','LearningProposal'].includes(String(item.metadata.type))||skillDefinition(item)?.skill.status==='candidate').map(item=>{
    const lore=object(item.metadata.lorecrew);const proposal=object(lore.proposal);const id=typeof proposal.id==='string'?proposal.id:posix.basename(item.path,'.md');const evaluation=evaluations.get(id);
    const trusted=item.metadata.type==='SkillProposal'&&evaluation?trustedEvaluation(lore as unknown as ProposalRecord,evaluation.metadata.lorecrew as unknown as EvaluationRecord,concepts):false;
    const result=evaluation?object(object(evaluation.metadata.lorecrew).evaluation):undefined;
    const state=activeIds.has(id)?'activated':evaluation?trusted?(result?.eligible===true?'eligible':'rejected'):'unverified evaluation':item.metadata.type==='LearningProposal'?'unresolved':'pending';
    return {path:item.path,revision:item.revision,type:String(item.metadata.type),title:typeof item.metadata.title==='string'?item.metadata.title:item.path,state,sourcePaths:sources([...stringList(item.metadata.sourcePaths),...stringList(proposal.lessonPaths)],available),details:{...lore,...(result?{evaluation:result}:{})}};
   }).filter(item=>terms.every(term=>`${item.title} ${item.path} ${item.state}`.toLowerCase().includes(term))).sort((a,b)=>a.path.localeCompare(b.path));
   return page(items,query(c,'cursor'),query(c,'limit'),generation(concepts),query(c,'q')??'');
  }},
  {method:'GET',path:'/learning/reviews',response:S.LearningReviewsSchema,query:pageQuery,async handle(c){
   const concepts=await runtime.knowledge.snapshot(),available=new Set(concepts.map(item=>item.path)),terms=searchTerms(query(c,'q')??'');const trustedEvidence=new Set(vaultEvidence(concepts).map(item=>item.path));
   const items=concepts.filter(item=>['Evidence','SkillEvaluation','SkillCheck','LearningProvenance'].includes(String(item.metadata.type))).map(item=>{
    const lore=object(item.metadata.lorecrew),ev=object(lore.evidence),evaluation=object(lore.evaluation);
    const related=concepts.find(c=>c.metadata.type==='SkillProposal'&&object(object(c.metadata.lorecrew).proposal).id===evaluation.proposalId);
    const evaluationTrusted=related&&trustedEvaluation(related.metadata.lorecrew as unknown as ProposalRecord,lore as unknown as EvaluationRecord,concepts);
    const state=item.metadata.type==='Evidence'?(trustedEvidence.has(item.path)?String(ev.outcome):'unverified'):item.metadata.type==='SkillEvaluation'?(evaluationTrusted?(evaluation.eligible?'eligible':'rejected'):'unverified'):'recorded';
    return {path:item.path,revision:item.revision,type:String(item.metadata.type),title:typeof item.metadata.title==='string'?item.metadata.title:item.path,state,sourcePaths:sources([...stringList(item.metadata.sourcePaths),...strings(ev.artifactPaths),...strings(evaluation.evidencePaths)],available),details:lore};
   }).filter(item=>terms.every(term=>`${item.title} ${item.path} ${item.state}`.toLowerCase().includes(term))).sort((a,b)=>a.path.localeCompare(b.path));
   const result=page(items,query(c,'cursor'),query(c,'limit'),generation(concepts),query(c,'q')??'');
   const curator=await runtime.curator.status();const work=(await ctx.store.list<CuratorWork>('curator-work')).map(item=>({id:item.id,state:item.state,sourcePaths:item.sourcePaths,...(item.sessionId?{sessionId:item.sessionId}:{}),...(item.generation?{generation:item.generation}:{})}));
   const errors=await ctx.store.list('learning-error');const usage=await Promise.all(work.filter(item=>item.sessionId).map(async item=>{try{return {workId:item.id,sessionId:item.sessionId,usage:(await runtime.snapshot(item.sessionId!)).usage};}catch{return {workId:item.id,sessionId:item.sessionId,unavailable:true};}}));
   return {...result,curator:{...curator,work,errors,usage}};
  }},
 ];
}
