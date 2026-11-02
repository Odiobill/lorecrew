import type {StateContext} from '../instance/state.js';
import type {GitClient} from '../git/client.js';
import type {WorkspaceRecord} from '../workspaces/types.js';
import type {TaskRecord} from '../team/types.js';
import type {Checkpoint,PublicationInput,PublicationReceipt,RemoteTarget,RepositoryProblem,RepositoryRef,RepositorySnapshot} from './types.js';
import {hash,inputHash,inspectRepository} from './inspect.js';
import {putRepositoryProblem} from './problems.js';

interface Capture {requestId:string;kind:string;inputHash:string;repository:RepositoryRef;before?:RepositorySnapshot;state:string}
interface Publication {inputHash:string;input:PublicationInput;receipt:PublicationReceipt}

/** Read-only Git evidence from this project's managed work, never a publication trigger. */
export async function projectStatus(state:StateContext,git:GitClient,repo:RepositoryRef,primary:RepositorySnapshot,target?:RemoteTarget):Promise<{pending:boolean}>{
 if(repo.kind!=='project')return {pending:false};
 const key=inputHash({kind:repo.kind,id:repo.id}),origin='project-status:'+key;
 const run=(path:string,args:string[])=>git.run(path,['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args]);
 const ancestor=async(a:string,b:string)=>a===b||(await run(repo.path,['merge-base','--is-ancestor',a,b])).exitCode===0;
 const wanted=new Set<string>(),paths=new Map<string,WorkspaceRecord|undefined>(),conditions=new Map<string,unknown[]>();
 let pending=false;
 const attention=(code:string,evidence:unknown)=>conditions.set(code,[...conditions.get(code)??[],evidence]);
 const retired=async(kind:string,id:string)=>!!await state.store.read('repository-retired-execution',JSON.stringify([kind,id]));
 for(const workspace of await state.store.list<WorkspaceRecord>('workspace')){
  if(workspace.projectId!==repo.id||await retired('workspace',workspace.id))continue;
  if(!workspace.git){attention('MIGRATION_REQUIRED',workspace.id);continue;}
  paths.set(workspace.path,workspace);
 }
 for(const operation of await state.store.list<Capture>('repository-operation')){
  if(operation.kind!=='checkpoint'||operation.repository.kind!==repo.kind||operation.repository.id!==repo.id)continue;
  if(operation.before&&operation.before.commonDir!==primary.commonDir)continue;
  const saved=await state.store.read<{inputHash:string;checkpoint:Checkpoint}>('repository-checkpoint',hash(repo.id+'\0'+operation.requestId));
  if(!saved){if(operation.state!=='blocked')pending=true;continue;}
  const cp=saved.checkpoint;
  const actual=await run(repo.path,['rev-parse','--verify','--quiet',cp.ref]);
  if(saved.inputHash!==operation.inputHash||cp.repositoryId!==repo.id||cp.id!==hash(repo.id+'\0'+operation.requestId)||cp.ref!=='refs/lorecrew/checkpoints/'+cp.id||actual.exitCode||actual.stdout.trim()!==cp.commit){attention('REPOSITORY_CHANGED',operation.requestId);continue;}
  wanted.add(cp.commit);
  if(operation.repository.path!==repo.path&&!paths.has(operation.repository.path))paths.set(operation.repository.path,undefined);
 }
 for(const [path,workspace] of paths){
  if(workspace?.state==='creating'){pending=true;continue;}
  const view=await inspectRepository(git,path),snapshot=view.snapshot;
  if(!snapshot||snapshot.commonDir!==primary.commonDir||workspace?.branch&&workspace.branch!==snapshot.branch){attention('REPOSITORY_CHANGED',{path,workspace:workspace?.id});continue;}
  if(snapshot.busy||workspace?.state==='failed'){attention('REPOSITORY_BUSY',{path,busy:snapshot.busy??workspace?.state});continue;}
  if(snapshot.head)wanted.add(snapshot.head);
  const dirty=await run(path,['status','--porcelain=v1','-z','--untracked-files=all']);
  if(dirty.exitCode){attention('REPOSITORY_UNAVAILABLE',path);continue;}
  if(workspace?.state==='active')pending=true;
  else if(dirty.stdout)attention('CHECKPOINT_SELECTION_REQUIRED',{path,head:snapshot.head,index:snapshot.indexHash,worktree:snapshot.worktreeHash});
 }
 for(const task of await state.store.list<TaskRecord>('team-task'))if(task.projectId===repo.id&&!['completed','cancelled','failed'].includes(task.state)&&!await retired('team-task',task.id))pending=true;
 const anchors=new Set<string>();
 if(target){
  const acceptedKey=(ref:string)=>inputHash({repository:key,endpoint:target.endpoint,ref});
  const main=await state.store.read<{commit:string|null}>('accepted-remote-head',acceptedKey(target.ref));if(main?.commit)anchors.add(main.commit);
  for(const publication of await state.store.list<Publication>('repository-publication')){
   const input=publication.input;
   if(!publication.receipt.confirmed||input.repo.kind!==repo.kind||input.repo.id!==repo.id||inputHash(input.target)!==inputHash(target)||publication.inputHash!==inputHash(input)||inputHash(publication.receipt.refs)!==inputHash(input.refs))continue;
   for(const ref of input.refs){const accepted=await state.store.read<{commit:string|null}>('accepted-remote-head',acceptedKey(ref.remoteRef));if(accepted?.commit&&await ancestor(ref.commit,accepted.commit))anchors.add(accepted.commit);}
  }
 }
 for(const commit of wanted){let published=false;for(const anchor of anchors)if(await ancestor(commit,anchor)){published=true;break;}if(!published)pending=true;}
 // Own scoped conditions may resolve after explicit selection. Never clear another producer's diagnostic.
 const previous=(await state.store.list<RepositoryProblem>('repository-problem')).filter(p=>p.operationId===origin);
 await state.store.transact(tx=>{
  for(const [code,evidence] of conditions){const problem:RepositoryProblem={id:inputHash({repository:key,origin,code}),repositoryKind:repo.kind,repositoryId:repo.id,operationId:origin,code,revision:inputHash(evidence),state:'active'};putRepositoryProblem(tx,problem);}
  for(const held of previous)if(held.state==='active'&&!conditions.has(held.code)){const current=tx.get<RepositoryProblem>('repository-problem',held.id);if(current?.operationId===origin&&current.revision===held.revision)putRepositoryProblem(tx,{...current,state:'resolved'});}
 });
 return {pending};
}
