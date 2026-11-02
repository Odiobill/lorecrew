import {prepareRepositoryIndex,advanceRepositoryIndex,discardPreparedIndex} from './adopt-tree.js';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../contracts/base.js';
import type { GitClient, GitRunOptions } from '../git/client.js';
import type { StateContext } from '../instance/state.js';
import type { Checkpoint, CheckpointInput, RepositoryRef, RepositorySnapshot } from './types.js';
import { assertRepositoryChildrenStopped, runRepositoryGit } from './git.js';
import { assertSnapshot, hash, inputHash, inspectRepository } from './inspect.js';
import { completeReconciledOperation, resumeCheckpointCapture, withRepositoryOperation } from './coordination.js';
export function validateFile(path:string){if(!path||isAbsolute(path)||path.includes('\\')||path.includes('\0')||path.split('/').some(x=>!x||x==='.'||x==='..'||x.toLowerCase()==='.git'))throw new AppError('INVALID_REPOSITORY_FILE','Select an ordinary relative repository file');}
export async function safeRepositoryPath(root:string,path:string):Promise<string>{validateFile(path);if(await realpath(root)!==root)throw new AppError('REPOSITORY_CHANGED','Repository root changed');let current=root;for(const part of path.split('/')){current=join(current,part);try{if((await lstat(current)).isSymbolicLink())throw new AppError('INVALID_REPOSITORY_FILE','Repository paths cannot follow symlinks');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}return current;}
async function selectedFile(root:string,path:string):Promise<{bytes:Buffer;mode:string}|null>{
 validateFile(path);let current=root;for(const component of path.split('/')){current=join(current,component);try{const info=await lstat(current);if(info.isSymbolicLink()||!info.isFile()&&!info.isDirectory())throw new AppError('INVALID_REPOSITORY_FILE','Symlinks and special files require an explicit external checkpoint');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
 const info=await lstat(current);if(!info.isFile())throw new AppError('INVALID_REPOSITORY_FILE','Select files, not directories');return {bytes:await readFile(current),mode:info.mode&0o111?'100755':'100644'};
}
export function checkpointOperations(state:StateContext,git:GitClient){
 const run=async(repo:RepositoryRef,args:string[],options:GitRunOptions={})=>{const r=await runRepositoryGit(state,git,repo.path,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false',...args],options);if(r.exitCode)throw new AppError('GIT_FAILED','Repository plumbing failed; partial evidence retained');return r.stdout.trim();};
 async function checkpoint(input:CheckpointInput,requestId:string):Promise<Checkpoint>{
  if((input.parent!==undefined||input.files.some(f=>'content' in f))&&input.purpose!=='vault_batch')throw new AppError('INVALID_REPOSITORY_FILE','Immutable batch content is restricted to vault capture');for(const f of input.files)validateFile(f.path);if(new Set(input.files.map(x=>x.path)).size!==input.files.length)throw new AppError('INVALID_REPOSITORY_FILE','Duplicate file selection');
  for(const f of input.files){if((await git.run(input.repo.path,['check-ignore','--quiet','--',f.path])).exitCode===0)throw new AppError('INVALID_REPOSITORY_FILE','Ignored content is not checkpoint eligible');}
  const digest=inputHash(input);const id=hash(input.repo.id+'\0'+requestId);const prior=await state.store.read<{inputHash:string;checkpoint:Checkpoint}>('repository-checkpoint',id);
  if(prior){if(prior.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Checkpoint input changed');if(await run(input.repo,['rev-parse',prior.checkpoint.ref])!==prior.checkpoint.commit)throw new AppError('REPOSITORY_CHANGED','Checkpoint ref changed');const operation=await state.store.read<{state:string}>('repository-operation',requestId);if(operation&&['running','uncertain'].includes(operation.state))return completeReconciledOperation(state,input.repo,requestId,prior.checkpoint);return prior.checkpoint;}
  const intent=await state.store.read<{inputHash:string;checkpoint:Checkpoint}>('repository-checkpoint-intent',id);
  if(intent){if(intent.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Checkpoint input changed');await assertRepositoryChildrenStopped(state);const observed=await git.run(input.repo.path,['rev-parse','--verify','--quiet',intent.checkpoint.ref]);if(observed.exitCode===1)return resumeCheckpointCapture(state,input.repo,requestId,digest,async()=>{await run(input.repo,['update-ref',intent.checkpoint.ref,intent.checkpoint.commit,'0'.repeat(intent.checkpoint.commit.length)]);await state.store.transact(tx=>tx.put('repository-checkpoint',id,intent));return intent.checkpoint;});if(observed.exitCode||observed.stdout.trim()!==intent.checkpoint.commit)throw new AppError('REPOSITORY_UNCERTAIN','Checkpoint ref is not the intended commit');await state.store.transact(tx=>tx.put('repository-checkpoint',id,intent));return completeReconciledOperation(state,input.repo,requestId,intent.checkpoint);}
  const capture=async(before:RepositorySnapshot):Promise<Checkpoint>=>{
   let plan=await state.store.read<{inputHash:string;date:string}>('repository-capture-plan',id);if(plan&&plan.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Capture plan changed');if(!plan){plan={inputHash:digest,date:new Date(state.clock.now()).toISOString()};await state.store.transact(tx=>tx.put('repository-capture-plan',id,plan!));}
   const staging=join(state.stateDir,'staging','checkpoint-'+id);await mkdir(staging,{recursive:true,mode:0o700});const index=join(staging,'index');await rm(index,{force:true});const options={privateIndex:index};
   const parent=input.parent===undefined?before.head:input.parent;if(parent&&(await run(input.repo,['cat-file','-t',parent]))!=='commit')throw new AppError('INVALID_CHECKPOINT','Batch parent must be a commit');await run(input.repo,parent?['read-tree',parent]:['read-tree','--empty'],options);
   for(const f of input.files){const selected='content' in f?(f.content===null?null:{bytes:Buffer.from(f.content!),mode:(await selectedFile(input.repo.path,f.path))?.mode??'100644'}):await selectedFile(input.repo.path,f.path);if((selected?hash(selected.bytes):null)!==f.hash)throw new AppError('REPOSITORY_CHANGED','Selected file changed before capture');
    if(selected){const preimage=join(staging,hash(f.path)+'.preimage');try{const fd=await open(preimage,'wx',0o600);try{await fd.writeFile(selected.bytes);await fd.sync();}finally{await fd.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(!selected.bytes.equals(await readFile(preimage)))throw new AppError('REPOSITORY_CHANGED','Retained preimage differs');}
     const blob=await run(input.repo,['hash-object','-w','--stdin'],{input:selected.bytes});await run(input.repo,['update-index','--add','--cacheinfo',selected.mode,blob,f.path],options);
    }else await run(input.repo,['update-index','--force-remove','--',f.path],options);
   }
   const tree=await run(input.repo,['write-tree'],options);
   const checked=(await inspectRepository(git,input.repo.path)).snapshot!;assertSnapshot(checked,before);
   const commit=await run(input.repo,['-c','user.name=Lorecrew','-c','user.email=lorecrew@localhost','commit-tree',tree,...parent?['-p',parent]:[],'-m',input.message],{commitDate:plan.date});const ref='refs/lorecrew/checkpoints/'+id;
   const cp:Checkpoint={id,repositoryId:input.repo.id,commit,ref,parent,files:input.files.map(({path,hash})=>({path,hash}))};
   await state.store.transact(tx=>tx.put('repository-checkpoint-intent',id,{inputHash:digest,checkpoint:cp}));
   await run(input.repo,['update-ref',ref,commit,'0'.repeat(commit.length)]);
   await state.store.transact(tx=>tx.put('repository-checkpoint',id,{inputHash:digest,checkpoint:cp}));return cp;
  };
  const pending=await state.store.read<{state:string}>('repository-operation',requestId);if(pending&&['uncertain','running'].includes(pending.state)&&await state.store.read('repository-capture-plan',id))return resumeCheckpointCapture(state,input.repo,requestId,digest,capture);
  return withRepositoryOperation(state,input.repo,{requestId,kind:'checkpoint',inputHash:digest,expected:input.expected},({before})=>capture(before));
 }
 async function adoptCheckpoint(repo:RepositoryRef,cp:Checkpoint,expected:RepositorySnapshot,requestId:string,authorize?:()=>Promise<void>):Promise<{commit:string;state:'adopted'|'deferred'}>{
  if(cp.repositoryId!==repo.id)throw new AppError('INVALID_CHECKPOINT','Checkpoint belongs to another repository');
  const operation=await state.store.read<{inputHash:string;state:string;result:{commit:string;state:'adopted'|'deferred'}}>('repository-operation',requestId);if(operation?.state==='completed'){if(operation.inputHash!==inputHash({repo,cp,expected}))throw new AppError('IDEMPOTENCY_CONFLICT','Adoption input changed');return operation.result;}
  const adoption=await state.store.read<{repo:RepositoryRef;checkpoint:Checkpoint;before:RepositorySnapshot;index:string;stage:string;indexHash:string}>('repository-adoption',requestId);
  if(adoption){if(inputHash({repo,cp,expected})!==inputHash({repo:adoption.repo,cp:adoption.checkpoint,expected:adoption.before}))throw new AppError('IDEMPOTENCY_CONFLICT','Adoption input changed');await assertRepositoryChildrenStopped(state);const head=await run(repo,['rev-parse','HEAD']);if(head!==cp.commit)throw new AppError('REPOSITORY_UNCERTAIN','Branch no longer equals the captured adoption');const candidate=join(state.stateDir,'staging','adopt-'+cp.id);if(hash(await readFile(candidate))!==adoption.indexHash)throw new AppError('REPOSITORY_UNCERTAIN','Retained index changed');const actual=await inspectRepository(git,repo.path);if(actual.snapshot?.worktreeHash!==expected.worktreeHash)throw new AppError('REPOSITORY_CHANGED','Worktree changed after adoption');const oldIndex=await readFile(adoption.index).catch(()=>Buffer.alloc(0));if(hash(oldIndex)!==expected.indexHash&&hash(oldIndex)!==adoption.indexHash)throw new AppError('REPOSITORY_CHANGED','External index changed');if(hash(oldIndex)!==adoption.indexHash){await authorize?.();const pending=await readFile(adoption.index+'.lock').catch(()=>null);if(!pending||hash(pending)!==adoption.indexHash)throw new AppError('REPOSITORY_UNCERTAIN','Native lock no longer equals retained candidate');await rename(adoption.index+'.lock',adoption.index);}return completeReconciledOperation(state,repo,requestId,{commit:cp.commit,state:'adopted' as const});}
  return withRepositoryOperation(state,repo,{requestId,kind:'adopt',inputHash:inputHash({repo,cp,expected}),expected},async({before})=>{
   if(before.head!==cp.parent||!before.branch)return {commit:cp.commit,state:'deferred'};
   const diff=await git.run(repo.path,before.head?['diff-index','--cached','--quiet',before.head,'--']:['ls-files']);
   if(diff.exitCode||!before.head&&diff.stdout)return {commit:cp.commit,state:'deferred'};
   if(await run(repo,['rev-parse',cp.ref])!==cp.commit)throw new AppError('REPOSITORY_CHANGED','Selected checkpoint ref changed');
   for(const f of cp.files){const selected=await selectedFile(repo.path,f.path);if((selected?hash(selected.bytes):null)!==f.hash)throw new AppError('REPOSITORY_CHANGED','Selected file changed after capture');}
   const prepared=await prepareRepositoryIndex(state,git,repo,cp,before);let preparedIntent=false;
   try{await authorize?.();await state.store.transact(tx=>tx.put('repository-adoption',requestId,{repo,checkpoint:cp,before,index:prepared.index,stage:'prepared',indexHash:prepared.indexHash,lockIdentity:prepared.lockIdentity}));preparedIntent=true;
    await advanceRepositoryIndex(state,git,repo,cp,before,prepared);await state.store.transact(tx=>tx.put('repository-adoption',requestId,{repo,checkpoint:cp,before,index:prepared.index,stage:'completed',indexHash:prepared.indexHash,lockIdentity:prepared.lockIdentity}));return {commit:cp.commit,state:'adopted'};
   }finally{await prepared.lock.close();if(!preparedIntent)await discardPreparedIndex(prepared);}

  });
 }
 return {checkpoint,adoptCheckpoint};
}
