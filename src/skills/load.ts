import { assertImportedResources,importedProvenance } from './import/resources.js';
import { exactImportedSnapshot,verifyImportSnapshot } from './import/reader.js';
import { skillSnapshot,type SkillSnapshot } from './proposals.js';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Concept, Vault } from '../vault/types.js';
import { revisionOf } from '../vault/parse.js';
import { coherentSnapshot } from '../knowledge/search.js';
import { skillDefinition, skillHistory, retainedSkillResources } from './catalog.js';
import type { LoadedSkill, LoadSkillRequest, SkillDefinition, SkillPin } from './types.js';
export function openSkillLoader({ctx,snapshot=()=>coherentSnapshot(ctx)}:{ctx:InstanceContext;vault:Vault;snapshot?:()=>Promise<Concept[]>}):{loadSkill(input:LoadSkillRequest):Promise<LoadedSkill>} {
 return {async loadSkill(input){
  if(!input.sessionId?.trim()||!input.taskId?.trim()||!input.qualifiedId?.trim())throw new AppError('INVALID_SKILL_LOAD','Skill loads require session, task and qualified ID');
  const id=revisionOf(JSON.stringify([input.sessionId,input.taskId,input.qualifiedId]));
  const request=JSON.stringify([input.sessionId,input.taskId,input.qualifiedId,input.revision??null,input.trial??false]);
  const requestKey=input.requestId?revisionOf(JSON.stringify([input.sessionId,input.requestId])):undefined;
  type Receipt={request:string;loaded:LoadedSkill};
  const prior=requestKey?await ctx.store.read<Receipt>('skill-load',requestKey):undefined;
  const check=(receipt:Receipt)=>{if(receipt.request!==request)throw new AppError('REQUEST_MISMATCH','Load request ID already names different arguments');return receipt.loaded;};
  if(prior){const version=await ctx.store.read<SkillPin>('skill-version',revisionOf(JSON.stringify([input.qualifiedId,prior.loaded.revision])));if(prior.loaded.resources.some(objectNative)&&(!version?.importSnapshot||importedProvenance(version.importSnapshot.concept))){const s=await exactImportedSnapshot(ctx,input.qualifiedId,prior.loaded.revision);assertImportedResources(s.concept,prior.loaded.resources);}return check(prior);}
  const finish=async(pin:SkillPin)=>{if(pin.loaded.resources.some(objectNative)){pin={...pin,importSnapshot:pin.importSnapshot??await exactImportedSnapshot(ctx,input.qualifiedId,pin.loaded.revision)};verifyImportSnapshot(pin.importSnapshot!,input.qualifiedId,pin.loaded.revision);assertImportedResources(pin.importSnapshot!.concept,pin.loaded.resources);}return ctx.store.transact(tx=>{
   const receipt=requestKey?tx.get<Receipt>('skill-load',requestKey):undefined;if(receipt)return check(receipt);
   const current=tx.get<SkillPin>('skill-pin',id);const chosen=current&&!input.revision?{...current,...!current.importSnapshot&&pin.importSnapshot?{importSnapshot:pin.importSnapshot}:{}}:pin;
   if(chosen.status==='candidate'&&!input.trial)throw new AppError('SKILL_TRIAL_REQUIRED','Candidate instructions require a deliberate trial');
   if(current?.loaded.revision!==chosen.loaded.revision){
    tx.put('skill-pin',id,chosen);tx.put('skill-version',revisionOf(JSON.stringify([input.qualifiedId,chosen.loaded.revision])),chosen);
    tx.emit(current?'skill.reloaded':'skill.loaded',{sessionId:input.sessionId,taskId:input.taskId,qualifiedId:input.qualifiedId,revision:chosen.loaded.revision,...(current?{previousRevision:current.loaded.revision}:{}),trial:input.trial??false});
   }
   if(chosen.importSnapshot&&!current?.importSnapshot){tx.put('skill-pin',id,chosen);tx.put('skill-version',revisionOf(JSON.stringify([input.qualifiedId,chosen.loaded.revision])),chosen);}
   if(requestKey)tx.insert('skill-load',requestKey,{request,loaded:chosen.loaded});return chosen.loaded;
  });};
  const old=await ctx.store.read<SkillPin>('skill-pin',id);
  if(old&&(!input.revision||input.revision===old.loaded.revision)){if(old.status==='candidate'&&!input.trial)throw new AppError('SKILL_TRIAL_REQUIRED','Candidate instructions require a deliberate trial');return finish(old);}
  const concepts=await snapshot();const definitions=concepts.map(skillDefinition).filter((d):d is SkillDefinition=>!!d&&d.qualifiedId===input.qualifiedId);
  const candidates=definitions.filter(d=>input.revision?d.concept.revision===input.revision:d.skill.status===(input.trial?'candidate':'active'));
  let definition=candidates[0];let loaded:LoadedSkill|undefined;
  // Only previously loaded revisions have a durable historical copy in control storage.
  const historical=input.revision?await ctx.store.read<SkillPin>('skill-version',revisionOf(JSON.stringify([input.qualifiedId,input.revision]))):undefined;
  if(candidates.length>1)throw new AppError('AMBIGUOUS_SKILL','Multiple definitions match this qualified ID and revision');
  if(!definition&&historical){definition={qualifiedId:input.qualifiedId,description:'',skill:{schemaVersion:1,name:'history',scope:'global',status:historical.status,resources:[]},concept:{path:historical.path,revision:historical.loaded.revision,body:historical.loaded.body,metadata:{}}};loaded=historical.loaded;}
  if(historical?.importSnapshot&&importedProvenance(historical.importSnapshot.concept)){const frozen=verifyImportSnapshot(historical.importSnapshot,input.qualifiedId,historical.loaded.revision);definition=skillDefinition(frozen.concept);loaded=historical.loaded;}
  const archive=input.revision?skillHistory(concepts,input.qualifiedId,input.revision):undefined;
  if(!definition&&archive){definition=skillDefinition(archive.concept);loaded={revision:archive.concept.revision,body:archive.concept.body,resources:archive.resources};}
  if(!definition){
   if(!input.trial&&definitions.some(d=>d.skill.status==='candidate')&&!definitions.some(d=>d.skill.status==='active'))throw new AppError('SKILL_TRIAL_REQUIRED','Candidate instructions require a deliberate trial');
   if(!input.revision&&definitions.some(d=>d.skill.status==='deprecated'))throw new AppError('SKILL_DEPRECATED','Deprecated skills require an explicit historical revision');
   throw new AppError(input.revision?'REVISION_CONFLICT':'NOT_FOUND','Skill revision is unavailable; search the catalog again');
  }
  if(definition.skill.status==='candidate'&&!input.trial)throw new AppError('SKILL_TRIAL_REQUIRED','Candidate instructions require a deliberate trial');
  loaded??={revision:definition.concept.revision,body:definition.concept.body,resources:retainedSkillResources(definition.concept,concepts)??definition.skill.resources.map(path=>{const resource=concepts.find(c=>c.path===path);if(!resource)throw new AppError('SKILL_RESOURCE_MISSING','Skill resource is unavailable',{path});return resource;})};
  let importSnapshot:SkillSnapshot|undefined;
  const hasNativeResources=loaded.resources.some(r=>objectNative(r));
  if(importedProvenance(definition.concept)||hasNativeResources){
   importSnapshot=historical?.importSnapshot??(archive&&importedProvenance(archive.concept)?archive:undefined);
   if(!importSnapshot){const snap=await skillSnapshot(ctx,input.qualifiedId,definition.concept.path);if(snap?.concept.revision===loaded.revision)importSnapshot=snap;}
   importSnapshot??=await exactImportedSnapshot(ctx,input.qualifiedId,loaded.revision);
   verifyImportSnapshot(importSnapshot,input.qualifiedId,loaded.revision);assertImportedResources(importSnapshot.concept,loaded.resources);
  }
  const pin:SkillPin={sessionId:input.sessionId,taskId:input.taskId,qualifiedId:input.qualifiedId,path:definition.concept.path,status:definition.skill.status,loaded,...importSnapshot?{importSnapshot}:{}};
  return finish(pin);
 }};
}

function objectNative(r:Concept){const lore=r.metadata.lorecrew;return lore&&typeof lore==='object'&&!Array.isArray(lore)&&!!lore.importedFile;}
