import {putRepositoryProblem} from '../repositories/problems.js';
import {orderedVault} from '../vault/write.js';
import type {InstanceContext} from '../instance/open.js';
import type {Vault} from '../vault/types.js';
import type {Runtime} from '../runtime/types.js';
import type {GitClient,GitRunOptions} from '../git/client.js';
import type {RedactionPolicy} from '../export/types.js';
import type {PublicationInput,PublicationSuccessor,RepositoryProblem,RepositoryRef,RepositorySnapshot,RemoteTarget} from '../repositories/types.js';
import {AppError} from '../contracts/base.js';
import {openExporter} from '../export/outbox.js';
import {openRepositories} from '../repositories/service.js';
import {readVaultIdentity} from '../repositories/identity.js';
import {discoverRepositoryTarget} from '../repositories/target.js';
import {inputHash,hash} from '../repositories/inspect.js';
import {watchVault} from './watch.js';
import {openLocalCommits} from './local-commits.js';
import {openOrdinaryHistory} from './ordinary-history.js';
import {openSyncProblems} from './problems.js';
export interface VaultSyncOptions {ctx:InstanceContext;vault:Vault;runtime:Pick<Runtime,'history'>&Partial<Pick<Runtime,'learning'>>;git:GitClient;remote?:string|false;policy?:RedactionPolicy;publicationMs?:number;retryMs?:number;rescanMs?:number;timers?:Pick<typeof globalThis,'setInterval'|'clearInterval'>}
interface RemoteIntegration {requestId:string;expected:RepositorySnapshot;target:RemoteTarget}
/** Local capture precedes transport. Ordinary Git is the sole active writer. */
export async function openVaultSync(options:VaultSyncOptions){
 const {ctx,vault,runtime}=options,abort=new AbortController(),timers=options.timers??globalThis;
 const git={run:(cwd:string,args:string[],runOptions:GitRunOptions={})=>options.git.run(cwd,args,{...runOptions,...args.some(arg=>['fetch','push','ls-remote'].includes(arg))?{signal:abort.signal}:{}})};
 const identity=await readVaultIdentity(ctx.vaultDir),repo:RepositoryRef={kind:'vault',id:identity.vaultId,path:ctx.vaultDir};
 const problems=openSyncProblems(ctx,repo),ordinary=openOrdinaryHistory({ctx,git,repo,...options.policy?{policy:options.policy}:{}});
 const repositories=openRepositories({state:ctx,git,validateIntegration:async(candidate,commit)=>{if(candidate.kind==='vault'&&candidate.id===repo.id)await ordinary.validate(commit,null);}});
 const baseRevision=async()=>(await ctx.store.read<{commit:string}>('sync-accepted','current'))?.commit??(await repositories.inspect(repo.path)).snapshot?.head??null;
 const exporter=openExporter({ctx,vault,runtime,baseRevision,...options.policy?{policy:options.policy}:{}}),local=openLocalCommits({ctx,vault,repositories,exporter,git,...options.policy?{policy:options.policy}:{}});
 const initialTree=new Map<string,string>(),initial=(await repositories.inspect(repo.path)).snapshot;
 if(initial?.head){const listed=await git.run(repo.path,['ls-tree','-r','--name-only','-z',initial.head]);for(const path of listed.stdout.split('\0').filter(Boolean)){if(!path.endsWith('.md')&&!path.startsWith('.lorecrew/'))continue;const content=await git.run(repo.path,['show',initial.head+':'+path]);if(content.exitCode===0)initialTree.set(path,content.stdout);}}
 const watcher=watchVault({ctx,vault,initialTree,baseRevision,onBatch:async()=>{},...options.policy?{policy:options.policy}:{},debounceMs:options.publicationMs??2000,rescanMs:options.rescanMs??60000});await watcher.ready;
 let closing=false,running=false,dirty=false,forceNext=false,tail=Promise.resolve(),nextFetch=0,failures=0;let publishing:{requestId:string;input:PublicationInput}|undefined;
 const save=(fields:object)=>ctx.store.transact(tx=>tx.put('sync-service','current',fields));
 async function settleRemoteIntegration(pending:RemoteIntegration){
  const integrated=await orderedVault(ctx,()=>repositories.integrate(repo,pending.target,pending.expected,pending.requestId));
  if(integrated.state==='blocked'){await save({mode:'active',error:'REPOSITORY_CONFLICT',deferred:[]});await ctx.store.transact(tx=>tx.delete('sync-remote-integration-pending','current'));return false;}
  const observations:Array<{path:string;hash:string|null;actor:string}>=[];
  if(integrated.state==='integrated'&&integrated.commit&&pending.expected.head){const changed=await git.run(repo.path,['-c','core.fsmonitor=false','diff','--no-ext-diff','--no-renames','--name-only','-z',pending.expected.head,integrated.commit,'--']);if(changed.exitCode)throw new AppError('REPOSITORY_UNCERTAIN','Integrated change observations could not be recorded');for(const path of changed.stdout.split('\0').filter(Boolean)){const blob=await git.run(repo.path,['show',integrated.commit+':'+path]);observations.push({path,hash:blob.exitCode===0?hash(blob.stdout):null,actor:'sync:accepted'});}}
  await ctx.store.transact(tx=>{for(const observed of observations)tx.put('vault-writes',observed.path,observed);tx.delete('sync-remote-integration-pending','current');});return true;
 }
 async function tick(force:boolean){
  publishing=undefined;if((await watcher.status()).paused)return;const publication=await ctx.store.read<{requestId:string;input:PublicationInput}>('sync-publication-pending','current');if(publication)await repositories.reconcilePublication(publication.input,publication.requestId);const recovering=await ctx.store.read<RemoteIntegration>('sync-remote-integration-pending','current');if(recovering&&!await settleRemoteIntegration(recovering))return;
  await local.integrate();await watcher.flush(force);await local.capture();await runtime.learning?.drain();await watcher.flush(force);await local.integrate();
  let snapshot=(await repositories.inspect(repo.path)).snapshot;
  if(!snapshot)throw new AppError('GIT_REQUIRED','Vault repository is unavailable');
  if(snapshot.busy){await save({mode:'active',deferred:[],error:'REPOSITORY_BUSY'});await repositories.status(repo);return;}
  const target=await discoverRepositoryTarget(git,repo.path,snapshot);
  if(options.remote&&!target)throw new AppError('REMOTE_TARGET_CHANGED','Configure and explicitly confirm the requested destination');if(options.remote===false||!target){await save({mode:options.remote===false?'disabled':'awaiting_remote',deferred:[]});return;}
  if(options.remote&&options.remote!==target.name&&options.remote!==target.endpoint)throw new AppError('REMOTE_TARGET_CHANGED','Explicit sync destination differs from the configured branch');
  if(!force&&ctx.clock.now()<nextFetch)return;
  let fetching=await ctx.store.read<{requestId:string;revision:string}>('sync-fetch-pending','current');if(fetching&&fetching.revision!==target.revision){const operation=await ctx.store.read<{state:string}>('repository-operation',fetching.requestId);if(operation&&['running','uncertain'].includes(operation.state))throw new AppError('REPOSITORY_UNCERTAIN','Reconcile the original fetch before changing its destination');fetching=undefined;}if(!fetching){fetching=await ctx.store.transact(tx=>{const sequence=(tx.get<{sequence:number}>('sync-fetch-sequence','current')?.sequence??0)+1;const next={requestId:'vault-fetch:'+ctx.instanceId+':'+sequence,revision:target.revision};tx.put('sync-fetch-sequence','current',{sequence});tx.put('sync-fetch-pending','current',next);return next;});}const fetched=await repositories.fetch(repo,target,fetching.requestId);await ctx.store.transact(tx=>tx.delete('sync-fetch-pending','current'));
  await ctx.store.transact(tx=>tx.put('sync-status','current',{...tx.get('sync-status','current') as object,lastFetchAt:new Date(ctx.clock.now()).toISOString()}));
  if(fetched.commit){await ordinary.validateHistory(fetched.commit,null);snapshot=(await repositories.inspect(repo.path)).snapshot!;const pending:RemoteIntegration={requestId:'vault-remote-integrate:'+inputHash({target,snapshot,incoming:fetched.commit}),expected:snapshot,target};await ctx.store.transact(tx=>tx.put('sync-remote-integration-pending','current',pending));if(!await settleRemoteIntegration(pending))return;await watcher.flush(true);}
  snapshot=(await repositories.inspect(repo.path)).snapshot!;if(!snapshot.head||!snapshot.branch)return;
  await ordinary.validate(snapshot.head,fetched.commit);await problems.resolve('PUBLICATION_HELD');
  const input:PublicationInput={repo,target,refs:[{localRef:'refs/heads/'+snapshot.branch,commit:snapshot.head,remoteRef:target.ref}]};
  let existing=await ctx.store.read<{requestId:string;input:PublicationInput}>('sync-publication-pending','current');if(existing&&existing.input.target.revision!==target.revision){const retired=await ctx.store.read<{inputHash:string;replacement:string}>('repository-publication-retired',existing.requestId),publication=await ctx.store.read<{inputHash:string;receipt:{confirmed:boolean}}>('repository-publication',existing.requestId),digest=inputHash(existing.input);if(retired?.inputHash===digest&&retired.replacement===target.revision||publication?.inputHash===digest&&publication.receipt.confirmed){await ctx.store.transact(tx=>tx.delete('sync-publication-pending','current'));existing=undefined;}else throw new AppError('REMOTE_TARGET_CHANGED','The previous destination intent requires explicit reconciliation');}
  if(existing&&inputHash(existing.input)!==inputHash(input)&&inputHash(existing.input.repo)===inputHash(input.repo)&&inputHash(existing.input.target)===inputHash(input.target)&&existing.input.refs.length===1&&existing.input.refs[0]!.localRef===input.refs[0]!.localRef&&existing.input.refs[0]!.remoteRef===input.refs[0]!.remoteRef&&(await git.run(repo.path,['merge-base','--is-ancestor',existing.input.refs[0]!.commit,input.refs[0]!.commit])).exitCode===0){
   const next={requestId:'vault-publish:'+inputHash(input),input},successor:PublicationSuccessor={inputHash:inputHash(input),previous:existing};await ctx.store.transact(tx=>{const current=tx.get<{requestId:string;input:PublicationInput}>('sync-publication-pending','current');if(!current||inputHash(current)!==inputHash(existing))throw new AppError('REPOSITORY_CHANGED','Publication queue changed');const prior=tx.get<PublicationSuccessor>('repository-publication-successor',next.requestId);if(prior&&inputHash(prior)!==inputHash(successor))throw new AppError('IDEMPOTENCY_CONFLICT','Publication predecessor changed');tx.put('repository-publication-successor',next.requestId,successor);tx.put('sync-publication-pending','current',next);});existing=next;
  }
  const selected=existing??{requestId:'vault-publish:'+inputHash(input),input};
  if(!existing)await ctx.store.transact(tx=>tx.put('sync-publication-pending','current',selected));
  publishing=selected;const receipt=await repositories.publish(selected.input,selected.requestId);
  if(receipt.confirmed){await local.confirmPublished(receipt);const lineage=new Set(await repositories.reconcilePublication(selected.input,selected.requestId)),related=await ctx.store.list<RepositoryProblem>('repository-problem');await ctx.store.transact(tx=>{for(const old of related)if(old.repositoryKind===repo.kind&&old.repositoryId===repo.id&&old.state==='active'&&(old.operationId?lineage.has(old.operationId):old.code==='REPOSITORY_UNCERTAIN'&&old.revision===inputHash({code:old.code}))){const current=tx.get<RepositoryProblem>('repository-problem',old.id);if(current?.state==='active'&&current.revision===old.revision&&current.operationId===old.operationId)putRepositoryProblem(tx,{...current,state:'resolved'});}tx.put('sync-accepted','current',{commit:selected.input.refs[0]!.commit});tx.delete('sync-publication-pending','current');tx.put('sync-status','current',{...tx.get('sync-status','current') as object,lastPushAt:new Date(ctx.clock.now()).toISOString()});});if(selected.input.refs[0]!.commit!==snapshot.head){dirty=true;forceNext=true;}}
  failures=receipt.confirmed?0:failures+1;nextFetch=ctx.clock.now()+Math.min(300000,(options.retryMs??60000)*Math.max(1,2**Math.min(failures,8)));
  await save({mode:'active',deferred:[],...receipt.confirmed?{}:{pending:true}});
 }
 function flush(force=true):Promise<void>{if(closing)return tail;dirty=true;forceNext||=force;if(running)return tail;running=true;tail=(async()=>{while(dirty){const force=forceNext;dirty=false;forceNext=false;try{await tick(force);}catch(error){const code=error instanceof AppError?error.code:'REPOSITORY_UNAVAILABLE';failures++;nextFetch=ctx.clock.now()+Math.min(300000,(options.retryMs??60000)*2**Math.min(failures,8));const held=(await ctx.store.list<RepositoryProblem>('repository-problem')).find(p=>p.repositoryKind===repo.kind&&p.repositoryId===repo.id&&p.code===code&&p.state==='active');if(!['REMOTE_UNAVAILABLE','GIT_CANCELLED','GIT_TIMEOUT'].includes(code)&&(!held||held.operationId&&held.operationId!==publishing?.requestId))await problems.hold(code,inputHash(publishing?{code,operationId:publishing.requestId,inputHash:inputHash(publishing.input)}:{code}),publishing?.requestId);await save({mode:'active',error:code,nextRetryAt:new Date(nextFetch).toISOString()});}}})().finally(()=>{running=false;});return tail;}
 const timer=timers.setInterval(()=>{void flush(false);},options.publicationMs??2000);timer.unref();void flush(false);
 return {flush,async pause(){await watcher.pause();await tail;},async resume(){await watcher.resume();await flush();},async status(){const exportError=(await ctx.store.read<{error:string}>('sync-export-error','current'))?.error;const saved=await ctx.store.read<{mode:string;error?:string;deferred?:string[]}>('sync-service','current'),native=await repositories.status(repo),receipts=await ctx.store.list<{published:boolean}>('sync-local-commit'),pending=receipts.filter(r=>!r.published).length,watch=await watcher.status(),history=await ctx.store.read<{lastFetchAt?:string;lastPushAt?:string}>('sync-status','current');return {...saved,...history,...native,...exportError?{exportError}:{},state:native.state==='local_only'&&receipts.length?'saved_locally':native.state,pending,conflicts:native.problem?1:0,watch};},async close(){if(closing){await tail;return;}closing=true;timers.clearInterval(timer);abort.abort();await tail;await watcher.close();}};
}
