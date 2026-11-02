import type { Json } from '../contracts/base.js';
import type { Concept } from '../vault/types.js';
import type { EvidenceRecord, ExecutionReceipt } from './types.js';
import { canonical, subjectHash } from './hash.js';
export const object=(value:unknown):Record<string,Json>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,Json>:{};
export const strings=(value:unknown):string[]=>Array.isArray(value)?value.filter((v):v is string=>typeof v==='string'):[];
export function validEvidence(value:unknown):value is EvidenceRecord {
 const v=object(value);return ['id','subjectId','executor'].every(k=>typeof v[k]==='string'&&String(v[k]).trim().length>0)&&typeof v.subjectHash==='string'&&/^[a-f0-9]{64}$/.test(v.subjectHash)&&Array.isArray(v.claimIds)&&v.claimIds.length>0&&strings(v.claimIds).length===v.claimIds.length&&Array.isArray(v.artifactPaths)&&strings(v.artifactPaths).length===v.artifactPaths.length&&typeof v.at==='string'&&Number.isFinite(Date.parse(v.at))&&['test','reuse','review'].includes(String(v.kind))&&['pass','fail','unknown'].includes(String(v.outcome))&&v.context!==undefined;
}
export function executionOf(concept:Concept|undefined):ExecutionReceipt|undefined {
 if(concept?.metadata.type!=='ExecutionReceipt')return;
 const v=object(object(concept.metadata.lorecrew).execution);
 if(['id','sessionId','command','output','at'].every(k=>typeof v[k]==='string')&&Number.isInteger(v.exitCode)&&Number.isFinite(Date.parse(String(v.at)))&&typeof v.localArtifact==='boolean')return v as unknown as ExecutionReceipt;
}
export function boundTo(receipt:ExecutionReceipt,subjectId:string,hash:string):boolean {
 return Array.isArray(receipt.subjects)&&receipt.subjects.some(s=>s?.path===subjectId&&s.subjectHash===hash&&typeof s.revision==='string'&&/^[a-f0-9]{64}$/.test(s.revision));
}
export function relevantEvidence(concept:Concept,evidence:EvidenceRecord[]):EvidenceRecord[] {
 const claims=strings(concept.metadata.claims);return evidence.filter(r=>validEvidence(r)&&r.subjectId===concept.path&&r.subjectHash===subjectHash(concept)&&r.claimIds.every(id=>claims.includes(id))&&canonical(r.context)===canonical(concept.metadata.applicability??{}));
}
export function deriveEvidenceState(concept:Concept,evidence:EvidenceRecord[]):'tentative'|'validated'|'contested' {
 const relevant=relevantEvidence(concept,evidence).filter(r=>r.kind!=='review');
 if(relevant.some(r=>r.outcome==='fail'))return 'contested';
 const claims=strings(concept.metadata.claims);const passed=new Set(relevant.filter(r=>r.outcome==='pass').flatMap(r=>r.claimIds));
 return claims.length>0&&claims.every(id=>passed.has(id))?'validated':'tentative';
}
/** Shared bytes are sufficient: no operational database and no unchecked trust metadata. */
export function vaultEvidence(concepts:Concept[]):Array<{path:string;record:EvidenceRecord}> {
 const files=new Map(concepts.map(c=>[c.path,c]));return concepts.flatMap(c=>{
  if(c.metadata.type!=='Evidence')return [];
  const lore=object(c.metadata.lorecrew);const r=lore.evidence;if(!validEvidence(r))return [];
  const hashes=object(lore.artifactHashes);
  if(r.artifactPaths.some(path=>!files.has(path)||hashes[path]!==files.get(path)!.revision))return [];
  if(r.kind!=='review') {
   const receipts=r.artifactPaths.map(path=>executionOf(files.get(path)));
   if(!receipts.length||receipts.some(x=>!x||!boundTo(x,r.subjectId,r.subjectHash)))return [];
   const outcome=receipts.some(x=>x!.exitCode!==0)?'fail':'pass';if(outcome!==r.outcome)return [];
  }
  return [{path:c.path,record:r}];
 });
}
