import { assertImportedResources } from './import/resources.js';
import { canonical } from '../learning/hash.js';
import { AppError, type Json } from '../contracts/base.js';
import { agentDefinition } from '../agents/resolve.js';
import { stableId } from '../vault/indexes.js';
import { validatePath, revisionOf, parseConcept } from '../vault/parse.js';
import type { Concept, Vault } from '../vault/types.js';
import { mapping, pageCursor, pageOffset, searchTerms, stringList } from '../knowledge/index.js';
import type { SkillDefinition, SkillMetadata, SkillPage } from './types.js';
export function skillDefinition(concept:Concept):SkillDefinition|undefined {
 if(concept.metadata.type!=='Skill')return;
 const m=mapping(mapping(concept.metadata.lorecrew).skill);const scope=m.scope;
 if(m.schemaVersion!==1||typeof m.name!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.name)||!['global','agent','group'].includes(String(scope))||!['active','candidate','deprecated'].includes(String(m.status))||typeof concept.metadata.description!=='string'||!concept.metadata.description.trim())return;
 if(scope!=='global'&&(typeof m.scopeId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(m.scopeId)))return;
 if(m.resources!==undefined&&(!Array.isArray(m.resources)||m.resources.some(p=>typeof p!=='string')))return;
 const resources=stringList(m.resources);try{for(const path of resources)validatePath(path);}catch{return;}
 const skill:SkillMetadata={schemaVersion:1,name:m.name,scope:scope as SkillMetadata['scope'],status:m.status as SkillMetadata['status'],resources,...(scope!=='global'?{scopeId:m.scopeId as string}:{})};
 return {qualifiedId:`${scope}${scope==='global'?'':`:${skill.scopeId}`}/${skill.name}`,description:concept.metadata.description,skill,concept};
}
export class SkillCatalog {
 constructor(private readonly vault:Vault,private readonly snapshot:()=>Promise<Concept[]>=()=>vault.list()){}
 async list(input:{agentId:string;query?:string;cursor?:string;limit?:number;groups?:string[]}):Promise<SkillPage>{
  const concepts=await this.snapshot();const source=concepts.find(c=>c.metadata.type==='Agent'&&stableId(c)===input.agentId);
  const groups=input.groups??(source?agentDefinition(source).groups:undefined);if(!groups)throw new AppError('NOT_FOUND','Agent definition not found');
  const terms=searchTerms(input.query??'');const limit=input.limit??50;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AppError('INVALID_LIMIT','Catalog page size must be from 1 to 100');
  const definitions=concepts.map(skillDefinition).filter((d):d is SkillDefinition=>!!d&&d.skill.status==='active'&&(d.skill.scope==='global'||d.skill.scope==='agent'&&d.skill.scopeId===input.agentId||d.skill.scope==='group'&&groups.includes(d.skill.scopeId!)));
  const seen=new Set<string>();for(const d of definitions){if(seen.has(d.qualifiedId))throw new AppError('AMBIGUOUS_SKILL','Multiple active definitions have the same qualified ID',{qualifiedId:d.qualifiedId});seen.add(d.qualifiedId);}
  const items=definitions.map(d=>({qualifiedId:d.qualifiedId,description:d.description,scope:d.skill.scope,revision:d.concept.revision,evidenceState:skillEvidenceState(d.concept,concepts)})).filter(d=>terms.every(t=>`${d.qualifiedId} ${d.description}`.toLowerCase().includes(t))).sort((a,b)=>a.qualifiedId.localeCompare(b.qualifiedId));
  const generation=revisionOf(JSON.stringify(concepts.map(c=>[c.path,c.revision]).sort()));const key=JSON.stringify([input.agentId,groups,terms,limit]);const offset=pageOffset(input.cursor,generation,key);
  return {items:items.slice(offset,offset+limit),...(offset+limit<items.length?{nextCursor:pageCursor(generation,key,offset+limit)}:{})};
 }
}

/** Lifecycle and bookkeeping do not make edited instructions inherit validation. */
export function skillContentHash(concept:Concept):string {
 const metadata={...concept.metadata};delete metadata.id;delete metadata.verified;delete metadata.evidenceState;
 const lore={...mapping(metadata.lorecrew)};const skill={...mapping(lore.skill)};delete skill.activation;delete skill.status;lore.skill=skill;metadata.lorecrew=lore;
 return revisionOf(canonical({metadata,body:concept.body}));
}
/** Include consumed resource bytes, not only revision strings that an editor could leave unchanged. */
export function skillSnapshotHash(revision:string,resources:Concept[]):string {
 return revisionOf(canonical({revision,resources:resources as unknown as Json}));
}
function validResourceSnapshots(value:unknown,paths:string[]):value is Concept[] {
 return Array.isArray(value)&&value.length===paths.length&&value.every((r,index)=>r&&typeof r==='object'&&!Array.isArray(r)&&r.path===paths[index]&&typeof r.revision==='string'&&/^[a-f0-9]{64}$/.test(r.revision)&&typeof r.body==='string'&&r.metadata&&typeof r.metadata==='object'&&!Array.isArray(r.metadata));
}
function resourceIntegrity():AppError{return new AppError('SKILL_RESOURCE_INTEGRITY','Retained resource bytes do not match their recorded snapshot');}
export function skillHistory(concepts:Concept[],qualifiedId:string,revision:string):import('./proposals.js').SkillSnapshot|undefined {
 for(const c of concepts){if(c.metadata.type!=='SkillHistory')continue;const h=mapping(c.metadata.lorecrew);if(h.qualifiedId!==qualifiedId)continue;const s=h.snapshot as unknown as import('./proposals.js').SkillSnapshot;
  if(s?.concept?.revision!==revision)continue;
  if(typeof s.raw!=='string'||revisionOf(s.raw)!==revision)throw resourceIntegrity();
  const parsed=parseConcept(s.concept.path,s.raw);const definition=skillDefinition(parsed);
  if(definition?.qualifiedId!==qualifiedId||canonical(parsed.metadata)!==canonical(s.concept.metadata)||parsed.body!==s.concept.body||!validResourceSnapshots(s.resources,definition.skill.resources)||h.snapshotHash!==skillSnapshotHash(revision,s.resources))throw resourceIntegrity();
  assertImportedResources(parsed,s.resources);return s;
 }
}
export function retainedSkillResources(concept:Concept,concepts:Concept[]):Concept[]|undefined {
 const definition=skillDefinition(concept);if(!definition)return;
 const activation=mapping(mapping(mapping(concept.metadata.lorecrew).skill).activation);
 if(Object.keys(activation).length){
  if(!validResourceSnapshots(activation.resources,definition.skill.resources)||typeof activation.candidateRevision!=='string'||activation.candidateHash!==skillSnapshotHash(activation.candidateRevision,activation.resources))throw resourceIntegrity();
  if(activation.mode==='validated'){
   const evidence=concepts.find(c=>c.path===activation.evaluationPath&&c.metadata.type==='SkillEvaluation');
   if(mapping(mapping(evidence?.metadata.lorecrew).evaluation).candidateHash!==activation.candidateHash)throw resourceIntegrity();
  }
  if(activation.contentHash===skillContentHash(concept))return activation.resources;
 }
 return skillHistory(concepts,definition.qualifiedId,concept.revision)?.resources;
}
export function skillEvidenceState(concept:Concept,concepts:Concept[]):'validated'|'tentative' {
 const activation=mapping(mapping(mapping(concept.metadata.lorecrew).skill).activation);
 try{retainedSkillResources(concept,concepts);}catch{return 'tentative';}
 if(activation.mode!=='validated'||activation.contentHash!==skillContentHash(concept))return 'tentative';
 const note=concepts.find(c=>c.path===activation.evaluationPath&&c.metadata.type==='SkillEvaluation');const saved=mapping(note?.metadata.lorecrew);const evaluation=mapping(saved.evaluation);const hashes=mapping(saved.artifactHashes);
 if(evaluation.eligible!==true||evaluation.candidateHash!==activation.candidateHash||!Object.keys(hashes).length||Object.entries(hashes).some(([path,hash])=>concepts.find(c=>c.path===path)?.revision!==hash))return 'tentative';
 return 'validated';
}
