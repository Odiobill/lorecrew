import { link, open, readFile, realpath, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AppError } from '../contracts/base.js';
import { GitClient } from '../git/client.js';
import type { StateContext } from '../instance/state.js';
import type { OperationKind, RepositoryRef, RepositorySnapshot } from './types.js';
import { assertSnapshot, hash, inputHash, inspectRepository } from './inspect.js';
interface Owner {pid:number;start:string;token:string;instanceId?:string;requestId?:string}
const certainFailures=new Set(['OWNER_REVOKED','NOT_OWNER','ADMISSION_CLOSED','AUTHORITY_RETIRED','AUTHORITY_NOT_LOCAL','SYNC_LINK','SYNC_STRUCTURE','PUBLICATION_HELD','DUPLICATE_ID','INVALID_CONCEPT','INVALID_DEFINITION','REPOSITORY_CHANGED','IDEMPOTENCY_CONFLICT','INVALID_REPOSITORY_FILE','PUBLICATION_PENDING','REMOTE_TARGET_CHANGED','REMOTE_UNAVAILABLE','REMOTE_AUTH_REQUIRED','REMOTE_REWIND','REMOTE_DELETED']);
const active=new Set<string>();
async function processStart(pid:number):Promise<string>{if(process.platform==='linux'){const text=await readFile(`/proc/${pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19]!;}return pid===process.pid?String(process.uptime()):'';}
async function exclusive<T>(path:string,work:(owner:Owner)=>Promise<T>,details:{instanceId?:string;requestId?:string}={}):Promise<T>{
 const owner:Owner={pid:process.pid,start:await processStart(process.pid),token:randomUUID(),...details};
 const prepared=path+'.'+owner.token+'.pending';const fd=await open(prepared,'wx',0o600);try{await fd.writeFile(JSON.stringify(owner));await fd.sync();}finally{await fd.close();}
 let acquired=false,uncertain=false;
 try{
  for(;;){try{await link(prepared,path);active.add(owner.token);acquired=true;break;}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
   let observed='';try{const holder:Owner=JSON.parse(await readFile(path,'utf8'));observed=holder.token;if(!Number.isSafeInteger(holder.pid)||!holder.start||!holder.token)throw Error();if(holder.pid===process.pid?!active.has(holder.token):await processStart(holder.pid)!==holder.start)throw Error();}
   catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;if(observed){try{if(JSON.parse(await readFile(path,'utf8')).token!==observed)continue;}catch(recheck){if((recheck as NodeJS.ErrnoException).code==='ENOENT')continue;}}throw new AppError('REPOSITORY_BUSY','Repository owner is unknown; preserve lock and inspect stop evidence');}
   await setTimeout(10);
  }}
  try{return await work(owner);}catch(e){uncertain=!certainFailures.has((e as AppError).code);throw e;}
 }finally{if(acquired){let current:Owner|undefined;try{current=JSON.parse(await readFile(path,'utf8'));}catch{}if(!uncertain&&current?.token===owner.token)await unlink(path);active.delete(owner.token);}await unlink(prepared);}
}

interface OperationRecord {requestId:string;kind:OperationKind;inputHash:string;repository:RepositoryRef;state:'planned'|'running'|'uncertain'|'completed'|'blocked';result?:unknown;owner?:Owner;before?:RepositorySnapshot;after?:RepositorySnapshot}
export async function withRepositoryOperation<T>(state:StateContext,repo:RepositoryRef,intent:{requestId:string;kind:OperationKind;inputHash:string;expected?:RepositorySnapshot},work:(lease:{operationId:string;before:RepositorySnapshot})=>Promise<T>):Promise<T>{
 const previous=await state.store.read<OperationRecord>('repository-operation',intent.requestId);
 if(previous){if(previous.inputHash!==intent.inputHash||JSON.stringify(previous.repository)!==JSON.stringify(repo)||previous.kind!==intent.kind)throw new AppError('IDEMPOTENCY_CONFLICT','Operation identity has different input');if(previous.state==='completed'){await releaseCompletedRepositoryLease(state,repo,intent.requestId);return previous.result as T;}if((previous.state==='running'||previous.state==='uncertain')&&(previous.owner||previous.before))throw new AppError('REPOSITORY_UNCERTAIN','Prior operation needs exact reconciliation before a new mutation');}
 const record:OperationRecord={requestId:intent.requestId,kind:intent.kind,inputHash:intent.inputHash,repository:repo,state:'planned'};
 const save=()=>state.store.transact(tx=>tx.put('repository-operation',intent.requestId,record));await save();
 const git=new GitClient();const inspected=await inspectRepository(git,repo.path);if(!inspected.snapshot)throw new AppError('GIT_REQUIRED','Select an actual Git repository root');assertSnapshot(inspected.snapshot);
 try{const holder:Owner=JSON.parse(await readFile(join(inspected.snapshot.commonDir,'lorecrew-operation.lock'),'utf8'));if(holder.instanceId===state.instanceId&&holder.requestId)await releaseCompletedRepositoryLease(state,repo,holder.requestId);}catch(error){if(error instanceof AppError)throw error;}
 try{return await exclusive(join(inspected.snapshot.commonDir,'lorecrew-operation.lock'),async owner=>{
  const latest=await state.store.read<OperationRecord>('repository-operation',intent.requestId);if(latest?.state==='completed'){if(latest.inputHash!==intent.inputHash)throw new AppError('IDEMPOTENCY_CONFLICT','Operation input changed');return latest.result as T;}
  const before=(await inspectRepository(git,repo.path)).snapshot;if(!before||before.commonDir!==inspected.snapshot!.commonDir)throw new AppError('REPOSITORY_CHANGED','Repository placement changed');try{assertSnapshot(before,intent.expected);}catch(error){if((error as AppError).code==='REPOSITORY_BUSY')throw new AppError('REPOSITORY_CHANGED','A native Git operation began before this mutation');throw error;}record.before=before;record.owner=owner;record.state='running';await save();
  const result=await work({operationId:intent.requestId,before});const after=(await inspectRepository(git,repo.path)).snapshot;if(after)record.after=after;record.result=result??null;record.state='completed';await save();return result;
 },{instanceId:state.instanceId,requestId:intent.requestId});}catch(e){record.state=certainFailures.has((e as AppError).code)?'blocked':'uncertain';await save();throw e;}
}
export async function withRepositoryDestination<T>(_state:StateContext,input:{parentPath:string;folderName:string;requestId:string;inputHash:string},work:()=>Promise<T>):Promise<T>{
 const parent=await realpath(input.parentPath);if(parent!==input.parentPath||!/^[^./\\][^/\\]*$/.test(input.folderName)||input.folderName==='..')throw new AppError('INVALID_DESTINATION','Choose an unchanged host folder and a single folder name');
 const path=join(parent,'.lorecrew-destination-'+hash(input.folderName)+'.lock');const prior=await _state.store.read<{inputHash:string;owner:Owner}>('repository-destination',input.requestId);
 if(prior){if(prior.inputHash!==input.inputHash)throw new AppError('IDEMPOTENCY_CONFLICT','Destination input changed');let owner:Owner|undefined;try{owner=JSON.parse(await readFile(path,'utf8'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(owner?.token===prior.owner.token&&!active.has(owner.token)){
   const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(_state);
   let alive=false;try{alive=owner.pid!==process.pid&&await processStart(owner.pid)===owner.start;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(alive)throw new AppError('REPOSITORY_BUSY','Original destination owner is running');
   if(JSON.parse(await readFile(path,'utf8')).token!==owner.token)throw new AppError('REPOSITORY_BUSY','Destination owner changed');await unlink(path);
  }
 }
 return exclusive(path,async owner=>{await _state.store.transact(tx=>tx.put('repository-destination',input.requestId,{inputHash:input.inputHash,owner}));return work();},{instanceId:_state.instanceId,requestId:input.requestId});
}

/** Only a service-specific verifier may reconcile a known intent; arbitrary callbacks never replay. */
export async function completeReconciledOperation<T>(state:StateContext,repo:RepositoryRef,requestId:string,result:T):Promise<T>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId);if(!record?.before||!['checkpoint','adopt','fetch','publish','integrate'].includes(record.kind))throw new AppError('REPOSITORY_UNCERTAIN','No service-owned intent to reconcile');
 const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);
 const path=join(record.before.commonDir,'lorecrew-operation.lock');const owner:Owner=JSON.parse(await readFile(path,'utf8'));
 if(!record.owner||owner.token!==record.owner.token||owner.pid!==record.owner.pid||owner.start!==record.owner.start)throw new AppError('REPOSITORY_UNCERTAIN','Private operation owner evidence does not match the retained lease');
 if(owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Reconciliation cannot replace another operation owner');
 active.add(owner.token);try{
 try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Original operation owner is still running');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'completed',result}));
 if(JSON.parse(await readFile(path,'utf8')).token!==owner.token)throw new AppError('REPOSITORY_BUSY','Operation lock changed');await unlink(path);return result;
 }finally{active.delete(owner.token);}
}
/** Resume only private-index checkpoint plumbing under the retained, positively stopped owner. */
export async function resumeCheckpointCapture<T>(state:StateContext,repo:RepositoryRef,requestId:string,digest:string,work:(before:RepositorySnapshot)=>Promise<T>):Promise<T>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId);if(!record?.before||record.kind!=='checkpoint'||record.inputHash!==digest||JSON.stringify(record.repository)!==JSON.stringify(repo)||!['uncertain','running'].includes(record.state))throw new AppError('REPOSITORY_UNCERTAIN','No matching capture intent');
 const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);
 const path=join(record.before.commonDir,'lorecrew-operation.lock');const owner:Owner=JSON.parse(await readFile(path,'utf8'));if(!record.owner||record.owner.token!==owner.token||owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Capture owner is not positively stopped');try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Original capture owner is still running');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 const before=(await inspectRepository(new GitClient(),repo.path)).snapshot;if(!before)throw new AppError('REPOSITORY_CHANGED','Original repository is absent');assertSnapshot(before,record.before);
 if(JSON.parse(await readFile(path,'utf8')).token!==owner.token||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Capture owner changed');active.add(owner.token);try{const result=await work(record.before);await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'completed',result}));if(JSON.parse(await readFile(path,'utf8')).token!==owner.token)throw new AppError('REPOSITORY_BUSY','Capture owner changed');await unlink(path);return result;}finally{active.delete(owner.token);}
}
/** Bounded ordinary-integration recovery; its exact private candidate/preimages are required. */
export async function withStoppedIntegrationLease<T>(state:StateContext,repo:RepositoryRef,requestId:string,digest:string,work:()=>Promise<T>):Promise<T>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId),intent=await state.store.read<{inputHash:string;checkpoint?:{commit:string};phase:string}>('repository-integration',requestId);if(!record?.before||record.kind!=='integrate'||record.inputHash!==digest||JSON.stringify(record.repository)!==JSON.stringify(repo)||intent?.inputHash!==digest||!['planned','candidate','applying','completed','blocked'].includes(intent.phase))throw new AppError('REPOSITORY_UNCERTAIN','No exact ordinary integration intent to resume');
 const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);const path=join(record.before.commonDir,'lorecrew-operation.lock');const owner:Owner=JSON.parse(await readFile(path,'utf8'));if(!record.owner||record.owner.token!==owner.token||owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Original integration is not positively stopped');try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Original integration process is running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(JSON.parse(await readFile(path,'utf8')).token!==owner.token||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Integration owner changed');active.add(owner.token);try{const result=await work();await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'completed',result}));if(JSON.parse(await readFile(path,'utf8')).token!==owner.token)throw new AppError('REPOSITORY_BUSY','Integration owner changed');await unlink(path);return result;}finally{active.delete(owner.token);}
}
/** A completed local operation may leave its own durable lease after process death. Never clear a foreign token. */
export async function releaseCompletedRepositoryLease(state:StateContext,repo:RepositoryRef,requestId:string):Promise<void>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId);if(record?.state!=='completed'||!record.before||!record.owner)return;const path=join(record.before.commonDir,'lorecrew-operation.lock');let owner:Owner;try{owner=JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}if(owner.token!==record.owner.token||owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))return;if((await inspectRepository(new GitClient(),repo.path)).snapshot?.commonDir!==record.before.commonDir)return;const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Completed lease owner is still running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(JSON.parse(await readFile(path,'utf8')).token!==owner.token||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Completed lease owner changed');active.add(owner.token);try{await unlink(path);}finally{active.delete(owner.token);}
}
/** Only a journaled fetch can restart after a proven stop: it wrote private capture refs, never a worktree or remote. */
export async function restartStoppedFetchOperation(state:StateContext,repo:RepositoryRef,requestId:string,digest:string):Promise<void>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId),capture=await state.store.read<{inputHash:string;ref:string}>('repository-fetch',requestId);if(!record?.before||!record.owner||record.kind!=='fetch'||record.inputHash!==digest||capture?.inputHash!==digest||!capture.ref.startsWith('refs/lorecrew/fetch/')||JSON.stringify(record.repository)!==JSON.stringify(repo))throw new AppError('REPOSITORY_UNCERTAIN','No exact read-only fetch intent to restart');
 const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);const path=join(record.before.commonDir,'lorecrew-operation.lock'),owner:Owner=JSON.parse(await readFile(path,'utf8'));if(owner.token!==record.owner.token||owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Original fetch is not positively stopped');try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Original fetch process is running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if((await new GitClient().run(repo.path,['rev-parse','--verify','--quiet',capture.ref])).exitCode===0)throw new AppError('REPOSITORY_CHANGED','A captured ref appeared; reconcile its exact commit before retrying');if(JSON.parse(await readFile(path,'utf8')).token!==owner.token||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Fetch owner changed');active.add(owner.token);try{await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'blocked'}));await unlink(path);}finally{active.delete(owner.token);}
}

/** Transport completion is not acceptance. Policy runs only after original fetch ownership is proven. */
export async function withStoppedFetchOperation<T>(state:StateContext,repo:RepositoryRef,requestId:string,digest:string,work:()=>Promise<T>):Promise<T>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId),capture=await state.store.read<{inputHash:string;repo:RepositoryRef;ref:string}>('repository-fetch',requestId);
 if(!record?.before||!record.owner||record.kind!=='fetch'||!['running','uncertain'].includes(record.state)||record.inputHash!==digest||capture?.inputHash!==digest||!capture.ref.startsWith('refs/lorecrew/fetch/')||JSON.stringify(record.repository)!==JSON.stringify(repo)||JSON.stringify(capture.repo)!==JSON.stringify(repo))throw new AppError('REPOSITORY_UNCERTAIN','No exact interrupted fetch intent');
 const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);
 if((await inspectRepository(new GitClient(),repo.path)).snapshot?.commonDir!==record.before.commonDir)throw new AppError('REPOSITORY_CHANGED','Original fetch repository changed');
 const path=join(record.before.commonDir,'lorecrew-operation.lock'),owner:Owner=JSON.parse(await readFile(path,'utf8'));
 if(owner.token!==record.owner.token||owner.pid!==record.owner.pid||owner.start!==record.owner.start||owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Original fetch owner is not positively stopped');
 try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Original fetch process is still running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(inputHash(JSON.parse(await readFile(path,'utf8')))!==inputHash(owner))throw new AppError('REPOSITORY_BUSY','Fetch lease changed');active.add(owner.token);
 const release=async()=>{await assertRepositoryChildrenStopped(state);if(inputHash(JSON.parse(await readFile(path,'utf8')))!==inputHash(owner))throw new AppError('REPOSITORY_BUSY','Fetch owner changed');await unlink(path);};
 try{const result=await work();await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'completed',result}));await release();return result;}
 catch(error){if(error instanceof AppError&&['REMOTE_REWIND','REMOTE_DELETED','REMOTE_TARGET_CHANGED','REPOSITORY_CHANGED'].includes(error.code)){await assertRepositoryChildrenStopped(state);await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'blocked'}));await release();}throw error;}finally{active.delete(owner.token);}
}

/** Resume only the exact private clone creation under its original positively stopped lease. */
export async function withStoppedCloneOperation<T>(state:StateContext,repo:RepositoryRef,requestId:string,creationId:string,stage:'metadata'|'checkout',work:()=>Promise<T>):Promise<T>{
 const record=await state.store.read<OperationRecord>('repository-operation',requestId),creation=await state.store.read<{kind:string;hash:string;repo:RepositoryRef;phase:string}>('repository-creation',creationId);
 if(!record?.before||!record.owner||record.kind!=='clone'||!['running','uncertain'].includes(record.state)||creation?.kind!=='clone'||!['cloning','git'].includes(creation.phase)||JSON.stringify(record.repository)!==JSON.stringify(repo)||JSON.stringify(creation.repo)!==JSON.stringify(repo)||record.inputHash!==inputHash({creation:creation.hash,stage}))throw new AppError('REPOSITORY_UNCERTAIN','No exact interrupted clone creation');
 const {assertRepositoryChildrenStopped}=await import('./git.js');await assertRepositoryChildrenStopped(state);
 if((await inspectRepository(new GitClient(),repo.path)).snapshot?.commonDir!==record.before.commonDir)throw new AppError('REPOSITORY_CHANGED','Clone common directory changed');
 const path=join(record.before.commonDir,'lorecrew-operation.lock'),owner:Owner=JSON.parse(await readFile(path,'utf8'));
 if(owner.token!==record.owner.token||owner.pid!==record.owner.pid||owner.start!==record.owner.start||owner.instanceId!==state.instanceId||owner.requestId!==requestId||active.has(owner.token))throw new AppError('REPOSITORY_BUSY','Original clone owner is not positively stopped');
 try{if(owner.pid!==process.pid&&await processStart(owner.pid)===owner.start)throw new AppError('REPOSITORY_BUSY','Original clone process is still running');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(JSON.parse(await readFile(path,'utf8')).token!==owner.token)throw new AppError('REPOSITORY_BUSY','Clone lease changed');active.add(owner.token);
 try{const result=await work();await state.store.transact(tx=>tx.put('repository-operation',requestId,{...record,state:'completed',result:result??null}));if(JSON.parse(await readFile(path,'utf8')).token!==owner.token)throw new AppError('REPOSITORY_BUSY','Clone owner changed');await unlink(path);return result;}finally{active.delete(owner.token);}
}

/** Observe only. Unknown or stopped owners retain their original lease for explicit reconciliation. */
export async function inspectRepositoryLease(commonDir:string):Promise<'free'|'active'|'uncertain'>{let holder:Owner;try{holder=JSON.parse(await readFile(join(commonDir,'lorecrew-operation.lock'),'utf8'));}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?'free':'uncertain';}try{if(!Number.isSafeInteger(holder.pid)||!holder.start||!holder.token)return 'uncertain';if(holder.pid===process.pid)return active.has(holder.token)?'active':'uncertain';return await processStart(holder.pid)===holder.start?'active':'uncertain';}catch{return 'uncertain';}}
