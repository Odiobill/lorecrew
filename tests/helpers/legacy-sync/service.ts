/** Historical version1 writer fixture from1a6814a; never imported by application code. */
import type { InstanceContext } from '../../../src/instance/open.js';
import type { Vault } from '../../../src/vault/types.js';
import type { Runtime } from '../../../src/runtime/types.js';
import type { GitClient } from '../../../src/git/client.js';
import type { PublicationBatch, PublicationIntent, RedactionPolicy } from '../../../src/export/types.js';
import type { ConfirmedIntegration, PublicationRecord } from '../../../src/sync/types.js';
import { AppError } from '../../../src/contracts/base.js';
import { openExporter } from '../../../src/export/outbox.js';
import { openSync } from './engine.js';
import { StagingRepository } from './contributions.js';
import { applyAccepted, type AcceptedFile } from '../../../src/sync/apply.js';
import { contentHash, managedPath } from '../../../src/sync/recovery.js';
import { orderedVault } from '../../../src/vault/write.js';
import { watchVault, type CapturedBatch } from './watch.js';
interface LiveBase {path:string;hash:string|null;content:string|null;commit:string}
export interface VaultSyncOptions {ctx:InstanceContext;vault:Vault;runtime:Pick<Runtime,'history'>&Partial<Pick<Runtime,'learning'>>;git:GitClient;remote?:string|false;policy?:RedactionPolicy;publicationMs?:number;retryMs?:number;rescanMs?:number}
/** Owns cadence and lifecycle; exporter and SyncEngine remain the durable authorities. */
export async function openVaultSync(options:VaultSyncOptions){
 const {ctx,vault,runtime}=options;const transport=new AbortController();const git={run:(cwd:string,args:string[])=>options.git.run(cwd,args,{signal:transport.signal})};
 let remote=options.remote;if(remote===undefined){const origin=await git.run(ctx.vaultDir,['remote','get-url','origin']);if(origin.exitCode===0)remote='origin';}
 const mode=remote===false?'disabled':remote?'active':'awaiting_remote';
 await ctx.store.transact(tx=>tx.put('sync-service','current',{mode}));
 if(!await ctx.store.read('sync-captured-index-version','current')){const items=await ctx.store.list<CapturedBatch>('sync-captured');await ctx.store.transact(tx=>{for(const item of items)tx.put('sync-captured-index',item.batch.id,{id:item.batch.id,acknowledged:!!item.acknowledged});tx.put('sync-captured-index-version','current',{version:1});});}
 const sourceResult=await git.run(ctx.vaultDir,['rev-parse','HEAD']);
 await ctx.store.transact(tx=>{if(!tx.get('sync-base','source'))tx.put('sync-base','source',{commit:sourceResult.exitCode===0?sourceResult.stdout.trim():null});});
 const baseKnown=async()=>(await ctx.store.read<{confirmed?:boolean}>('sync-base','initial'))?.confirmed===true;
 const baseRevision=async()=>(await ctx.store.read<{commit:string}>('sync-accepted','current'))?.commit??(await baseKnown()?(await ctx.store.read<{commit:string|null}>('sync-base','initial'))!.commit:null);
 const policy=options.policy??{};const exporter=openExporter({ctx,vault,runtime,baseRevision,policy});
 const acknowledge=async(id:string)=>{if(await ctx.store.read('export-batch',id))await exporter.acknowledge(id);else await ctx.store.transact(tx=>{const item=tx.get<CapturedBatch>('sync-captured',id);if(!item)throw new AppError('SYNC_BATCH','Integrated local batch has no capture receipt');tx.put('sync-captured',id,{...item,acknowledged:true});});};
 const engine=remote?openSync({ctx,vault,git,remote,acknowledge,policy}):undefined;
 const repo=remote?new StagingRepository({ctx,vault,git,remote}):undefined;
 const watcher=watchVault({ctx,vault,policy,initialTree:new Map(),baseRevision,canCapture:baseKnown,onBatch:async()=>{},debounceMs:options.publicationMs??2000,rescanMs:options.rescanMs??60000});await watcher.ready;
 let closing=false;let tail=Promise.resolve();let nextFetch=0;let running=false;let dirty=false;let forceNext=false;
 async function establishBase(){
  if(await baseKnown())return;
  await repo!.init();const shared=await repo!.fetch();let commit:string|null=null;
  if(shared.head!==null){
   const accepted=await ctx.store.read<{commit:string}>('sync-accepted','current');
   const source=(await ctx.store.read<{commit:string|null}>('sync-base','source'))?.commit;
   if(accepted&&(await git.run(repo!.cwd,['merge-base','--is-ancestor',accepted.commit,shared.head])).exitCode===0)commit=accepted.commit;
   else if(source){
    // Import objects into staging only. A checkout commit is evidence of local
    // history, never permission to replace its authored bytes.
    await repo!.run(['fetch','--no-tags','--no-write-fetch-head',ctx.vaultDir,source]);
    const common=await git.run(repo!.cwd,['merge-base',source,shared.head]);
    if(common.exitCode!==0)throw new AppError('SYNC_BASE_UNKNOWN','Local history has no established shared ancestor');commit=common.stdout.trim();
   }else throw new AppError('SYNC_BASE_UNKNOWN','A shared baseline must be established before reconciling this vault');
  }
  const tree=await repo!.tree(commit);
  await orderedVault(ctx,async()=>{
   const oldLive=await ctx.store.list<LiveBase>('sync-live');const oldObserved=await ctx.store.list<{path:string}>('sync-observed');
   await ctx.store.transact(tx=>{for(const item of oldLive)tx.delete('sync-live',item.path);for(const item of oldObserved)tx.delete('sync-observed',item.path);
    for(const [path,content] of tree)if(managedPath(path)&&path.endsWith('.md')){const item={path,content,hash:contentHash(content),commit:commit??''};tx.put('sync-live',path,item);tx.put('sync-observed',path,item);}
    tx.put('sync-base','initial',{commit,confirmed:true});
   });
  });
 }
 async function exportLocal(){try{await exporter.flush();await runtime.learning?.drain();await ctx.store.transact(tx=>tx.delete('sync-export-error','current'));}catch(error){await ctx.store.transact(tx=>tx.put('sync-export-error','current',{error:error instanceof AppError?error.code:error instanceof Error?error.message:'Export failed'}));}}
 async function pending(){
  const index=await ctx.store.list<{id:string;state:string;acknowledged:boolean}>('export-batch-index');const wanted=new Set(index.filter(i=>i.state==='validated'&&!i.acknowledged).map(i=>i.id));const exportOrder=await ctx.store.read<string[]>('export-order',ctx.instanceId)??[];
  const capturedIndex=await ctx.store.list<{id:string;acknowledged:boolean}>('sync-captured-index');const capturedWanted=new Set(capturedIndex.filter(i=>!i.acknowledged).map(i=>i.id));const captureOrder=await ctx.store.read<string[]>('sync-capture-order','current')??[];
  const batches:PublicationBatch[]=[];for(const id of exportOrder)if(wanted.has(id)){const item=await ctx.store.read<PublicationIntent>('export-batch',id);if(item)batches.push(item.batch);}for(const id of captureOrder)if(capturedWanted.has(id)){const item=await ctx.store.read<CapturedBatch>('sync-captured',id);if(item)batches.push(item.batch);}return batches;
 }
 async function publish(batches:PublicationBatch[]){
  // A captured edit can follow a generated export, or vice versa. Source hashes
  // and SyncEngine contribution ancestry determine order, never wall-clock time.
  let remaining=batches;let failures:Array<{batchId:string;error:string}>=[];
  while(remaining.length){const deferred:PublicationBatch[]=[];failures=[];for(const batch of remaining){try{await engine!.publish(batch);}catch(error){failures.push({batchId:batch.id,error:error instanceof AppError?error.code:error instanceof Error?error.message:'Publication failed'});deferred.push(batch);}}if(deferred.length===remaining.length)break;remaining=deferred;}return failures;
 }
 async function tick(force:boolean){
  if(mode==='disabled'||(await ctx.store.read<{paused:boolean}>('sync-paused','current'))?.paused)return;
  await watcher.flush(force||forceNext);
  await exportLocal();
  if(!engine||!repo)return;
  const priorError=(await ctx.store.read<{error?:string}>('sync-service','current'))?.error;
  if(!force&&ctx.clock.now()<nextFetch&&(priorError||!(await pending()).length))return;
  await establishBase();await watcher.flush(force||forceNext);await exportLocal();await watcher.flush(force||forceNext);const batches=await pending();
  const failures=await publish(batches);const accepted=await engine.integrate();nextFetch=ctx.clock.now()+(options.retryMs??60000);
  const installed=await ctx.store.read<{lastAppliedCommit?:string;deferred?:string[]}>('sync-service','current');
  if(installed?.lastAppliedCommit===accepted.acceptedCommit&&!installed.deferred?.length){await ctx.store.transact(tx=>tx.put('sync-service','current',{mode,lastAppliedCommit:accepted.acceptedCommit,deferred:[],...failures.length?{error:'PUBLICATION_PENDING',publicationErrors:failures}:{}}));return;}
  const tree=await repo.tree(accepted.acceptedCommit);const live=new Map((await ctx.store.list<LiveBase>('sync-live')).map(item=>[item.path,item]));
  const integrated=new Set((await ctx.store.list<ConfirmedIntegration>('sync-integrated')).map(item=>item.batchId));
  const lineages=new Map((await ctx.store.list<{path:string;hash:string|null;batchId:string}>('sync-lineage')).map(item=>[item.path,item]));
  const observed=new Map((await ctx.store.list<{path:string;hash:string|null}>('sync-observed')).map(item=>[item.path,item.hash]));
  const files:AcceptedFile[]=[];const pendingPaths:string[]=[];
  for(const path of new Set([...live.keys(),...tree.keys()])){if(!managedPath(path)||!path.endsWith('.md'))continue;const content=tree.get(path)??null;const old=live.get(path);if(old?.content===content)continue;
   // Only the batch responsible for this observation can authorize replacement.
   // An older accepted publication with identical bytes proves no such thing.
   const lineage=lineages.get(path);const current=lineage?.hash===observed.get(path)?lineage:undefined;
   const publication=current&&integrated.has(current.batchId)?await ctx.store.read<PublicationRecord>('sync-publication',current.batchId):undefined;
   const local=publication?.batch.originId===ctx.instanceId?publication.batch.files.find(file=>file.path===path&&contentHash(file.content)===current!.hash):undefined;
   if(current&&!local&&contentHash(content)!==observed.get(path)){
    pendingPaths.push(path);await ctx.store.transact(tx=>tx.put('sync-apply-diagnostic',path,{path,code:'LOCAL_PUBLICATION_PENDING',batchId:current.batchId,commit:accepted.acceptedCommit}));continue;
   }
   files.push({path,content,baseHash:local?contentHash(local.content):old?.hash??null,observedBatchId:lineage?.batchId??null});
  }
  const result=await applyAccepted({ctx,vault,commit:accepted.acceptedCommit,files});await watcher.flush(force||forceNext);
  await ctx.store.transact(tx=>tx.put('sync-service','current',{mode,lastAppliedCommit:accepted.acceptedCommit,deferred:[...result.deferred,...pendingPaths],...failures.length?{error:'PUBLICATION_PENDING',publicationErrors:failures}:{}}));
 }
 function flush(force=true):Promise<void>{
  if(closing)return tail;dirty=true;forceNext||=force;if(running)return tail;running=true;
  tail=(async()=>{while(dirty&&!closing){const requestedForce=forceNext;dirty=false;forceNext=false;try{await tick(requestedForce);}catch(error){nextFetch=ctx.clock.now()+(options.retryMs??60000);await ctx.store.transact(tx=>{tx.put('sync-service','current',{mode,error:error instanceof AppError?error.code:'Synchronization failed',nextRetryAt:new Date(nextFetch).toISOString()});tx.emit('sync.error',{message:error instanceof AppError?error.code:'Synchronization failed'});});}}})().finally(()=>{running=false;});return tail;
 }
 const timer=setInterval(()=>{void flush(false);},options.publicationMs??2000);timer.unref();
 // Startup remains local. An unavailable remote is reported by the worker.
 void flush(false);
 return {flush,pause:async()=>{await watcher.pause();await tail;},resume:async()=>{await watcher.resume();await flush();},async status(){const exportError=(await ctx.store.read<{error:string}>('sync-export-error','current'))?.error;return {...await ctx.store.read<{mode:string;error?:string;deferred?:string[]}>('sync-service','current'),...engine?await engine.status():{},...exportError?{exportError}:{},watch:await watcher.status()};},async close(){closing=true;clearInterval(timer);transport.abort();await tail;await watcher.close();}};
}
