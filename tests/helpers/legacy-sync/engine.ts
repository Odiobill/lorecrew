/** Historical version1 writer fixture from1a6814a; never imported by application code. */
import { revisionOf } from '../../../src/vault/parse.js';
import { queueCurator } from '../../../src/learning/curator.js';
import { AppError, encodeJson } from '../../../src/contracts/base.js';
import type { PublicationBatch } from '../../../src/export/types.js';
import { contributionRef, SHARED_REF } from '../../../src/git/refs.js';
import { StagingRepository, validateBatch, assertPublicationSafe } from './contributions.js';
import { acceptedBatches, buildIntegration, sharedConflicts } from './integrate.js';
import type { ConfirmedIntegration, PublicationRecord, SyncEngine, SyncOptions, SyncStatus, ConflictProposal, Contribution } from '../../../src/sync/types.js';
const queues=new WeakMap<SyncOptions['ctx'],Promise<void>>();
/** One worker per instance serializes the service-owned staging Git index. */
export function openSync(options:SyncOptions):SyncEngine {
 const {ctx}=options;const repo=new StagingRepository(options);
 async function serial<T>(fn:()=>Promise<T>):Promise<T>{const result=(queues.get(ctx)??Promise.resolve()).then(fn).catch(async(error)=>{await ctx.store.transact(tx=>tx.put('sync-status','current',{...tx.get('sync-status','current') as object,error:error instanceof AppError?error.code:error instanceof Error?error.message:'Synchronization failed'}));throw error;});queues.set(ctx,result.then(()=>{},()=>{}));return result;}
 async function update(fields:Partial<SyncStatus>){await ctx.store.transact(tx=>{const prior=tx.get<Partial<SyncStatus>>('sync-status','current')??{};delete prior.error;tx.put('sync-status','current',{...prior,...fields});});}
 async function fetch(){const state=await repo.fetch();await update({lastFetchAt:new Date(ctx.clock.now()).toISOString()});return state;}
 async function acknowledge(head:string){
  const accepted=await acceptedBatches(repo,head);
  await ctx.store.transact(tx=>{for(const item of accepted){const prior=tx.get<ConfirmedIntegration>('sync-integrated',item.id);if(prior&&prior.originId!==item.originId)throw new AppError('SYNC_ID','Integrated batch origin mismatch');tx.put('sync-integrated',item.id,{acceptedCommit:head,batchId:item.id,originId:item.originId,...prior?.acknowledged?{acknowledged:true}:{}});}tx.put('sync-accepted','current',{commit:head});});
  if(options.acknowledge)for(const receipt of await ctx.store.list<ConfirmedIntegration>('sync-integrated'))if(receipt.originId===ctx.instanceId&&!receipt.acknowledged){await options.acknowledge(receipt.batchId);await ctx.store.transact(tx=>tx.put('sync-integrated',receipt.batchId,{...receipt,acknowledged:true}));}
  return accepted.map(item=>item.id);
 }
 return {
  publish(input:PublicationBatch){return serial(async()=>{
   try{assertPublicationSafe(input,options.policy);}catch(error){await ctx.store.transact(tx=>tx.put('sync-publication-hold',input.id,{code:'PUBLICATION_HELD',reason:'possible_secret'}));throw error;}
   validateBatch(input,ctx.instanceId);const immutable=JSON.parse(encodeJson(input)) as PublicationBatch;const batch=immutable;
   await ctx.store.transact(tx=>{const old=tx.get<PublicationRecord>('sync-publication',batch.id);if(old&&JSON.stringify(old.batch)!==JSON.stringify(immutable))throw new AppError('SYNC_ID','Publication batch ID is immutable');if(!old)tx.insert('sync-publication',batch.id,{batch:immutable});});
   await repo.init();
   for(let attempt=0;attempt<16;attempt++){
    const state=await fetch();const items=await repo.contributions(state.branches,state.head,new Set((await acceptedBatches(repo,state.head)).map(item=>item.id)),batch.id);const known=items.find(item=>item.batch.id===batch.id);
    if(known){if(JSON.stringify(known.batch)!==JSON.stringify(immutable))throw new AppError('SYNC_ID','Remote publication ID differs');await ctx.store.transact(tx=>tx.put('sync-publication',batch.id,{batch:immutable,commit:known.commit}));return {commit:known.commit};}
    await repo.describe(immutable,state.head);
    const parent=state.branches.find(branch=>branch.origin===ctx.instanceId)?.head??state.head;const files=await repo.tree(parent);
    for(const file of immutable.files)if(file.content===null)files.delete(file.path);else files.set(file.path,file.content);
    const commit=await repo.commit(parent,files,{format:'lorecrew-contribution-v1',batch:immutable});await repo.push(commit,contributionRef(ctx.instanceId));
    // Fetch is mandatory even when push reports success: a lost receipt is ambiguous.
    const confirmed=await fetch();const found=(await repo.contributions(confirmed.branches,confirmed.head,new Set((await acceptedBatches(repo,confirmed.head)).map(item=>item.id)),batch.id)).find(item=>item.batch.id===batch.id);
    if(found){if(JSON.stringify(found.batch)!==JSON.stringify(immutable))throw new AppError('SYNC_ID','Remote publication ID differs');await ctx.store.transact(tx=>tx.put('sync-publication',batch.id,{batch:immutable,commit:found.commit}));await update({lastPushAt:new Date(ctx.clock.now()).toISOString()});return {commit:found.commit};}
   }throw new AppError('SYNC_RACE','Publication retry deferred after repeated remote changes');
  });},
  integrate(){return serial(async()=>{
   await repo.init();
   for(let attempt=0;attempt<16;attempt++){
    const state=await fetch();const policyRevision=revisionOf(JSON.stringify(options.policy?.literals??[]));const cached=await ctx.store.read<{head:string;branches:typeof state.branches;conflicts:ConflictProposal[];policyRevision:string;held:number}>('sync-integration-cache-v1','current');if(state.head&&cached?.head===state.head&&cached.policyRevision===policyRevision&&JSON.stringify(cached.branches)===JSON.stringify(state.branches)){const appliedBatchIds=await acknowledge(state.head);await update({held:cached.held,...cached.held?{error:'PUBLICATION_HELD'}:{}});return {acceptedCommit:state.head,appliedBatchIds,conflicts:cached.conflicts};}const items=await repo.contributions(state.branches,state.head,new Set((await acceptedBatches(repo,state.head)).map(item=>item.id)));const eligible:Contribution[]=[];const holds:Array<{commit:string;code:string;reason:string}>=[];
    for(const item of items){try{assertPublicationSafe(item.batch,options.policy);eligible.push(item);}catch(error){if(!(error instanceof AppError)||error.code!=='PUBLICATION_HELD')throw error;holds.push({commit:item.commit,code:'PUBLICATION_HELD',reason:'possible_secret'});}}
    await ctx.store.transact(tx=>tx.put('sync-integration-holds','current',holds));
    const candidate=await buildIntegration(repo,state.head,eligible);
    const current=await repo.tree(state.head);const changed=current.size!==candidate.files.size||[...current].some(([path,text])=>candidate.files.get(path)!==text);
    const previous=await acceptedBatches(repo,state.head);let head=state.head;
    if(changed||previous.length!==candidate.accepted.length){
     // Existing shared bytes and ancestry remain untouched. Every newly emitted
     // value (including generated catalogs/proposals) still crosses the guard.
     assertPublicationSafe([...candidate.files].filter(([path,text])=>current.get(path)!==text),options.policy);
     const commit=await repo.commit(candidate.parent,candidate.files,{format:'lorecrew-integration-v1',accepted:candidate.accepted});await repo.push(commit,SHARED_REF);const confirmed=await fetch();
     if(confirmed.head===null||(await options.git.run(repo.cwd,['merge-base','--is-ancestor',commit,confirmed.head])).exitCode!==0)continue;
     head=confirmed.head;await update({lastPushAt:new Date(ctx.clock.now()).toISOString()});
    }
    if(head===null)throw new AppError('SYNC_EMPTY','No accepted shared revision');
    const appliedBatchIds=await acknowledge(head);const conflicts=await sharedConflicts(repo,head);
    await ctx.store.transact(tx=>{tx.put('sync-integration-cache-v1','current',{head,branches:state.branches,conflicts,policyRevision,held:holds.length});tx.put('sync-conflicts','current',conflicts);for(const conflict of conflicts)queueCurator(tx,{id:`conflict:${conflict.id}`,sourcePaths:conflict.paths,conflict});});await update({held:holds.length,...holds.length?{error:'PUBLICATION_HELD'}:{}});
    return {acceptedCommit:head,appliedBatchIds,conflicts};
   }throw new AppError('SYNC_RACE','Integration retry deferred after repeated remote changes');
  });},
  async status(){const publications=await ctx.store.keys('sync-publication');const accepted=new Set((await ctx.store.list<ConfirmedIntegration>('sync-integrated')).map(item=>item.batchId));const conflicts=await ctx.store.read<unknown[]>('sync-conflicts','current')??[];return {...await ctx.store.read<Partial<SyncStatus>>('sync-status','current'),pending:publications.filter(item=>!accepted.has(item)).length,conflicts:conflicts.length};},
 };
}
