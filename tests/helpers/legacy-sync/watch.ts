/** Historical version1 writer fixture from1a6814a; never imported by application code. */
import chokidar from 'chokidar';
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../../src/contracts/base.js';
import type { InstanceContext } from '../../../src/instance/open.js';
import type { Vault } from '../../../src/vault/types.js';
import type { PublicationBatch, PublicationIntent, RedactionPolicy } from '../../../src/export/types.js';
import { orderedVault } from '../../../src/vault/write.js';
import { redact } from '../../../src/export/redact.js';
import { assertPublicationSafe } from './contributions.js';
import { validateLiveContent } from '../../../src/sync/apply.js';
import { contentHash, liveBytes, managedPath, observeRevision, recoverPendingReplacements } from '../../../src/sync/recovery.js';
interface Observation {path:string;hash:string|null;content:string|null}
export interface CapturedBatch {batch:PublicationBatch;delivered?:true;acknowledged?:true}
export interface WatchDiagnostic {path:string;code:string;message:string}
export interface WatchOptions {ctx:InstanceContext;vault:Vault;onBatch:(batch:PublicationBatch)=>Promise<void>;policy?:RedactionPolicy;debounceMs?:number;rescanMs?:number;initialTree?:Map<string,string>;baseRevision?:()=>Promise<string|null>;canCapture?:()=>Promise<boolean>}
export async function scanLiveFiles(ctx:InstanceContext,diagnostics:WatchDiagnostic[]=[]):Promise<Map<string,string>>{
 const result=new Map<string,string>();
 async function walk(directory:string){for(const entry of await readdir(join(ctx.vaultDir,directory),{withFileTypes:true})){const path=directory?`${directory}/${entry.name}`:entry.name;if(!managedPath(path))continue;if(entry.isSymbolicLink()){diagnostics.push({path,code:'UNSAFE_PATH',message:'Unsupported symlink; its target is not read or published.'});continue;}if(entry.isDirectory())await walk(path);else if(entry.isFile()&&entry.name.endsWith('.md')){const content=await liveBytes(ctx,path);if(content!==null)result.set(path,content);}}}
 await walk('');return result;
}
export function watchVault(options:WatchOptions){
 const {ctx}=options;let closed=false;let timer:ReturnType<typeof setTimeout>|undefined;let tail=Promise.resolve();let running=false;let dirty=false;let forceNext=false;let editedAt=0;let eventDirty=true;let nextScan=0;
 const error=async(error:unknown)=>{await ctx.store.transact(tx=>{tx.put('sync-watch-error','current',{error:error instanceof Error?error.message:'Vault watcher failed'});tx.emit('sync.watch_error',{message:error instanceof Error?error.message:'Vault watcher failed'});});};
 const ready=orderedVault(ctx,async()=>{await recoverPendingReplacements(ctx);if((await ctx.store.read<{version:number}>('sync-captured-index-version','current'))?.version!==2){const captured=await ctx.store.list<CapturedBatch>('sync-captured');await ctx.store.transact(tx=>{for(const item of captured)tx.put('sync-captured-index',item.batch.id,{id:item.batch.id,acknowledged:!!item.acknowledged,delivered:!!item.delivered});tx.put('sync-captured-index-version','current',{version:2});});}if(!await ctx.store.read('sync-watch-initialized','current')){const files=options.initialTree??await scanLiveFiles(ctx);await ctx.store.transact(tx=>{for(const [path,content] of files)if(managedPath(path)&&path.endsWith('.md'))tx.put<Observation>('sync-observed',path,{path,content,hash:contentHash(content)});tx.put('sync-watch-initialized','current',{initialized:true});});}});
 async function capture(){
  // Old pending captures are immutable recovery evidence. Rebase their current
  // observation onto the original safe preimage, never onto unpublished secrets.
  for(const pending of await ctx.store.scan<{id:string}>('sync-captured-index',{field:'acknowledged',value:false})){
   const item=await ctx.store.read<CapturedBatch>('sync-captured',pending.id);if(!item)continue;
   try{assertPublicationSafe(item.batch,options.policy);}catch{
    await ctx.store.transact(tx=>{tx.put('sync-publication-hold',item.batch.id,{code:'PUBLICATION_HELD',reason:'possible_secret'});if(tx.get('sync-held-rebased',item.batch.id))return;for(const file of item.batch.files){const observed=tx.get<Observation>('sync-observed',file.path);if(observed?.hash===contentHash(file.content)){tx.put('sync-observed',file.path,{path:file.path,hash:file.baseHash,content:null});tx.put('sync-held-base',file.path,{hash:file.baseHash,baseRevision:item.batch.baseRevision});tx.put('vault-writes',file.path,{path:file.path,hash:contentHash(file.content),actor:item.batch.actor??'process:recovered'});}}tx.put('sync-held-rebased',item.batch.id,{held:true});});
   }
  }
  eventDirty=false;nextScan=Date.now()+(options.rescanMs??60000);
  await recoverPendingReplacements(ctx);const diagnostics:WatchDiagnostic[]=[];const current=await scanLiveFiles(ctx,diagnostics);const blocked=diagnostics.map(item=>item.path);
  if(options.canCapture&&!await options.canCapture()){
   for(const [path,content] of current)await observeRevision(ctx,path,content,contentHash(content));
   await ctx.store.transact(tx=>{for(const [path,content] of current)tx.put('sync-unbased',path,{path,content,hash:contentHash(content)});tx.put('sync-watch-diagnostics','current',diagnostics);});return;
  }
  const previous=new Map((await ctx.store.list<Observation>('sync-observed')).map(item=>[item.path,item]));
  const self=new Map((await ctx.store.list<{path:string;hash:string|null;actor:string;proposalId?:string}>('vault-writes')).map(item=>[item.path,item]));
  const groups=new Map<string,{actor:string;baseRevision:string|null;files:PublicationBatch['files']}>();const heldPaths=new Set<string>();const updates:Observation[]=[];const selfLineage:Array<{path:string;hash:string|null;batchId?:string}>=[];
  const baseRevision=await (options.baseRevision?.()??ctx.store.read<{commit:string}>('sync-accepted','current').then(r=>r?.commit??null));
  for(const path of new Set([...previous.keys(),...current.keys()])){
   if(blocked.some(parent=>path===parent||path.startsWith(`${parent}/`)))continue;
   const content=current.get(path)??null;const hash=contentHash(content);const before=previous.get(path);if(hash===(before?.hash??null))continue;
   const own=self.get(path);const actor=own?.hash===hash?own.actor:'human:owner';
   if(actor==='sync:accepted'||actor.startsWith('export:')){
    updates.push({path,content,hash});const batchId=actor.startsWith('export:')?own?.proposalId?.slice(0,own.proposalId.lastIndexOf(':')):undefined;
    const intent=batchId?await ctx.store.read<PublicationIntent>('export-batch',batchId):undefined;
    selfLineage.push({path,hash,...intent?.batch.files.some(file=>file.path===path&&contentHash(file.content)===hash)?{batchId:batchId!}:{}});continue;
   }
   try{assertPublicationSafe({path,content,actor},options.policy);if(content!==null)validateLiveContent(path,content);}catch(e){await observeRevision(ctx,path,content,hash);heldPaths.add(path);diagnostics.push({path:redact(path,options.policy??{}).held?'[held path]':path,code:e instanceof AppError?e.code:'VAULT_IO',message:e instanceof Error?e.message:'Invalid vault file'});continue;}
   await observeRevision(ctx,path,content,hash);
   const rebased=await ctx.store.read<{hash:string|null;baseRevision:string|null}>('sync-held-base',path);const revision=rebased?.hash===(before?.hash??null)?rebased.baseRevision:baseRevision;const key=JSON.stringify([actor,revision]);const group=groups.get(key)??{actor,baseRevision:revision,files:[]};group.files.push({path,baseHash:before?.hash??null,content});groups.set(key,group);updates.push({path,content,hash});
  }
  await ctx.store.transact(tx=>{
   const order=tx.get<string[]>('sync-capture-order','current')??[];
   for(const {actor,files,baseRevision} of groups.values()){const batch:PublicationBatch={id:randomUUID(),originId:ctx.instanceId,actor,baseRevision,files,createdAt:new Date(ctx.clock.now()).toISOString()};tx.insert<CapturedBatch>('sync-captured',batch.id,{batch});for(const file of files)tx.put('sync-lineage',file.path,{path:file.path,hash:contentHash(file.content),batchId:batch.id});order.push(batch.id);tx.emit('sync.captured',{batchId:batch.id,actor});}
   for(const lineage of selfLineage)if(lineage.batchId)tx.put('sync-lineage',lineage.path,lineage);else tx.delete('sync-lineage',lineage.path);
   for(const path of self.keys())if(!heldPaths.has(path))tx.delete('vault-writes',path);
   tx.put('sync-capture-order','current',order);for(const update of updates)tx.put('sync-observed',update.path,update);tx.put('sync-watch-diagnostics','current',diagnostics);
  });
 }
 async function run(){await ready;if((await ctx.store.read<{paused:boolean}>('sync-paused','current'))?.paused)return;await orderedVault(ctx,capture);
  const order=await ctx.store.read<string[]>('sync-capture-order','current')??[];
  const undelivered=new Set((await ctx.store.scan<{id:string}>('sync-captured-index',{field:'delivered',value:false})).map(item=>item.id));
  for(const id of order){if(!undelivered.has(id))continue;const item=await ctx.store.read<CapturedBatch>('sync-captured',id);if(!item||item.delivered)continue;try{assertPublicationSafe(item.batch,options.policy);}catch{continue;}await options.onBatch(JSON.parse(JSON.stringify(item.batch)) as PublicationBatch);await ctx.store.transact(tx=>tx.put('sync-captured',id,{...tx.get<CapturedBatch>('sync-captured',id)!,delivered:true}));}
  await ctx.store.transact(tx=>tx.delete('sync-watch-error','current'));
 }
 function flush(force=true):Promise<void>{if(closed)return tail;if(!force&&!eventDirty&&Date.now()<nextScan)return tail;if(!force&&Date.now()-editedAt<(options.debounceMs??2000))return tail;dirty=true;forceNext||=force;if(running)return tail;running=true;tail=(async()=>{while(dirty&&!closed){const forced=forceNext;dirty=false;forceNext=false;if(forced||Date.now()-editedAt>=(options.debounceMs??2000))await run();}})().catch(error).finally(()=>{running=false;});return tail;}
 function schedule(){if(closed)return;editedAt=Date.now();eventDirty=true;if(timer)clearTimeout(timer);timer=setTimeout(()=>{timer=undefined;void flush(false);},options.debounceMs??2000);timer.unref();}
 const watcher=chokidar.watch(ctx.vaultDir,{ignoreInitial:true,ignored:path=>!managedPath(relative(ctx.vaultDir,path).split(sep).join('/')),followSymlinks:false});
 watcher.on('all',schedule);watcher.on('error',e=>{void error(e);});
 const rescan=setInterval(()=>{void flush(false);},options.rescanMs??60000);rescan.unref();
 return {ready,flush,async pause(){await ready;await ctx.store.transact(tx=>tx.put('sync-paused','current',{paused:true}));await tail;},async resume(){await ctx.store.transact(tx=>tx.put('sync-paused','current',{paused:false}));await flush();},async status(){return {paused:(await ctx.store.read<{paused:boolean}>('sync-paused','current'))?.paused??false,diagnostics:await ctx.store.read<WatchDiagnostic[]>('sync-watch-diagnostics','current')??[],...await ctx.store.read<{error:string}>('sync-watch-error','current')};},async close(){closed=true;if(timer)clearTimeout(timer);clearInterval(rescan);await watcher.close();await ready;await tail;}};
}
