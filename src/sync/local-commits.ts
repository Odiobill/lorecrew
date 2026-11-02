import {orderedVault} from '../vault/write.js';
import type {InstanceContext} from '../instance/open.js';
import type {Vault} from '../vault/types.js';
import type {Exporter,PublicationBatch,PublicationIntent,RedactionPolicy} from '../export/types.js';
import type {RepositoryService} from '../repositories/service.js';
import type {Checkpoint,CheckpointInput,PublicationReceipt,RepositoryRef} from '../repositories/types.js';
import {GitClient} from '../git/client.js';
import {AppError} from '../contracts/base.js';
import {hash,inputHash} from '../repositories/inspect.js';
import {readVaultIdentity} from '../repositories/identity.js';
import {openSyncProblems} from './problems.js';
import {validateLocalBatch} from './policy.js';
import type {CapturedBatch} from './watch.js';
export interface LocalCommit {batchId:string;checkpoint:Checkpoint;adopted:boolean;published:boolean}
export function openLocalCommits({ctx,repositories,exporter,git=new GitClient(),policy={}}:{ctx:InstanceContext;vault:Vault;repositories:RepositoryService;exporter:Exporter;git?:GitClient;policy?:RedactionPolicy}){
 let tail=Promise.resolve();
 const repo=async():Promise<RepositoryRef>=>({kind:'vault',id:(await readVaultIdentity(ctx.vaultDir)).vaultId,path:ctx.vaultDir});
 const serial=<T>(work:()=>Promise<T>)=>{const result=tail.then(work);tail=result.then(()=>{},()=>{});return result;};
 async function pending(){let batches:PublicationBatch[]=[];try{batches=await exporter.flush();await ctx.store.transact(tx=>tx.delete('sync-export-error','current'));}catch(error){await ctx.store.transact(tx=>tx.put('sync-export-error','current',{error:error instanceof AppError?error.code:'EXPORT_FAILED'}));}const order=await ctx.store.read<string[]>('sync-capture-order','current')??[],wanted=new Set((await ctx.store.list<{id:string;acknowledged:boolean}>('sync-captured-index')).filter(r=>!r.acknowledged).map(r=>r.id));for(const id of order){if(!wanted.has(id))continue;const item=await ctx.store.read<CapturedBatch>('sync-captured',id);if(item&&!item.acknowledged)batches.push(item.batch);}return batches;}
 const tipKey=(snapshot:CheckpointInput['expected'])=>inputHash({commonDir:snapshot.commonDir,branch:snapshot.branch});
 async function captureBatch(batchId:string,original:CheckpointInput):Promise<Checkpoint|undefined>{
  let input=original;
  for(let turn=0;turn<2;turn++){
   const attempt=(await ctx.store.read<{number:number}>('sync-local-capture-attempt',batchId))?.number??0;
   const request='vault-capture:'+batchId+(attempt?':retry:'+attempt:'');
   await ctx.store.transact(tx=>{const key=batchId+':'+attempt,old=tx.get<{inputHash:string}>('sync-local-capture-attempt-input',key),digest=inputHash(input);if(old&&old.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Frozen capture attempt input changed');if(!old)tx.put('sync-local-capture-attempt-input',key,{request,expected:input.expected,inputHash:digest});});
   let checkpoint:Checkpoint;
   try{checkpoint=await repositories.checkpoint(input,request);}catch(error){
    if(!(error instanceof AppError)||error.code!=='REPOSITORY_CHANGED')throw error;
    const operation=await ctx.store.read<{state:string}>('repository-operation',request),id=hash(input.repo.id+'\0'+request);
    // A known blocked capture has not created a commit/ref intent. Never retry
    // an uncertain owner, native index mutation, or an already-created commit.
    if(operation?.state!=='blocked'||await ctx.store.read('repository-checkpoint-intent',id)||await ctx.store.read('repository-checkpoint',id))throw error;
    if((await git.run(input.repo.path,['rev-parse','--verify','--quiet','refs/lorecrew/checkpoints/'+id])).exitCode===0)throw new AppError('REPOSITORY_UNCERTAIN','An unjournaled capture ref must be retained for review');
    const expected=(await repositories.inspect(input.repo.path)).snapshot;
    if(!expected||expected.busy||expected.commonDir!==input.expected.commonDir||expected.branch!==input.expected.branch)throw error;
    input={...input,expected};await ctx.store.transact(tx=>{tx.put('sync-local-capture',batchId,input);tx.put('sync-local-capture-attempt',batchId,{number:attempt+1});});
    if(turn===0)continue;return;
   }
   await ctx.store.transact(tx=>{const old=tx.get<LocalCommit>('sync-local-commit',batchId);if(old&&old.checkpoint.commit!==checkpoint.commit)throw new AppError('IDEMPOTENCY_CONFLICT','The batch already has another canonical commit');if(!old)tx.put('sync-local-commit',batchId,{batchId,checkpoint,adopted:false,published:false});tx.put('sync-local-tip',tipKey(input.expected),{commit:checkpoint.commit});tx.delete('sync-publication-hold',batchId);});return checkpoint;
  }
 }
 async function capture(){const repository=await repo(),result:Checkpoint[]=[];for(const batchId of await ctx.store.keys('sync-local-capture')){if(await ctx.store.read('sync-local-commit',batchId))continue;const input=(await ctx.store.read<CheckpointInput>('sync-local-capture',batchId))!;if(input.repo.path!==repository.path||input.repo.id!==repository.id)throw new AppError('REPOSITORY_CHANGED','Original vault capture binding changed');const checkpoint=await captureBatch(batchId,input);if(checkpoint)result.push(checkpoint);}let batches=await pending();
  // Migration baselines already contain the exact old receipts. Reuse that
  // mapping without fabricating their still-absent remote acknowledgement.
  for(const legacy of await ctx.store.list<{baselines:Checkpoint[];receipts:Record<string,unknown[]>}>('legacy-sync-baseline')){
   const baseline=legacy.baselines.find(cp=>cp.ref.startsWith('refs/lorecrew/checkpoints/')&&cp.files.some(f=>f.path==='.lorecrew/vault.json'));
   if(!baseline)continue;
   const oldIds=new Set(Object.values(legacy.receipts).flat().flatMap(value=>{const v=value as {batch?:{id?:string}};return v.batch?.id?[v.batch.id]:[];}));
   for(const batch of batches)if(oldIds.has(batch.id)&&!await ctx.store.read('sync-local-commit',batch.id))await ctx.store.transact(tx=>tx.put('sync-local-commit',batch.id,{batchId:batch.id,checkpoint:{...baseline,repositoryId:repository.id},adopted:true,published:false}));
  }
  let remaining=batches;while(remaining.length){const deferred:PublicationBatch[]=[];let progressed=false;
   for(const batch of remaining){const prior=await ctx.store.read<LocalCommit>('sync-local-commit',batch.id);if(prior){result.push(prior.checkpoint);continue;}
    try{validateLocalBatch(batch,ctx.instanceId,policy);}catch(error){if(!(error instanceof AppError))throw error;await ctx.store.transact(tx=>tx.put('sync-publication-hold',batch.id,{code:error.code}));continue;}
    let input=await ctx.store.read<CheckpointInput>('sync-local-capture',batch.id);
    if(!input){const expected=(await repositories.inspect(ctx.vaultDir)).snapshot!;if(!expected)throw new AppError('GIT_REQUIRED','Vault is not a Git repository');let parent=expected.head;
     const chain=await ctx.store.read<{commit:string}>('sync-local-tip',tipKey(expected));if(chain&&(await git.run(ctx.vaultDir,['merge-base','--is-ancestor',chain.commit,parent!])).exitCode!==0)parent=chain.commit;
     let matches=true;for(const file of batch.files){const previous=parent?await git.run(ctx.vaultDir,['show',parent+':'+file.path]):undefined;const content=previous?.exitCode===0?previous.stdout:null;if((content===null?null:hash(content))!==file.baseHash&&content!==file.content)matches=false;}
     if(!matches){deferred.push(batch);continue;}
     input={repo:repository,expected,parent,files:batch.files.map(({path,content})=>({path,hash:content===null?null:hash(content),content})),purpose:'vault_batch',message:'Save vault batch '+batch.id+'\n\nOrigin: '+batch.originId+'\nActor: '+(batch.actor??'export')};await ctx.store.transact(tx=>tx.put('sync-local-capture',batch.id,input));
    }
    const checkpoint=await captureBatch(batch.id,input);if(checkpoint){result.push(checkpoint);progressed=true;}
   }
   if(!progressed){for(const batch of deferred)await ctx.store.transact(tx=>tx.put('sync-publication-hold',batch.id,{code:'STALE_CAPTURE_PREIMAGE'}));break;}remaining=deferred;
  }
  return result;
 }
 async function integrate(){
  const repository=await repo(),current=(await repositories.inspect(ctx.vaultDir)).snapshot;if(!current)return;
  const tip=await ctx.store.read<{commit:string}>('sync-local-tip',tipKey(current)),receipts=await ctx.store.list<LocalCommit>('sync-local-commit'),heldBranches=new Set<string>();
  receipts.sort((a,b)=>Number(b.checkpoint.commit===tip?.commit)-Number(a.checkpoint.commit===tip?.commit));
  for(const receipt of receipts){
   if(receipt.adopted)continue;
   let pending=await ctx.store.read<{request:string;expected:CheckpointInput['expected']}>('sync-local-integration-pending',receipt.batchId);
   if(!pending){
    const expected=(await repositories.inspect(ctx.vaultDir)).snapshot!;if(!expected||expected.busy)continue;
    const selection=await ctx.store.read<CheckpointInput>('sync-local-capture',receipt.batchId);
    if(selection&&selection.expected.branch!==expected.branch){
     if(!expected.head||(await git.run(ctx.vaultDir,['merge-base','--is-ancestor',receipt.checkpoint.commit,expected.head])).exitCode!==0){heldBranches.add(selection.expected.branch??'detached');await ctx.store.transact(tx=>tx.put('sync-publication-hold',receipt.batchId,{code:'REPOSITORY_BRANCH_CHANGED',branch:selection.expected.branch,ref:receipt.checkpoint.ref}));continue;}
    }
    pending={request:'vault-integrate:'+receipt.batchId+':'+inputHash(expected),expected};await ctx.store.transact(tx=>tx.put('sync-local-integration-pending',receipt.batchId,pending));
   }
   const outcome=await repositories.integrate(repository,receipt.checkpoint,pending.expected,pending.request);
   await ctx.store.transact(tx=>{if(outcome.state!=='blocked'){tx.put('sync-local-commit',receipt.batchId,{...receipt,adopted:true});if(tx.get<{code:string}>('sync-publication-hold',receipt.batchId)?.code==='REPOSITORY_BRANCH_CHANGED')tx.delete('sync-publication-hold',receipt.batchId);}tx.delete('sync-local-integration-pending',receipt.batchId);});
  }
  const problems=openSyncProblems(ctx,repository);if(heldBranches.size)await problems.hold('REPOSITORY_BRANCH_CHANGED',inputHash({branches:[...heldBranches].sort(),current:current.branch}));else await problems.resolve('REPOSITORY_BRANCH_CHANGED');
 }
 async function confirmPublished(receipt:PublicationReceipt){if(!receipt.confirmed)return;for(const local of await ctx.store.list<LocalCommit>('sync-local-commit')){
  // These lightweight projections are updated in the canonical batch transaction.
  // Missing/false evidence still reads the original payload and repairs the old gap.
  if(local.published){const exported=await ctx.store.read<{acknowledged:boolean}>('export-batch-index',local.batchId),captured=exported?undefined:await ctx.store.read<{acknowledged:boolean}>('sync-captured-index',local.batchId);if((exported??captured)?.acknowledged)continue;}
  const intent=await ctx.store.read<PublicationIntent>('export-batch',local.batchId),capture=intent?undefined:await ctx.store.read<CapturedBatch>('sync-captured',local.batchId);
  // A previous version could persist published before its second acknowledgement.
  // Skip only when the original canonical batch acknowledgement is also durable.
  if(local.published&&(intent?intent.acknowledged:!capture||capture.acknowledged))continue;
  if(!receipt.refs.some(ref=>ref.commit===local.checkpoint.commit)){let found=false;for(const ref of receipt.refs)if((await git.run(ctx.vaultDir,['merge-base','--is-ancestor',local.checkpoint.commit,ref.commit])).exitCode===0)found=true;if(!found)continue;}
  if(intent&&!intent.acknowledged)await exporter.acknowledge(local.batchId);
  await ctx.store.transact(tx=>{
   const current=tx.get<LocalCommit>('sync-local-commit',local.batchId);if(!current||inputHash(current.checkpoint)!==inputHash(local.checkpoint))throw new AppError('IDEMPOTENCY_CONFLICT','Original local publication checkpoint changed');
   if(intent){if(!tx.get<PublicationIntent>('export-batch',local.batchId)?.acknowledged)throw new AppError('EXPORT_ACK_PENDING','Original export acknowledgement is not durable');}
   else{const old=tx.get<CapturedBatch>('sync-captured',local.batchId);if(old&&!old.acknowledged)tx.put('sync-captured',local.batchId,{...old,acknowledged:true});}
   if(!current.published)tx.put('sync-local-commit',local.batchId,{...current,published:true});
  });
 }}
 return {capture:()=>serial(capture),integrate:()=>serial(()=>orderedVault(ctx,integrate)),confirmPublished:(receipt:PublicationReceipt)=>serial(()=>confirmPublished(receipt))};
}
