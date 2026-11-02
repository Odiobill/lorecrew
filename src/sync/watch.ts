import chokidar from 'chokidar';
import { readdir,readFile,lstat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { PublicationBatch, PublicationIntent, RedactionPolicy } from '../export/types.js';
import { orderedVault } from '../vault/write.js';
import { redact } from '../export/redact.js';
import {assertPublicationSafe,portableMetadataPath,validatePortableContent} from './policy.js';
import {validateCandidateLinks} from './links.js';
import {parseConcept} from '../vault/parse.js';
import {stableId as conceptId} from '../vault/indexes.js';
import {safeRepositoryPath} from '../repositories/checkpoint.js';
import { validateLiveContent } from './apply.js';
import { contentHash, liveBytes, managedPath, observeRevision, recoverPendingReplacements } from './recovery.js';
interface Observation {path:string;hash:string|null;content:string|null}
export interface CapturedBatch {batch:PublicationBatch;delivered?:true;acknowledged?:true}
export interface WatchDiagnostic {path:string;code:string;message:string}
export interface WatchOptions {ctx:InstanceContext;vault:Vault;onBatch:(batch:PublicationBatch)=>Promise<void>;policy?:RedactionPolicy;debounceMs?:number;rescanMs?:number;initialTree?:Map<string,string>;baseRevision?:()=>Promise<string|null>;canCapture?:()=>Promise<boolean>}
export async function scanLiveFiles(ctx:InstanceContext,diagnostics:WatchDiagnostic[]=[]):Promise<Map<string,string>>{
 const result=new Map<string,string>();
 async function walk(directory:string){for(const entry of await readdir(join(ctx.vaultDir,directory),{withFileTypes:true})){const path=directory?`${directory}/${entry.name}`:entry.name;if(!managedPath(path))continue;if(entry.isSymbolicLink()){diagnostics.push({path,code:'UNSAFE_PATH',message:'Unsupported symlink; its target is not read or published.'});continue;}if(entry.isDirectory())await walk(path);else if(entry.isFile()&&entry.name.endsWith('.md')){try{const content=await liveBytes(ctx,path);if(content!==null)result.set(path,content);}catch(error){if(!(error instanceof AppError))throw error;diagnostics.push({path,code:error.code,message:'Unsupported Markdown is retained locally'});}}else if(!entry.isFile())diagnostics.push({path,code:'UNSAFE_PATH',message:'Special files are not read or synchronized'});}}
 await walk('');const metadata=['.lorecrew/vault.json','.lorecrew/authority.json'];try{for(const name of await readdir(await safeRepositoryPath(ctx.vaultDir,'.lorecrew/projects')))if(portableMetadataPath('.lorecrew/projects/'+name))metadata.push('.lorecrew/projects/'+name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}try{for(const name of await readdir(await safeRepositoryPath(ctx.vaultDir,'.lorecrew/handoffs')))if(portableMetadataPath('.lorecrew/handoffs/'+name))metadata.push('.lorecrew/handoffs/'+name);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}for(const path of metadata){try{const absolute=await safeRepositoryPath(ctx.vaultDir,path);if(!(await lstat(absolute)).isFile())throw new AppError('UNSAFE_PATH','Portable metadata must be a regular file');const content=await readFile(absolute,'utf8');validatePortableContent(path,content);result.set(path,content);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;diagnostics.push({path,code:error instanceof AppError?error.code:'INVALID_METADATA',message:'Portable metadata requires repair'});}}return result;
}
export function watchVault(options:WatchOptions){
 const {ctx}=options;let closed=false;let timer:ReturnType<typeof setTimeout>|undefined;let tail=Promise.resolve();let running=false;let dirty=false;let forceNext=false;let editedAt=0;let eventDirty=true;let nextScan=0;
 const error=async(error:unknown)=>{await ctx.store.transact(tx=>{tx.put('sync-watch-error','current',{error:error instanceof Error?error.message:'Vault watcher failed'});tx.emit('sync.watch_error',{message:error instanceof Error?error.message:'Vault watcher failed'});});};
 const ready=orderedVault(ctx,async()=>{await recoverPendingReplacements(ctx);if((await ctx.store.read<{version:number}>('sync-captured-index-version','current'))?.version!==2){const captured=await ctx.store.list<CapturedBatch>('sync-captured');await ctx.store.transact(tx=>{for(const item of captured)tx.put('sync-captured-index',item.batch.id,{id:item.batch.id,acknowledged:!!item.acknowledged,delivered:!!item.delivered});tx.put('sync-captured-index-version','current',{version:2});});}if(!await ctx.store.read('sync-watch-initialized','current')){const files=options.initialTree??await scanLiveFiles(ctx);await ctx.store.transact(tx=>{for(const [path,content] of files)if(managedPath(path)&&path.endsWith('.md')||portableMetadataPath(path))tx.put<Observation>('sync-observed',path,{path,content,hash:contentHash(content)});tx.put('sync-watch-initialized','current',{initialized:true});});}});
 async function capture(){
  // Old pending captures are immutable recovery evidence. Rebase their current
  // observation onto the original safe preimage, never onto unpublished secrets.
  for(const pending of await ctx.store.scan<{id:string}>('sync-captured-index',{field:'acknowledged',value:false})){
   const item=await ctx.store.read<CapturedBatch>('sync-captured',pending.id);if(!item)continue;
   try{assertPublicationSafe(item.batch,options.policy);}catch{
    await ctx.store.transact(tx=>{tx.put('sync-publication-hold',item.batch.id,{code:'PUBLICATION_HELD',reason:'possible_secret'});if(tx.get('sync-held-rebased',item.batch.id))return;for(const file of item.batch.files){const observed=tx.get<Observation>('sync-observed',file.path);if(observed?.hash===contentHash(file.content)){tx.put('sync-observed',file.path,{path:file.path,hash:file.baseHash,content:null});tx.put('sync-held-base',file.path,{hash:file.baseHash,baseRevision:item.batch.baseRevision});tx.put('vault-writes',file.path,{path:file.path,hash:contentHash(file.content),actor:item.batch.actor??'process:recovered'});}}tx.put('sync-held-rebased',item.batch.id,{held:true});});
   }
  }
  eventDirty=false;nextScan=ctx.clock.now()+(options.rescanMs??60000);
  await recoverPendingReplacements(ctx);const diagnostics:WatchDiagnostic[]=[];const current=await scanLiveFiles(ctx,diagnostics);const blocked=diagnostics.map(item=>item.path);
  if(options.canCapture&&!await options.canCapture()){
   for(const [path,content] of current)if(!portableMetadataPath(path))await observeRevision(ctx,path,content,contentHash(content));
   await ctx.store.transact(tx=>{for(const [path,content] of current)tx.put('sync-unbased',path,{path,content,hash:contentHash(content)});tx.put('sync-watch-diagnostics','current',diagnostics);});return;
  }
  const previous=new Map((await ctx.store.list<Observation>('sync-observed')).map(item=>[item.path,item]));
  const self=new Map((await ctx.store.list<{path:string;hash:string|null;actor:string;proposalId?:string}>('vault-writes')).map(item=>[item.path,item]));
  const available=new Set(current.keys()),ids=new Map<string,string[]>();for(const [path,content] of current){if(!path.endsWith('.md'))continue;try{const id=conceptId(parseConcept(path,content));if(id)ids.set(id,[...(ids.get(id)??[]),path]);}catch{}}
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
   try{if(path.startsWith('.lorecrew/handoffs/')&&before?.content!=null&&content!==before.content)throw new AppError('IMMUTABLE_HANDOFF_MANIFEST','Published handoff manifests are immutable; changed bytes remain local');if(path.startsWith('history/')&&!path.endsWith('/index.md')&&before?.content!=null&&content!==before.content)throw new AppError('IMMUTABLE_HISTORY','Historical segments require explicit review; changed bytes remain local');assertPublicationSafe({path,content,actor},options.policy);validatePortableContent(path,content);if(content!==null&&path.endsWith('.md')){const concept=parseConcept(path,content),id=conceptId(concept);if(id&&(ids.get(id)?.length??0)>1)throw new AppError('DUPLICATE_ID','Duplicate portable ID requires explicit repair');validateCandidateLinks(path,concept.body,available);}}catch(e){if(!portableMetadataPath(path))await observeRevision(ctx,path,content,hash);heldPaths.add(path);diagnostics.push({path:redact(path,options.policy??{}).held?'[held path]':path,code:e instanceof AppError?e.code:'VAULT_IO',message:e instanceof Error?e.message:'Invalid vault file'});continue;}
   if(!portableMetadataPath(path))await observeRevision(ctx,path,content,hash);
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
 function flush(force=true):Promise<void>{if(closed)return tail;if(!force&&!eventDirty&&ctx.clock.now()<nextScan)return tail;if(!force&&ctx.clock.now()-editedAt<(options.debounceMs??2000))return tail;dirty=true;forceNext||=force;if(running)return tail;running=true;tail=(async()=>{while(dirty&&!closed){const forced=forceNext;dirty=false;forceNext=false;if(forced||ctx.clock.now()-editedAt>=(options.debounceMs??2000))await run();}})().catch(error).finally(()=>{running=false;});return tail;}
 function schedule(){if(closed)return;editedAt=ctx.clock.now();eventDirty=true;if(timer)clearTimeout(timer);timer=setTimeout(()=>{timer=undefined;void flush(false);},options.debounceMs??2000);timer.unref();}
 const watcher=chokidar.watch(ctx.vaultDir,{ignoreInitial:true,ignored:path=>{const p=relative(ctx.vaultDir,path).split(sep).join('/');return !managedPath(p)&&!portableMetadataPath(p)&&p!=='.lorecrew'&&p!=='.lorecrew/projects';},followSymlinks:false});
 watcher.on('all',schedule);watcher.on('error',e=>{void error(e);});
 const rescan=setInterval(()=>{void flush(false);},options.rescanMs??60000);rescan.unref();
 return {ready,flush,async pause(){await ready;await ctx.store.transact(tx=>tx.put('sync-paused','current',{paused:true}));await tail;},async resume(){await ctx.store.transact(tx=>tx.put('sync-paused','current',{paused:false}));await flush();},async status(){return {paused:(await ctx.store.read<{paused:boolean}>('sync-paused','current'))?.paused??false,diagnostics:await ctx.store.read<WatchDiagnostic[]>('sync-watch-diagnostics','current')??[],...await ctx.store.read<{error:string}>('sync-watch-error','current')};},async close(){closed=true;if(timer)clearTimeout(timer);clearInterval(rescan);await watcher.close();await ready;await tail;}};
}
