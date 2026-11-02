import {lstat,mkdir,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import type {StateContext} from '../instance/state.js';
import type {GitClient} from '../git/client.js';
import type {Checkpoint,RepositoryRef,RepositorySnapshot} from './types.js';
import {AppError} from '../contracts/base.js';
import {assertSnapshot,hash,inspectRepository} from './inspect.js';
import {runRepositoryGit} from './git.js';
export interface PreparedRepositoryIndex {index:string;candidate:string;indexHash:string;lock:FileHandle;lockIdentity:{dev:number;ino:number}}
async function plumbing(state:StateContext,git:GitClient,repo:RepositoryRef,args:string[],privateIndex?:string){const r=await runRepositoryGit(state,git,repo.path,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],privateIndex?{privateIndex}:{});if(r.exitCode)throw new AppError('GIT_FAILED','Guarded repository adoption failed; retained evidence requires inspection');return r.stdout.trim();}
export async function assertPreparedIndex(prepared:PreparedRepositoryIndex){const stat=await lstat(prepared.index+'.lock');if(!stat.isFile()||stat.dev!==prepared.lockIdentity.dev||stat.ino!==prepared.lockIdentity.ino||hash(await readFile(prepared.index+'.lock'))!==prepared.indexHash)throw new AppError('REPOSITORY_UNCERTAIN','Native index reservation changed; preserve its new owner');}
export async function discardPreparedIndex(prepared:PreparedRepositoryIndex){await assertPreparedIndex(prepared);await rm(prepared.index+'.lock');}
/** Shared by selected local checkpoints and ordinary incoming history. Caller owns the common-dir lease. */
export async function prepareRepositoryIndex(state:StateContext,git:GitClient,repo:RepositoryRef,cp:Checkpoint,before:RepositorySnapshot):Promise<PreparedRepositoryIndex>{
 const indexName=await plumbing(state,git,repo,['rev-parse','--git-path','index']),index=isAbsolute(indexName)?indexName:resolve(repo.path,indexName);if(await realpath(dirname(index))!==dirname(index))throw new AppError('REPOSITORY_CHANGED','Index placement changed');
 const candidate=join(state.stateDir,'staging','adopt-'+cp.id);await mkdir(dirname(candidate),{recursive:true,mode:0o700});await rm(candidate,{force:true});await plumbing(state,git,repo,['read-tree',cp.commit],candidate);const bytes=await readFile(candidate);let lock:FileHandle;try{lock=await open(index+'.lock','wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new AppError('REPOSITORY_CHANGED','An external Git operation reserved the index');throw error;}
 const info=await lock.stat(),prepared:PreparedRepositoryIndex={index,candidate,indexHash:hash(bytes),lock,lockIdentity:{dev:info.dev,ino:info.ino}};
 try{await lock.writeFile(bytes);await lock.sync();const actual=(await inspectRepository(git,repo.path)).snapshot!;if(actual.busy==='index_lock')delete actual.busy;assertSnapshot(actual,before);await assertPreparedIndex(prepared);return prepared;}catch(error){await lock.close();await discardPreparedIndex(prepared);throw error;}
}
export async function advanceRepositoryIndex(state:StateContext,git:GitClient,repo:RepositoryRef,cp:Checkpoint,before:RepositorySnapshot,prepared:PreparedRepositoryIndex,worktreeHash=before.worktreeHash){
 await assertPreparedIndex(prepared);const actual=(await inspectRepository(git,repo.path)).snapshot!;if(actual.busy==='index_lock')delete actual.busy;if(actual.worktreeHash!==worktreeHash)throw new AppError('REPOSITORY_CHANGED','Worktree changed before branch adoption');assertSnapshot({...actual,worktreeHash:before.worktreeHash},before);
 await plumbing(state,git,repo,['update-ref','refs/heads/'+before.branch,cp.commit,before.head??'0'.repeat(cp.commit.length)]);await assertPreparedIndex(prepared);if(hash(await readFile(prepared.index).catch(()=>Buffer.alloc(0)))!==before.indexHash)throw new AppError('REPOSITORY_CHANGED','External index changed after branch adoption');await rename(prepared.index+'.lock',prepared.index);const directory=await open(dirname(prepared.index),'r');try{await directory.sync();}finally{await directory.close();}
}
