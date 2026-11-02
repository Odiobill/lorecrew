import { lstat, mkdir, open, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError } from '../contracts/base.js';
import type { StateContext } from '../instance/state.js';
import type { GitClient } from '../git/client.js';
import type { CheckpointInput, RepositoryClone, RepositoryCreate, RepositoryRef, RepositorySnapshot } from './types.js';
import { withRepositoryDestination,withRepositoryOperation,withStoppedCloneOperation } from './coordination.js';
import {checkoutClone} from './clone-checkout.js';
import { hash, inputHash, inspectRepository } from './inspect.js';
import { checkpointOperations, safeRepositoryPath, validateFile } from './checkpoint.js';
import { runRepositoryGit } from './git.js';
interface Identity {dev:number;ino:number}
interface Creation {id:string;hash:string;kind:'create'|'clone';repo:RepositoryRef;parent:Identity;directory?:Identity;phase:'planned'|'directory'|'cloning'|'git'|'scaffold'|'checkpoint'|'ready';checkpointId?:string;checkpointInput?:CheckpointInput;adoptionExpected?:RepositorySnapshot;cloneBranch?:string;cloneHead?:string|null;cloneProbe?:Identity;cloneInitialized?:boolean;existingGit?:boolean}
const queues=new WeakMap<object,Promise<unknown>>();
const identity=(s:{dev:number;ino:number}):Identity=>({dev:s.dev,ino:s.ino});
const same=(a:Identity,b:Identity)=>a.dev===b.dev&&a.ino===b.ino;
async function exists(path:string){try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}
export function validateRemote(url:string){
 const invalid=()=>new AppError('INVALID_REMOTE','Use a credential-free HTTP(S)/SSH Git URL or an absolute local repository path');
 if(!url||url!==url.trim()||/[\0\r\n]/.test(url)||url.startsWith('-'))throw invalid();
 if(isAbsolute(url)){if(resolve(url)!==url)throw invalid();return;}
 if(/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(url)&&!url.split('/').some(p=>p==='..'))return;
 let parsed:URL;try{parsed=new URL(url);}catch{throw invalid();}
 if(!['http:','https:','ssh:'].includes(parsed.protocol)||parsed.password||parsed.search||parsed.hash||/[\s?#]/.test(url)||parsed.username&&(parsed.protocol!=='ssh:'||!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(parsed.username)))throw invalid();
}
export function creationOperations(state:StateContext,git:GitClient){
 const checkpoints=checkpointOperations(state,git);
 const serial=<T>(fn:()=>Promise<T>)=>{const p=(queues.get(state.store)??Promise.resolve()).then(fn);queues.set(state.store,p.catch(()=>{}));return p;};
 async function createOrClone(input:RepositoryCreate|RepositoryClone,requestId:string,kind:'create'|'clone'):Promise<RepositoryRef>{return serial(async()=>{
  if(!requestId)throw new AppError('INVALID_REQUEST','A stable creation request is required');
  if(kind==='clone')validateRemote((input as RepositoryClone).url);
  if(kind==='create')for(const f of (input as RepositoryCreate).scaffold)validateFile(f.path);
  const parent=await realpath(input.parentPath);if(parent!==input.parentPath||input.repo.path!==join(parent,input.folderName))throw new AppError('INVALID_DESTINATION','Repository destination changed');
  if(input.repo.path===state.stateDir||input.repo.path.startsWith(state.stateDir+'/')||state.stateDir.startsWith(input.repo.path+'/'))throw new AppError('INVALID_DESTINATION','Repository cannot overlap private state');
  const digest=inputHash(input);const key=hash(requestId);let saved=await state.store.read<Creation>('repository-creation',key);if(saved&&(saved.hash!==digest||saved.kind!==kind))throw new AppError('IDEMPOTENCY_CONFLICT','Creation request input changed');
  if(saved?.phase==='ready'){const actual=await lstat(input.repo.path);if(!saved.directory||!same(identity(actual),saved.directory)||(await inspectRepository(git,input.repo.path)).kind!=='git')throw new AppError('REPOSITORY_CHANGED','Saved repository destination changed');return saved.repo;}
  return withRepositoryDestination(state,{parentPath:parent,folderName:input.folderName,requestId,inputHash:digest},async()=>{
   // Re-read under the destination gate: another state context may have completed its intent.
   saved=await state.store.read<Creation>('repository-creation',key);if(saved&&(saved.hash!==digest||saved.kind!==kind))throw new AppError('IDEMPOTENCY_CONFLICT','Creation request input changed');
   const parentInfo=identity(await lstat(parent));if(saved&&!same(saved.parent,parentInfo))throw new AppError('REPOSITORY_CHANGED','Parent directory identity changed');
   let record:Creation=saved??{id:key,hash:digest,kind,repo:input.repo,parent:parentInfo,phase:'planned'};
   const save=()=>state.store.transact(tx=>tx.put('repository-creation',key,record));
   const target=await exists(input.repo.path);const marker=join(input.repo.path,'.lorecrew-setup-owner.json');
   if(!saved){
    if(target?.isDirectory()&&!target.isSymbolicLink()&&kind==='create'&&(await readdir(input.repo.path)).every(n=>n==='.git')){const inspected=await inspectRepository(git,input.repo.path);if(inspected.kind==='git'&&inspected.snapshot?.head===null&&!(await git.run(input.repo.path,['ls-files'])).stdout)record.existingGit=true;}
    if(target&&(!target.isDirectory()||target.isSymbolicLink()||(await readdir(input.repo.path)).length&&!record.existingGit))throw new AppError('REPOSITORY_NOT_EMPTY','Existing destination content was preserved');
    // Never initialize within an enclosing repository, even an empty nested directory.
    if((await git.run(parent,['rev-parse','--show-toplevel'])).exitCode===0)throw new AppError('INVALID_DESTINATION','Choose a destination outside another Git repository');
    await save();
   }
   if(record.directory){if(!target?.isDirectory()||target.isSymbolicLink()||!same(identity(target),record.directory)||await realpath(input.repo.path)!==input.repo.path)throw new AppError('REPOSITORY_CHANGED','Repository destination was substituted');}
   else{
    if(target&&(await readdir(input.repo.path)).length&&!record.existingGit)throw new AppError('REPOSITORY_UNCERTAIN','Interrupted destination has unconfirmed content; preserve it for explicit repair');
    if(!target)await mkdir(input.repo.path,{mode:0o700});
    const fd=await open(marker,'wx',0o600);try{await fd.writeFile(JSON.stringify({requestId,instanceId:state.instanceId,id:record.id}));await fd.sync();}finally{await fd.close();}
    record.directory=identity(await lstat(input.repo.path));record.phase='directory';await save();for(const path of [parent,input.repo.path]){const dir=await open(path,'r');try{await dir.sync();}finally{await dir.close();}}
   }
   const verify=async()=>{const now=await lstat(input.repo.path);if(!record.directory||!now.isDirectory()||now.isSymbolicLink()||!same(identity(now),record.directory)||await realpath(input.repo.path)!==input.repo.path)throw new AppError('REPOSITORY_CHANGED','Repository destination was substituted');};
   const run=async(cwd:string,args:string[])=>{const r=await runRepositoryGit(state,git,cwd,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args]);if(cwd===input.repo.path)await verify();if(r.exitCode)throw new AppError('GIT_FAILED','Repository creation interrupted; destination and intent retained');return r.stdout.trim();};
   if(kind==='clone'){
    const cloneStage=async(stage:'metadata'|'checkout',work:()=>Promise<void>)=>{const id=requestId+':clone:'+stage,operation=await state.store.read<{state:string}>('repository-operation',id);if(operation&&['running','uncertain'].includes(operation.state))return withStoppedCloneOperation(state,input.repo,id,key,stage,work);return withRepositoryOperation(state,input.repo,{kind:'clone',requestId:id,inputHash:inputHash({creation:record.hash,stage})},work);};
    if(record.phase==='directory'){
     const probe=join(state.stateDir,'staging','clone-'+key);let info=await exists(probe);
     if(record.cloneProbe){if(!info?.isDirectory()||info.isSymbolicLink()||!same(identity(info),record.cloneProbe))throw new AppError('REPOSITORY_CHANGED','Clone staging identity changed');}
     else{if(info)throw new AppError('REPOSITORY_UNCERTAIN','Unknown clone staging data retained');await mkdir(probe,{mode:0o700});info=await lstat(probe);record.cloneProbe=identity(info);await save();}
     if(!(await readdir(probe)).length)await run(parent,['clone','--bare','--template=','--no-recurse-submodules','--',(input as RepositoryClone).url,probe]);
     const endpoint=await run(probe,['remote','get-url','origin']);if(endpoint!==(input as RepositoryClone).url)throw new AppError('REPOSITORY_CHANGED','Clone staging endpoint changed');
     const branch=await run(probe,['symbolic-ref','--short','HEAD']);if((await git.run(parent,['check-ref-format','--branch',branch])).exitCode)throw new AppError('INVALID_REMOTE','Remote default branch is invalid');
     const head=await git.run(probe,['rev-parse','--verify','HEAD']);
     record.cloneBranch=branch;record.cloneHead=head.exitCode?null:head.stdout.trim();record.phase='cloning';await save();
    }
    if(record.phase==='cloning'){
     if(!record.cloneInitialized){if((await inspectRepository(git,input.repo.path)).kind==='git')throw new AppError('REPOSITORY_UNCERTAIN','Unconfirmed Git initialization was preserved');await run(input.repo.path,['init','--template=','--initial-branch='+record.cloneBranch!]);record.cloneInitialized=true;await save();}
    }
    if(record.phase==='cloning'||record.phase==='git'&&record.cloneInitialized){await cloneStage('metadata',async()=>{
     const snapshot=(await inspectRepository(git,input.repo.path)).snapshot;if(!snapshot||snapshot.branch!==record.cloneBranch||snapshot.head!==null&&snapshot.head!==record.cloneHead)throw new AppError('REPOSITORY_CHANGED','Clone branch changed');
     const current=await git.run(input.repo.path,['remote','get-url','origin']);
     if(current.exitCode)await run(input.repo.path,['remote','add','origin',(input as RepositoryClone).url]);else if(current.stdout.trim()!==(input as RepositoryClone).url)throw new AppError('REPOSITORY_CHANGED','Clone destination endpoint changed');
     if(record.cloneHead){
      if((await git.run(input.repo.path,['cat-file','-e',record.cloneHead+'^{commit}'])).exitCode)await run(input.repo.path,['fetch','--no-tags','--no-write-fetch-head','--',(input as RepositoryClone).url,record.cloneHead]);
      const branchRef='refs/heads/'+record.cloneBranch!;const existing=await git.run(input.repo.path,['rev-parse','--verify',branchRef]);
      if(existing.exitCode)await run(input.repo.path,['update-ref',branchRef,record.cloneHead,'0'.repeat(record.cloneHead.length)]);else if(existing.stdout.trim()!==record.cloneHead)throw new AppError('REPOSITORY_CHANGED','Clone branch changed');
      await run(input.repo.path,['config','branch.'+record.cloneBranch!+'.remote','origin']);await run(input.repo.path,['config','branch.'+record.cloneBranch!+'.merge',branchRef]);
     }
     record.phase='git';await save();
    });record=(await state.store.read<Creation>('repository-creation',key))!;
    }
    if(record.phase==='git'){
     await cloneStage('checkout',()=>checkoutClone(state,git,input.repo,record.cloneHead??null,record.cloneBranch!,requestId+':clone:checkout'));
     record.phase='ready';await save();await rm(marker,{force:true});return input.repo;
    }
   }else{
    if(record.phase==='directory'){if(!record.existingGit)await run(input.repo.path,['init','--template=','--initial-branch=main']);record.phase='git';await save();}
    if(record.phase==='git'){
     for(const file of (input as RepositoryCreate).scaffold){await verify();const path=await safeRepositoryPath(input.repo.path,file.path);await mkdir(join(path,'..'),{recursive:true});try{const fd=await open(path,'wx',0o644);try{await fd.writeFile(file.content);await fd.sync();}finally{await fd.close();}}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await readFile(path,'utf8')!==file.content)throw new AppError('REPOSITORY_CHANGED','Scaffold content changed; preserved');}}
     record.phase='scaffold';await save();
    }
    if(record.phase==='scaffold'){
     const snapshot=(await inspectRepository(git,input.repo.path)).snapshot;if(!snapshot)throw new AppError('INVALID_GIT_PROJECT','Repository metadata changed');
     record.checkpointInput??={repo:input.repo,expected:snapshot,files:(input as RepositoryCreate).scaffold.map(f=>({path:f.path,hash:hash(f.content)})),message:'Initialize '+input.repo.kind,purpose:'initial'};await save();const cp=await checkpoints.checkpoint(record.checkpointInput,requestId+':initial');record.checkpointId=cp.id;record.phase='checkpoint';await save();
    }
    if(record.phase==='checkpoint'){
     const cp=(await state.store.read<{checkpoint:import('./types.js').Checkpoint}>('repository-checkpoint',record.checkpointId!))!.checkpoint;const snapshot=(await inspectRepository(git,input.repo.path)).snapshot!;
     record.adoptionExpected??=snapshot;await save();const result=await checkpoints.adoptCheckpoint(input.repo,cp,record.adoptionExpected,requestId+':initial-adopt');if(result.state!=='adopted')throw new AppError('REPOSITORY_CHANGED','Initial adoption deferred; preserve the external index');record.phase='ready';await save();await rm(marker,{force:true});return input.repo;
    }
   }
   return input.repo;
  });
 });}
 return {create:(input:RepositoryCreate,key:string)=>createOrClone(input,key,'create'),clone:(input:RepositoryClone,key:string)=>createOrClone(input,key,'clone')};
}
