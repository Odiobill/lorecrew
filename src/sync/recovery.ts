import { queueCuratorLesson } from '../learning/curator.js';
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import { safePath } from '../vault/indexes.js';
import { parseConcept, revisionOf, validatePath } from '../vault/parse.js';
import { orderedVault } from '../vault/write.js';
export interface ObservedRevision {id:string;path:string;content:string|null;hash:string|null;restoreHash:string|null;at:string}
export interface Replacement {id:string;path:string;beforeHash:string|null;content:string|null;commit:string;recoveryId:string;actor:string;state:'pending'|'applied'|'deferred'}
export const contentHash=(content:string|null)=>content===null?null:revisionOf(content);
export function managedPath(path:string):boolean {return !path.split('/').some(part=>part.startsWith('.')||part==='node_modules')&&!/^(?:config|providers|control|pi|index)\.(?:json|sqlite)(?:\/|$)/.test(path);}
export function assertManagedPath(path:string):void {validatePath(path);if(!managedPath(path))throw new AppError('UNSAFE_PATH','Local state is not synchronized',{path});}
export async function liveBytes(ctx:InstanceContext,path:string):Promise<string|null>{assertManagedPath(path);try{const bytes=await readFile(await safePath(ctx.vaultDir,path));const content=bytes.toString('utf8');if(!Buffer.from(content).equals(bytes))throw new AppError('UNSUPPORTED_ENCODING','Unsupported non-UTF8 Markdown is retained locally');return content;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
export async function syncDirectory(path:string):Promise<void>{const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
/** Recovery bytes are durable before any replacement intent is committed. */
export async function observeRevision(ctx:InstanceContext,path:string,content:string|null,restoreHash:string|null):Promise<ObservedRevision>{
 const id=revisionOf(JSON.stringify([path,content,restoreHash]));const existing=await ctx.store.read<ObservedRevision>('sync-recovery',id);if(existing)return existing;
 const record:ObservedRevision={id,path,content,hash:contentHash(content),restoreHash,at:new Date(ctx.clock.now()).toISOString()};
 const directory=join(ctx.stateDir,'recovery');await mkdir(directory,{recursive:true,mode:0o700});
 // A partially written backup never earns a control-store receipt.
 const temp=join(directory,`${id}-${randomUUID()}.tmp`);const file=await open(temp,'wx',0o600);
 try{await file.writeFile(JSON.stringify(record));await file.sync();}finally{await file.close();}
 await rename(temp,join(directory,`${id}.json`));await syncDirectory(directory);
 await ctx.store.transact(tx=>tx.put('sync-recovery',id,record));return record;
}
export async function finishReplacement(ctx:InstanceContext,record:Replacement):Promise<Replacement['state']>{
 const desired=contentHash(record.content);let current=await liveBytes(ctx,record.path);
 const defer=async()=>{await observeRevision(ctx,record.path,current,contentHash(current));await ctx.store.transact(tx=>{tx.put('sync-replacements',record.id,{...record,state:'deferred'});tx.put('sync-apply-diagnostic',record.path,{path:record.path,code:'LIVE_CHANGED',recoveryId:record.recoveryId,commit:record.commit});tx.emit('sync.deferred',{path:record.path,recoveryId:record.recoveryId});});return 'deferred' as const;};
 if(contentHash(current)!==desired){
  if(contentHash(current)!==record.beforeHash)return defer();
  const target=await safePath(ctx.vaultDir,record.path);const parent=dirname(target);
  await mkdir(parent,{recursive:true});await safePath(ctx.vaultDir,record.path);
  for(let dir=parent;dir!==ctx.vaultDir;dir=dirname(dir))await syncDirectory(dirname(dir));
  const temp=join(parent,`.lorecrew-${randomUUID()}.tmp`);
  try{
   if(record.content!==null){const file=await open(temp,'wx',0o600);try{await file.writeFile(record.content);await file.sync();}finally{await file.close();}}
   // The external-editor check and rename cannot be atomic. Preserve everything
   // actually observed; never promise to recover an unobserved save in this gap.
   current=await liveBytes(ctx,record.path);if(contentHash(current)!==record.beforeHash)return defer();
   await safePath(ctx.vaultDir,record.path);
   if(record.content===null)await unlink(target);
   else if(record.beforeHash===null){try{await link(temp,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;current=await liveBytes(ctx,record.path);return defer();}}
   else await rename(temp,target);
   await syncDirectory(parent);
  }finally{await unlink(temp).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
 }else{const target=await safePath(ctx.vaultDir,record.path);let parent=dirname(target);for(;;){try{await syncDirectory(parent);break;}catch(error){if(record.content!==null||(error as NodeJS.ErrnoException).code!=='ENOENT'||parent===ctx.vaultDir)throw error;parent=dirname(parent);}}}
 await ctx.store.transact(tx=>{tx.put('sync-replacements',record.id,{...record,state:'applied'});tx.put('vault-writes',record.path,{path:record.path,hash:desired,actor:record.actor});tx.put('sync-live',record.path,{path:record.path,hash:desired,content:record.content,commit:record.commit});tx.delete('sync-apply-diagnostic',record.path);if(record.content!==null)queueCuratorLesson(tx,parseConcept(record.path,record.content));tx.emit('sync.applied',{path:record.path,commit:record.commit});});return 'applied';
}
export async function recoverPendingReplacements(ctx:InstanceContext):Promise<void>{
 for(const record of await ctx.store.list<Replacement>('sync-replacements'))if(record.state==='pending'){
  try{await finishReplacement(ctx,record);}catch(error){if(!(error instanceof AppError)||error.code!=='UNSAFE_PATH')throw error;await ctx.store.transact(tx=>{tx.put('sync-replacements',record.id,{...record,state:'deferred'});tx.put('sync-apply-diagnostic',record.path,{path:record.path,code:error.code,recoveryId:record.recoveryId,commit:record.commit});});}
 }
}
export const recoverReplacements=(ctx:InstanceContext)=>orderedVault(ctx,()=>recoverPendingReplacements(ctx));
export const listObservedRevisions=(ctx:InstanceContext)=>ctx.store.list<ObservedRevision>('sync-recovery');
export function restoreObservedRevision(ctx:InstanceContext,recoveryId:string,requestId?:string):Promise<void>{return orderedVault(ctx,async()=>{
 await recoverPendingReplacements(ctx);
 if(requestId){const existing=await ctx.store.read<Replacement>('sync-replacements',requestId);if(existing){if(existing.state==='applied')return;if(await finishReplacement(ctx,existing)==='deferred')throw new AppError('REVISION_CONFLICT','File changed before recovery');return;}}
 const revision=await ctx.store.read<ObservedRevision>('sync-recovery',recoveryId);if(!revision)throw new AppError('NOT_FOUND','Observed revision not found');
 const current=await liveBytes(ctx,revision.path);if(contentHash(current)!==revision.restoreHash)throw new AppError('REVISION_CONFLICT','File changed since the observed replacement; preserve or reconcile it before restoring',{path:revision.path});
 const backup=await observeRevision(ctx,revision.path,current,revision.hash);
 const record:Replacement={id:requestId??randomUUID(),path:revision.path,beforeHash:revision.restoreHash,content:revision.content,commit:'recovery',recoveryId:backup.id,actor:'human:owner',state:'pending'};
 await ctx.store.transact(tx=>tx.insert('sync-replacements',record.id,record));if(await finishReplacement(ctx,record)==='deferred')throw new AppError('REVISION_CONFLICT','File changed before recovery',{path:revision.path});
 });}
