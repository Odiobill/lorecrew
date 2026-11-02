import {lstat,mkdir,open,readFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import type {StateContext} from '../instance/state.js';
import type {GitClient,GitRunOptions} from '../git/client.js';
import {AppError} from '../contracts/base.js';
import type {Checkpoint,RepositoryRef,RepositorySnapshot} from './types.js';
import {assertSnapshot,hash,inputHash,inspectRepository} from './inspect.js';
import {runRepositoryGit} from './git.js';
import {safeRepositoryPath,validateFile} from './checkpoint.js';
import {prepareRepositoryIndex,advanceRepositoryIndex,assertPreparedIndex,type PreparedRepositoryIndex} from './adopt-tree.js';

interface CloneCheckout {inputHash:string;before:RepositorySnapshot;phase:'materializing'|'prepared'|'completed';expected?:RepositorySnapshot;prepared?:Omit<PreparedRepositoryIndex,'lock'>}
/** Caller holds the original creation's common-directory lease, including on recovery. */
export async function checkoutClone(state:StateContext,git:GitClient,repo:RepositoryRef,commit:string|null,branch:string,requestId:string){
 const digest=inputHash({repo,commit,branch});let plan=await state.store.read<CloneCheckout>('repository-clone-checkout',requestId);
 if(plan&&plan.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Clone checkout input changed');
 const run=async(args:string[],options:GitRunOptions={})=>{const r=await runRepositoryGit(state,git,repo.path,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],options);if(r.exitCode)throw new AppError('GIT_FAILED','Clone checkout is incomplete; preserve its journal');return r;};
 const indexName=(await run(['rev-parse','--git-path','index'])).stdout.trim(),index=isAbsolute(indexName)?indexName:resolve(repo.path,indexName);
 const absentIndex=async()=>{try{await lstat(index);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}throw new AppError('REPOSITORY_CHANGED','An external clone index must be preserved');};
 if(!plan){const before=(await inspectRepository(git,repo.path)).snapshot!;if(!before||before.head!==commit||before.branch!==branch)throw new AppError('REPOSITORY_CHANGED','Clone branch or commit changed');assertSnapshot(before);await absentIndex();plan={inputHash:digest,before,phase:'materializing'};await state.store.transact(tx=>tx.put('repository-clone-checkout',requestId,plan));}
 const save=()=>state.store.transact(tx=>tx.put('repository-clone-checkout',requestId,plan!));
 const completed=async()=>{const actual=(await inspectRepository(git,repo.path)).snapshot;if(!actual)throw new AppError('REPOSITORY_CHANGED','Clone metadata disappeared');assertSnapshot(actual,{...plan!.expected!,indexHash:plan!.prepared?.indexHash??plan!.before.indexHash});};
 if(plan.phase==='completed'){await completed();return;}
 if(plan.phase==='materializing'){
  await absentIndex();const start=(await inspectRepository(git,repo.path)).snapshot!;assertSnapshot({...start,worktreeHash:plan.before.worktreeHash},plan.before);
  if(commit){const files=(await run(['ls-tree','-rz','--full-tree',commit])).stdout;
   for(const line of files.split('\0').filter(Boolean)){const m=/^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(line);if(!m)throw new AppError('UNSUPPORTED_CHECKOUT','Clone links and submodules require explicit host setup');validateFile(m[3]!);const path=await safeRepositoryPath(repo.path,m[3]!);await mkdir(dirname(path),{recursive:true});const data=(await run(['cat-file','blob',m[2]!],{binary:true})).stdoutBytes!;try{const fd=await open(path,'wx',m[1]==='100755'?0o755:0o644);try{await fd.writeFile(data);await fd.sync();}finally{await fd.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(!(await readFile(path)).equals(data))throw new AppError('REPOSITORY_CHANGED','Partial clone working content changed; preserved');}}
  }
  const expected=(await inspectRepository(git,repo.path)).snapshot!;assertSnapshot({...expected,worktreeHash:plan.before.worktreeHash},plan.before);await absentIndex();plan.expected=expected;await save();
  if(!commit){plan.phase='completed';await save();return;}
  const cp:Checkpoint={id:hash('clone-index\0'+requestId),repositoryId:repo.id,commit,parent:commit,ref:'refs/heads/'+branch,files:[]};const prepared=await prepareRepositoryIndex(state,git,repo,cp,expected);
  try{const {lock,...evidence}=prepared;plan.prepared=evidence;plan.phase='prepared';await save();await advanceRepositoryIndex(state,git,repo,cp,expected,prepared);plan.phase='completed';await save();}finally{await prepared.lock.close();}
  return;
 }
 const evidence=plan.prepared!;if(hash(await readFile(evidence.candidate))!==evidence.indexHash)throw new AppError('REPOSITORY_UNCERTAIN','Private clone index candidate changed');
 const actualHash=hash(await readFile(index).catch(error=>{if(error.code==='ENOENT')return Buffer.alloc(0);throw error;}));
 if(actualHash===evidence.indexHash){await completed();plan.phase='completed';await save();return;}
 if(actualHash!==plan.expected!.indexHash)throw new AppError('REPOSITORY_CHANGED','External staged clone work changed; preserve it');
 const lock=await open(index+'.lock','r+'),prepared:PreparedRepositoryIndex={...evidence,lock};
 try{await assertPreparedIndex(prepared);const cp:Checkpoint={id:hash('clone-index\0'+requestId),repositoryId:repo.id,commit:commit!,parent:commit,ref:'refs/heads/'+branch,files:[]};await advanceRepositoryIndex(state,git,repo,cp,plan.expected!,prepared);plan.phase='completed';await save();}finally{await lock.close();}
}
