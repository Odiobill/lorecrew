import {putRepositoryProblem} from '../repositories/problems.js';
import type {HandoffState,Assignment} from './types.js';
import type {RepositoryProblem} from '../repositories/types.js';
import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AppError,type Json} from '../contracts/base.js';
import type {InstanceContext} from '../instance/open.js';
import type {Vault} from '../vault/types.js';
import type {Runtime,SessionRecord,EffectRecord} from '../runtime/types.js';
import type {TaskRecord} from '../team/types.js';
import type {Tx} from '../storage/store.js';
import type {ProjectBinding,WorkspaceRecord} from '../workspaces/types.js';
import type {RepositoryService} from '../repositories/service.js';
import type {Checkpoint,CheckpointInput,PublicationInput,PublicationReceipt,RemoteTarget,RepositoryRef,RepositorySnapshot} from '../repositories/types.js';
import {hash,inputHash} from '../repositories/inspect.js';
import {safeRepositoryPath,validateFile} from '../repositories/checkpoint.js';
import {GitClient} from '../git/client.js';
import {assertAuthorityDomain,authorityScope,type AuthorityScope} from './authority-domain.js';
import {openConfiguredOwnership} from './configured-ownership.js';
import {component} from '../export/history.js';
import {redact} from '../export/redact.js';
import {openSyncProblems} from '../sync/problems.js';
export interface ProjectCheckpoint {id:string;projectId:string;generation:number;refs:Array<{taskId?:string;commit:string;ref:string;review:'integrated'|'unreviewed'}>;contextPaths:string[]}
export interface ProjectCheckpointFile {taskId?:string;path:string;hash:string|null}
export interface ProjectCheckpointInput {projectId:string;taskIds:string[];expectedGeneration:number;files:ProjectCheckpointFile[];handoffId?:string}
export interface ProjectCheckpointRequest {id:string;taskId:string;projectId:string;generation:number;authority?:AuthorityScope;state:'queued'|'waiting_boundary'|'selection_required'|'completed'|'blocked'|'retired';lifecycleTaskId?:number;checkpointId?:string;unresolved?:Array<{path:string;reason:string}>;diagnostic?:string}
/** Only the stopped-handoff coordinator creates this private, bounded permit. */
export interface HandoffCheckpointPermit {version:1;id:string;projectId:string;generation:number;authority:AuthorityScope;taskIds:string[];allowPrimary:boolean;boundaryRevision:string}
interface Step {taskId?:string;repo:RepositoryRef;files:ProjectCheckpointFile[];input?:CheckpointInput;checkpoint?:Checkpoint;adoptionExpected?:RepositorySnapshot;adopted?:boolean}
interface Intent {id:string;inputHash:string;input:ProjectCheckpointInput;authority:AuthorityScope;boundaryRevision:string;steps:Step[];checkpoint?:ProjectCheckpoint}
export function queueProjectCheckpoint(tx:Tx,task:TaskRecord){if(tx.get('repository-retired-execution',JSON.stringify(['team-task',task.id]))||tx.get('project-checkpoint-request',task.id))return;tx.put('project-checkpoint-request',task.id,{id:task.id,taskId:task.id,projectId:task.projectId,generation:task.generation,...task.authority?{authority:task.authority}:{},state:'queued'});}
export function openProjectCheckpoints({ctx,vault,repositories,runtime}:{ctx:InstanceContext;vault:Vault;repositories:RepositoryService;runtime:Runtime}){
 const git=new GitClient(),ownership=openConfiguredOwnership(ctx,git);let tail=Promise.resolve(),draining:Promise<void>|undefined,closed=false;
 const serial=<T>(work:()=>Promise<T>)=>{const result=tail.then(work);tail=result.then(()=>{},()=>{});return result;};
 const save=(requestId:string,intent:Intent)=>ctx.store.transact(tx=>tx.put('project-checkpoint-intent',requestId,intent));
 function normalized(input:ProjectCheckpointInput){return {...input,taskIds:[...input.taskIds].sort(),files:[...input.files].sort((a,b)=>(a.taskId??'').localeCompare(b.taskId??'')||a.path.localeCompare(b.path))};}
 async function authorize(input:Pick<ProjectCheckpointInput,'projectId'|'taskIds'|'expectedGeneration'|'handoffId'>){
  const binding=await assertAuthorityDomain(ctx),scope=authorityScope(binding);
  if(input.handoffId){
   const permit=await ctx.store.read<HandoffCheckpointPermit>('project-checkpoint-permit',input.handoffId),handoff=await ownership.inspectHandoff(input.projectId),grant=await ctx.store.read<{assignment:{ownerId:string;generation:number};authority?:AuthorityScope}>('assignment-grants',input.projectId);
   if(!permit||permit.version!==1||permit.id!==input.handoffId||permit.projectId!==input.projectId||permit.generation!==input.expectedGeneration||inputHash(permit.authority)!==inputHash(scope)||input.taskIds.some(id=>!permit.taskIds.includes(id))||!input.taskIds.length&&!permit.allowPrimary||!handoff||handoff.transitionId!==input.handoffId||handoff.phase!=='closed'||!handoff.quiescenceProven||handoff.expectedGeneration!==input.expectedGeneration||grant?.assignment.ownerId!==ctx.instanceId||grant.assignment.generation!==input.expectedGeneration||inputHash(grant.authority??null)!==inputHash(scope))throw new AppError('INVALID_HANDOFF_PERMIT','The exact stopped handoff and selected work require a private confirmed permit');
   if(await boundary(input.projectId,permit.taskIds)!==permit.boundaryRevision)throw new AppError('INVALID_HANDOFF_PERMIT','The stopped handoff boundary changed; obtain fresh proof before selecting work');if(await ctx.store.read('assignment-revocations',JSON.stringify([input.projectId,input.expectedGeneration])))throw new AppError('OWNER_REVOKED','The source generation is retired');
  }else await ownership.assertOwner(input.projectId,input.expectedGeneration);
  return scope;
 }
 async function boundary(projectId:string,taskIds:string[]){if(!runtime.checkpointBoundary)throw new AppError('CHECKPOINT_PROOF_UNAVAILABLE','This runtime cannot establish a stopped checkpoint boundary');const proof=await runtime.checkpointBoundary(projectId,taskIds);if(!proof.quiescent)throw new AppError('NOT_QUIESCENT',proof.reason??'Task work is not positively stopped');return proof.revision;}
 async function binding(projectId:string){const value=await ctx.store.read<ProjectBinding>('project-binding',projectId);if(!value)throw new AppError('PROJECT_NOT_BOUND','Bind this project before checkpointing');const view=await repositories.inspect(value.path),entry=await lstat(value.path);if(!view.snapshot||!view.snapshot.head||!view.snapshot.branch||value.commonDir&&value.commonDir!==view.snapshot.commonDir||value.rootIdentity&&inputHash(value.rootIdentity)!==inputHash({dev:entry.dev,ino:entry.ino,uid:entry.uid}))throw new AppError('BINDING_CHANGED','The original project repository changed');return {binding:value,snapshot:view.snapshot};}
 async function steps(input:ProjectCheckpointInput):Promise<Step[]>{
  const base=await binding(input.projectId),scopes:Array<string|undefined>=input.taskIds.length?input.taskIds:[undefined];const result:Step[]=[];
  for(const taskId of scopes){let path=base.binding.path;
   if(taskId){const task=await ctx.store.read<TaskRecord>('team-task',taskId),session=task?await ctx.store.read<SessionRecord>('runtime-session',task.executingSessionId):undefined,workspace=task?await ctx.store.read<WorkspaceRecord>('workspace',task.workspaceId):undefined;if(!task||task.projectId!==input.projectId||task.generation!==input.expectedGeneration||!session||session.session.instanceId!==ctx.instanceId||!workspace||!workspace.git||workspace.state!=='released'||workspace.id!==session.workspaceId)throw new AppError('CHECKPOINT_SELECTION_REQUIRED','Select actual stopped task work from this project generation');path=workspace.path;const current=(await repositories.inspect(path)).snapshot;if(!current||current.commonDir!==base.snapshot.commonDir||current.branch!==workspace.branch)throw new AppError('REPOSITORY_CHANGED','The selected task repository or branch changed');}
   const files=input.files.filter(file=>file.taskId===taskId);for(const file of files)validateFile(file.path);
   result.push({...(taskId?{taskId}:{}),repo:{kind:'project',id:input.projectId,path},files});
  }
  if(input.files.some(file=>!scopes.includes(file.taskId)))throw new AppError('CHECKPOINT_SELECTION_REQUIRED','Each selected file must name its selected task, or the primary project scope');
  return result;
 }
 async function assertBoundary(intent:Intent){await authorize(intent.input);const revision=await boundary(intent.input.projectId,intent.input.taskIds);if(revision!==intent.boundaryRevision)throw new AppError('CHECKPOINT_BOUNDARY_CHANGED','Task, outcome or stop evidence changed; review a fresh selection');}
 async function createCore(raw:ProjectCheckpointInput,requestId:string):Promise<ProjectCheckpoint>{
  if(closed)throw new AppError('CHECKPOINT_WORKER_CLOSED','Checkpoint processing is stopped');
  if(!requestId||!Number.isSafeInteger(raw.expectedGeneration)||raw.expectedGeneration<1||new Set(raw.taskIds).size!==raw.taskIds.length||new Set(raw.files.map(f=>(f.taskId??'')+'\0'+f.path)).size!==raw.files.length)throw new AppError('INVALID_CHECKPOINT','Choose unique tasks/files and the expected generation');
  const input=normalized(raw),digest=inputHash(input);let intent=await ctx.store.read<Intent>('project-checkpoint-intent',requestId);if(intent&&intent.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Project checkpoint request input changed');if(intent?.checkpoint)return intent.checkpoint;
  const scope=await authorize(input),revision=await boundary(input.projectId,input.taskIds);
  if(!intent){intent={id:hash(ctx.instanceId+'\0'+requestId),inputHash:digest,input,authority:scope,boundaryRevision:revision,steps:await steps(input)};await save(requestId,intent);}else if(inputHash(intent.authority)!==inputHash(scope)||intent.boundaryRevision!==revision)throw new AppError('CHECKPOINT_BOUNDARY_CHANGED','The original checkpoint boundary is no longer current');
  for(const step of intent.steps){
   await assertBoundary(intent);
   if(!step.input){const expected=(await repositories.inspect(step.repo.path)).snapshot!;if(!expected)throw new AppError('GIT_REQUIRED','The selected Git worktree is unavailable');step.input={repo:step.repo,expected,files:step.files.map(({path,hash})=>({path,hash})),purpose:input.handoffId?'handoff':'task',message:'Save project checkpoint '+intent.id};await save(requestId,intent);}
   if(!step.checkpoint){step.checkpoint=await repositories.checkpoint(step.input,'project-capture:'+intent.id+':'+(step.taskId??'primary'));await save(requestId,intent);}
   await assertBoundary(intent);
   if(!step.adoptionExpected){step.adoptionExpected=(await repositories.inspect(step.repo.path)).snapshot!;await save(requestId,intent);}
   if(step.adopted===undefined){const adopted=await repositories.adoptCheckpoint(step.repo,step.checkpoint,step.adoptionExpected,'project-adopt:'+intent.id+':'+(step.taskId??'primary'),()=>assertBoundary(intent!));step.adopted=adopted.state==='adopted';await save(requestId,intent);}
  }
  await assertBoundary(intent);const primary=await binding(input.projectId),refs:ProjectCheckpoint['refs']=[];
  for(const step of intent.steps){const cp=step.checkpoint!;const integrated=(await git.run(primary.binding.path,['merge-base','--is-ancestor',cp.commit,primary.snapshot.head!])).exitCode===0;refs.push({...(step.taskId?{taskId:step.taskId}:{}),commit:cp.commit,ref:cp.ref,review:integrated?'integrated':'unreviewed'});}
  const contextPath='checkpoints/'+input.projectId+'/'+intent.id+'.md',reported=[];
  for(const taskId of input.taskIds){const task=(await ctx.store.read<TaskRecord>('team-task',taskId))!;const text=JSON.stringify(task.outcome??null),safe=redact(text,{literals:[ctx.stateDir,ctx.vaultDir,primary.binding.path]});const reports=(await ctx.store.list<{taskId:string;requestId:string}>('team-report')).filter(r=>r.taskId===taskId).map(r=>taskId+':'+r.requestId),executionReceipts=(await ctx.store.scan<{id:string}>('learning-execution',{field:'sessionId',value:task.executingSessionId})).map(r=>r.id),historyPaths=(await ctx.store.list<{path:string}>('export-file')).filter(r=>r.path.startsWith('history/'+component(ctx.instanceId)+'/'+component(task.executingSessionId)+'/')).map(r=>r.path);reported.push({taskId,state:task.state,reports,executionReceipts,historyPaths,outcome:safe.held?'Reported content held; original execution evidence remains local':task.outcome??null});}
  const metadata={type:'ProjectCheckpoint',title:'Local project work checkpoint',lorecrew:{id:'checkpoint:'+intent.id,originId:ctx.instanceId,projectId:input.projectId},checkpoint:{id:intent.id,generation:input.expectedGeneration,refs,reported}};
  const content='---\n'+JSON.stringify(metadata)+'\n---\n# Local work checkpoint\n\nThese are actual Git commits. Unreviewed task refs have not been merged into the primary branch. A commit does not establish that tests ran or passed.\n\n'+refs.map(ref=>'- `'+ref.ref+'` at `'+ref.commit+'` ('+ref.review+')').join('\n')+'\n';
  await vault.propose({id:'project-checkpoint-context:'+intent.id,path:contextPath,expectedRevision:null,actor:'process:checkpoint:'+ctx.instanceId,content});
  await assertBoundary(intent);const checkpoint:ProjectCheckpoint={id:intent.id,projectId:input.projectId,generation:input.expectedGeneration,refs,contextPaths:[contextPath]};intent.checkpoint=checkpoint;await ctx.store.transact(tx=>{tx.put('project-checkpoint',checkpoint.id,checkpoint);tx.put('project-checkpoint-intent',requestId,intent);});return checkpoint;
 }
 async function publishCore(input:{checkpointId:string;target:RemoteTarget;handoffId?:string},requestId:string){
  const cp=await ctx.store.read<ProjectCheckpoint>('project-checkpoint',input.checkpointId);if(!cp)throw new AppError('CHECKPOINT_NOT_FOUND','Choose an actual saved checkpoint');const taskIds=cp.refs.flatMap(ref=>ref.taskId?[ref.taskId]:[]),permission={projectId:cp.projectId,taskIds,expectedGeneration:cp.generation,...input.handoffId?{handoffId:input.handoffId}:{}};
  await authorize(permission);const base=await binding(cp.projectId),refs=cp.refs.map((ref,index)=>({localRef:ref.ref,commit:ref.commit,remoteRef:ref.review==='integrated'&&!ref.taskId?input.target.ref:'refs/heads/lorecrew/checkpoints/'+cp.id+'/'+(ref.taskId??String(index))}));
  const publication:PublicationInput={repo:{kind:'project',id:cp.projectId,path:base.binding.path},target:input.target,refs};const digest=inputHash({checkpointId:cp.id,target:input.target,...input.handoffId?{handoffId:input.handoffId}:{}}),prior=await ctx.store.read<{inputHash:string;input:PublicationInput}>('project-checkpoint-publication',requestId);if(prior&&prior.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Checkpoint publication input changed');if(!prior)await ctx.store.transact(tx=>tx.put('project-checkpoint-publication',requestId,{inputHash:digest,input:publication}));
  const receipt=await repositories.publish(prior?.input??publication,'project-publish:'+requestId,async()=>{await authorize(permission);});await ctx.store.transact(tx=>tx.put('project-checkpoint-publication-receipt',requestId,receipt));return receipt;
 }
 async function dirty(path:string){const result=await git.run(path,['--no-optional-locks','-c','core.fsmonitor=false','status','--porcelain=v1','-z','--untracked-files=all']);if(result.exitCode)throw new AppError('REPOSITORY_UNAVAILABLE','Task worktree status is unavailable');const paths:string[]=[];const records=result.stdout.split('\0').filter(Boolean);for(let i=0;i<records.length;i++){const entry=records[i]!,code=entry.slice(0,2);paths.push(entry.slice(3));if(/[RC]/.test(code)&&records[i+1])paths.push(records[++i]!);}return [...new Set(paths)];}
 async function drainCore(){if(closed)return;
  for(const request of await ctx.store.list<ProjectCheckpointRequest>('project-checkpoint-request')){
   const handoff=await ctx.store.read<HandoffState>('project-handoff',request.projectId),revoked=await ctx.store.read<{assignment:Assignment}>('assignment-revocations',JSON.stringify([request.projectId,request.generation])),proof=handoff?await ctx.store.read<{reference:unknown}>('checkpoint-handoff-transfer-proof',handoff.transitionId):undefined;
   if(handoff?.phase==='published'&&handoff.quiescenceProven&&handoff.expectedGeneration===request.generation&&handoff.assignment?.generation===request.generation+1&&handoff.assignment.ownerId===handoff.targetInstanceId&&handoff.targetInstanceId!==ctx.instanceId&&revoked?.assignment.ownerId===ctx.instanceId&&revoked.assignment.repositoryKey===handoff.assignment.repositoryKey&&handoff.assignment.checkpoint?.manifestId===handoff.transitionId&&inputHash(proof?.reference??null)===inputHash(handoff.assignment.checkpoint)){
    if(!runtime.checkpointBoundary||(await runtime.checkpointBoundary(request.projectId,[request.taskId])).quiescent!==true)continue;const problems=await ctx.store.list<RepositoryProblem>('repository-problem');await ctx.store.transact(tx=>{if(request.state!=='completed')tx.put('project-checkpoint-request',request.id,{...request,state:'retired',diagnostic:'OWNER_REVOKED'});for(const problem of problems)if(problem.repositoryKind==='project'&&problem.repositoryId===request.projectId&&problem.state==='active'&&['ADMISSION_CLOSED','OWNER_REVOKED'].includes(problem.code)&&problem.revision===inputHash({taskId:request.taskId,code:problem.code}))putRepositoryProblem(tx,{...problem,state:'resolved'});});continue;
   }
   if(!['queued','waiting_boundary'].includes(request.state))continue;
   const task=await ctx.store.read<TaskRecord>('team-task',request.taskId),session=task?await ctx.store.read<SessionRecord>('runtime-session',task.executingSessionId):undefined,workspace=task?await ctx.store.read<WorkspaceRecord>('workspace',task.workspaceId):undefined;
   if(!task||!session||!workspace)continue;
   try{
    const scope=await authorize({projectId:task.projectId,taskIds:[task.id],expectedGeneration:task.generation});if(!request.authority||inputHash(scope)!==inputHash(request.authority))throw new AppError('AUTHORITY_RETIRED','The terminal request belongs to a retired authority scope');
    await boundary(task.projectId,[task.id]);
    const witnessed=new Map<string,Set<string|null>>();for(const effect of await ctx.store.scan<EffectRecord>('runtime-effect',{field:'sessionId',value:session.session.id})){if(effect.state!=='settled')continue;for(const file of effect.checkpointFiles??[]){const versions=witnessed.get(file.path)??new Set<string|null>();versions.add(file.hash);witnessed.set(file.path,versions);}}
    const files:ProjectCheckpointFile[]=[],unresolved:Array<{path:string;reason:string}>=[];
    for(const path of await dirty(workspace.path)){validateFile(path);let digest:string|null=null;try{const bytes=await readFile(await safeRepositoryPath(workspace.path,path));digest=hash(bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(witnessed.get(path)?.has(digest))files.push({taskId:task.id,path,hash:digest});else unresolved.push({path,reason:'Select the task files to include; this change has no committed write/edit witness'});}
    let cp:ProjectCheckpoint|undefined;if(files.length||!unresolved.length)cp=await createCore({projectId:task.projectId,taskIds:[task.id],expectedGeneration:task.generation,files},'terminal-task:'+task.id);
    const next:ProjectCheckpointRequest={...request,state:unresolved.length?'selection_required':'completed',...(cp?{checkpointId:cp.id}:{}),...(unresolved.length?{unresolved}:{})};await ctx.store.transact(tx=>tx.put('project-checkpoint-request',request.id,next));
   }catch(error){const code=error instanceof AppError?error.code:'CHECKPOINT_UNCERTAIN';if(code==='AUTHORITY_RETIRED'&&request.authority&&await ctx.store.read('authority-retired',JSON.stringify([request.authority.domainId,request.authority.epoch]))){await ctx.store.transact(tx=>tx.put('project-checkpoint-request',request.id,{...request,state:'retired',diagnostic:code}));continue;}await ctx.store.transact(tx=>tx.put('project-checkpoint-request',request.id,{...request,state:code==='NOT_QUIESCENT'?'waiting_boundary':'blocked',diagnostic:code}));if(code!=='NOT_QUIESCENT'&&await ctx.store.read('authority-binding','current'))await openSyncProblems(ctx,{kind:'project',id:request.projectId,path:workspace.path}).hold(code,inputHash({taskId:task.id,code}));}
  }
 }
 return {create:(input:ProjectCheckpointInput,requestId:string)=>serial(()=>createCore(input,requestId)),publish:(input:{checkpointId:string;target:RemoteTarget;handoffId?:string},requestId:string)=>serial(()=>publishCore(input,requestId)),list:async(projectId:string)=>(await ctx.store.list<ProjectCheckpoint>('project-checkpoint')).filter(cp=>cp.projectId===projectId),drain(){return draining??=(serial(drainCore).finally(()=>{draining=undefined;}));},async close(){closed=true;await tail;}};
}
export type ProjectCheckpoints=ReturnType<typeof openProjectCheckpoints>;
