import { randomUUID } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { PublicationBatch } from '../export/types.js';
import { agentDefinition, groupDefinition } from '../agents/resolve.js';
import { assertUniqueIds, containsCredentials, scanVault } from '../vault/indexes.js';
import { parseConcept } from '../vault/parse.js';
import { orderedVault } from '../vault/write.js';
import { assertManagedPath, contentHash, finishReplacement, liveBytes, observeRevision, recoverPendingReplacements, type Replacement } from './recovery.js';
export function validateLiveContent(path:string,content:string){assertManagedPath(path);const concept=parseConcept(path,content);if(/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(content))throw new AppError('SYNC_MARKERS','Unresolved merge markers cannot enter the live vault',{path});if(containsCredentials(concept.metadata.lorecrew))throw new AppError('CREDENTIAL_VALUE','Portable configuration contains credentials',{path});if(concept.metadata.type==='Agent')agentDefinition(concept);if(concept.metadata.type==='Group')groupDefinition(concept);return concept;}
export type AcceptedFile=PublicationBatch['files'][number]&{observedBatchId?:string|null};
/** files carry the locally established preimage, never a freshly sampled dirty hash. */
export function applyAccepted({ctx,commit,files}: {ctx:InstanceContext;vault:Vault;commit:string;files:AcceptedFile[]}):Promise<{applied:string[];deferred:string[];recoveryIds:string[]}>{return orderedVault(ctx,async()=>{
 await recoverPendingReplacements(ctx);const paths=new Set<string>();
 for(const file of files){assertManagedPath(file.path);if(paths.has(file.path))throw new AppError('SYNC_PATH','Repeated application path');paths.add(file.path);if(file.content!==null)validateLiveContent(file.path,file.content);}
 const result:{applied:string[];deferred:string[];recoveryIds:string[]}={applied:[],deferred:[],recoveryIds:[]};
 for(const file of files){
  const current=await liveBytes(ctx,file.path);const currentHash=contentHash(current);const desired=contentHash(file.content);
  const lineage=await ctx.store.read<{batchId:string}>('sync-lineage',file.path);
  const changedLineage=file.observedBatchId!==undefined&&(lineage?.batchId??null)!==file.observedBatchId;
  if(currentHash!==desired&&(changedLineage||currentHash!==file.baseHash)){const observed=await observeRevision(ctx,file.path,current,currentHash);result.recoveryIds.push(observed.id);result.deferred.push(file.path);await ctx.store.transact(tx=>tx.put('sync-apply-diagnostic',file.path,{path:file.path,code:'LIVE_DIRTY',commit,recoveryId:observed.id}));continue;}
  if(file.content!==null){try{assertUniqueIds([...(await scanVault(ctx.vaultDir)).concepts.filter(c=>c.path!==file.path),validateLiveContent(file.path,file.content)]);}catch(error){if(!(error instanceof AppError)||error.code!=='DUPLICATE_ID')throw error;result.deferred.push(file.path);await ctx.store.transact(tx=>tx.put('sync-apply-diagnostic',file.path,{path:file.path,code:error.code,commit}));continue;}}
  const observed=await observeRevision(ctx,file.path,current,desired);result.recoveryIds.push(observed.id);
  const record:Replacement={id:randomUUID(),path:file.path,beforeHash:currentHash,content:file.content,commit,recoveryId:observed.id,actor:'sync:accepted',state:'pending'};
  await ctx.store.transact(tx=>tx.insert('sync-replacements',record.id,record));const state=await finishReplacement(ctx,record);result[state==='applied'?'applied':'deferred'].push(file.path);
 }
 return result;
 });}
