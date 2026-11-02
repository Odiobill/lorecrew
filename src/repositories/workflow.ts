import {putRepositoryProblem} from './problems.js';
import {AppError} from '../contracts/base.js';
import type {InstanceContext} from '../instance/open.js';
import type {Vault} from '../vault/types.js';
import type {Runtime} from '../runtime/types.js';
import type {Ownership} from '../projects/types.js';
import type {ProjectCheckpointInput} from '../projects/checkpoints.js';
import type {RemoteTarget,RepositoryRef} from './types.js';
import type {ProjectBinding} from '../workspaces/types.js';
import {GitClient} from '../git/client.js';
import {openRepositories} from './service.js';
import {openSyncProblems} from '../sync/problems.js';
import {repositoryKey} from './remote.js';
import type {RepositoryProblem} from './types.js';
import {inputHash} from './inspect.js';
import {assertAuthorityDomain} from '../projects/authority-domain.js';
import {readVaultIdentity} from './identity.js';
import {openProjectWorkflow} from '../setup/project-workflow.js';
import {openSharing} from '../projects/sharing.js';
import {openConfiguredWorkloadOwnership} from '../projects/configured-ownership.js';
import {openCheckpointHandoff} from '../projects/checkpoint-handoff.js';
export type RepositoryAction=
 |{action:'checkpoint';input:ProjectCheckpointInput}
 |{action:'publish';checkpointId:string;target:RemoteTarget}
 |{action:'confirm-remote';kind:'vault'|'project';id:string;expectedRevision:string}
 |{action:'clone';projectId:string;title:string;url:string;parentPath:string;folderName:string}
 |{action:'sharing-enable';expectedDomain:string;expectedEpoch:number;target:RemoteTarget;protectionAcknowledged:true}
 |{action:'sharing-join';expectedDomain:string;expectedEpoch:number;target:RemoteTarget;protectionAcknowledged:true}
 |{action:'handoff';projectId:string;checkpointId:string;expectedGeneration:number;targetInstanceId:string}
 |{action:'preflight';manifestId:string;projectPath:string}
 |{action:'accept';manifestId:string};
export interface RepositoryCaller {sessionId:string;taskId:number}
export interface RepositoryOperation {id:string;state:'accepted'|'running'|'completed'|'blocked';action:RepositoryAction['action'];phase?:string;handoffId?:string;diagnostic?:string}
interface ControlOperation extends RepositoryOperation {input:RepositoryAction;inputHash:string;caller?:RepositoryCaller;resumeCallers?:RepositoryCaller[]}
export function openRepositoryWorkflow({ctx,vault,runtime,ownership,callerSettled=async()=>true}:{ctx:InstanceContext;vault:Vault;runtime:Runtime;ownership:Ownership;callerSettled?:(caller:RepositoryCaller)=>Promise<boolean>}){
 const git=new GitClient(),repositories=openRepositories({state:ctx,git}),sharing=openSharing({ctx,vault,repositories,ownership,workloads:openConfiguredWorkloadOwnership(ctx,git),proof:runtime});let draining:Promise<void>|undefined,closed=false;
 const checkpoints=()=>{if(!runtime.projectCheckpoints)throw new AppError('RUNTIME_REQUIRED','Checkpoint runtime is unavailable');return runtime.projectCheckpoints;};
 const handoff=()=>openCheckpointHandoff({ctx,vault,repositories,checkpoints:checkpoints(),ownership,runtime});
 async function repository(kind:'vault'|'project',id:string):Promise<RepositoryRef>{if(kind==='vault'){const identity=await readVaultIdentity(ctx.vaultDir);if(id!==identity.vaultId&&id!=='current')throw new AppError('NOT_FOUND','Vault not found');return {kind,id:identity.vaultId,path:ctx.vaultDir};}const binding=await ctx.store.read<ProjectBinding>('project-binding',id);if(!binding)throw new AppError('PROJECT_NOT_BOUND','Project has no local repository');return {kind,id,path:binding.path};}
 async function execute(input:RepositoryAction,requestId:string):Promise<unknown>{if(!requestId?.trim())throw new AppError('INVALID_REQUEST','A stable request identity is required');if(!['sharing-enable','sharing-join'].includes(input.action))await assertAuthorityDomain(ctx);switch(input.action){
  case 'checkpoint':return checkpoints().create(input.input,requestId);
  case 'publish':return checkpoints().publish({checkpointId:input.checkpointId,target:input.target},requestId);
  case 'confirm-remote':return repositories.confirmRepositoryTarget(await repository(input.kind,input.id),input.expectedRevision,requestId);
  case 'clone':{const {action,...choice}=input;return openProjectWorkflow({ctx,git,ownership}).connect({mode:'clone',...choice},requestId);}
  case 'sharing-enable':{const {action,...choice}=input;return sharing.enable(choice,requestId);}
  case 'sharing-join':{const {action,...choice}=input;return sharing.join(choice,requestId);}
  case 'handoff':{const {action,...choice}=input;return handoff().begin(choice,requestId);}
  case 'preflight':return handoff().preflight(input,requestId);
  case 'accept':return handoff().accept(input,requestId);
 }}
 const metadata=({id,state,action,phase,handoffId,diagnostic}:RepositoryOperation):RepositoryOperation=>({id,state,action,...phase?{phase}:{},...handoffId?{handoffId}:{},...diagnostic?{diagnostic}:{}});
 async function enqueue(input:RepositoryAction,requestId:string,caller?:RepositoryCaller){if(!requestId?.trim())throw new AppError('INVALID_REQUEST','A stable request identity is required');const previous=await ctx.store.read<ControlOperation>('repository-control-operation',inputHash({instanceId:ctx.instanceId,requestId}));if(previous){if(previous.inputHash!==inputHash({input,caller:caller??null}))throw new AppError('IDEMPOTENCY_CONFLICT','Control operation input changed');return previous.state==='blocked'?resume(previous.id,caller):{operationId:previous.id,...metadata(previous)};}await assertAuthorityDomain(ctx);if(!['sharing-enable','handoff'].includes(input.action))throw new AppError('INVALID_REQUEST','Only stop-requiring control actions are queued');const id=inputHash({instanceId:ctx.instanceId,requestId}),digest=inputHash({input,caller:caller??null});await ctx.store.transact(tx=>{const old=tx.get<ControlOperation>('repository-control-operation',id);if(old){if(old.inputHash!==digest)throw new AppError('IDEMPOTENCY_CONFLICT','Control operation input changed');return;}tx.put('repository-control-operation',id,{id,state:'accepted',action:input.action,input,inputHash:digest,...caller?{caller}:{}});tx.emit('repository.operation',{id,state:'accepted'});});return {operationId:id,...metadata((await ctx.store.read<ControlOperation>('repository-control-operation',id))!)};}
 async function resume(id:string,caller?:RepositoryCaller){
  const op=await ctx.store.read<ControlOperation>('repository-control-operation',id);if(!op)throw new AppError('NOT_FOUND','Repository operation not found');
  if(op.inputHash!==inputHash({input:op.input,caller:op.caller??null}))throw new AppError('REPOSITORY_UNCERTAIN','Original control operation input changed');
  if(op.state!=='blocked')return {operationId:op.id,...metadata(op)};
  if(op.input.action==='sharing-enable'){
   const controlId='control:'+op.id,promotion=await ctx.store.read<{input:Omit<Extract<RepositoryAction,{action:'sharing-enable'}>,'action'>}>('authority-promotion-request',controlId),pending=await ctx.store.read<{id:string}>('authority-promotion','pending');
   if(pending&&pending.id!==controlId)throw new AppError('AUTHORITY_RETIRED','Only the original pending promotion may resume');
   const {action,...choice}=op.input;if(promotion){if(inputHash(promotion.input)!==inputHash(choice))throw new AppError('REPOSITORY_UNCERTAIN','Original promotion selection changed');}else await assertAuthorityDomain(ctx);
  }else await assertAuthorityDomain(ctx);
  await ctx.store.transact(tx=>{const current=tx.get<ControlOperation>('repository-control-operation',id);if(!current||current.inputHash!==op.inputHash)throw new AppError('REPOSITORY_UNCERTAIN','Control operation changed');if(current.state!=='blocked')return;const {diagnostic,...saved}=current;const callers=[...(current.resumeCallers??[])];if(caller&&!callers.some(c=>c.sessionId===caller.sessionId&&c.taskId===caller.taskId))callers.push(caller);tx.put('repository-control-operation',id,{...saved,state:'accepted',resumeCallers:callers});tx.emit('repository.operation',{id,state:'accepted'});});
  return {operationId:id,...metadata((await ctx.store.read<ControlOperation>('repository-control-operation',id))!)};
 }
 async function controlProblem(op:ControlOperation,code:string|undefined,handoffId:string|undefined){const repo:RepositoryRef=op.input.action==='handoff'?{kind:'project',id:op.input.projectId,path:ctx.vaultDir}:{kind:'vault',id:(await readVaultIdentity(ctx.vaultDir)).vaultId,path:ctx.vaultDir};if(code){const revision=inputHash({operation:handoffId??op.id,code}),id=inputHash({repository:repositoryKey(repo),code});await openSyncProblems(ctx,repo).hold(code,revision);await ctx.store.transact(tx=>tx.put('repository-control-problem',id,{operation:handoffId??op.id,revision}));return;}for(const problem of await ctx.store.list<RepositoryProblem>('repository-problem')){const origin=await ctx.store.read<{operation:string;revision:string}>('repository-control-problem',problem.id);if(problem.state==='active'&&problem.repositoryKind===repo.kind&&problem.repositoryId===repo.id&&origin?.operation===(handoffId??op.id)&&origin.revision===problem.revision)await ctx.store.transact(tx=>putRepositoryProblem(tx,{...problem,state:'resolved'}));}}
 async function drainCore(){for(const op of await ctx.store.list<ControlOperation>('repository-control-operation')){if(closed||!['accepted','running'].includes(op.state))continue;let waiting=false;for(const caller of [...op.caller?[op.caller]:[],...op.resumeCallers??[]])if(!await callerSettled(caller))waiting=true;if(waiting)continue;await ctx.store.transact(tx=>tx.put('repository-control-operation',op.id,{...op,state:'running'}));try{const result=await execute(op.input,'control:'+op.id),diagnostic=result&&typeof result==='object'&&'diagnostic' in result?String(result.diagnostic):undefined,phase=result&&typeof result==='object'&&'phase' in result?String(result.phase):undefined,handoffId=result&&typeof result==='object'&&'id' in result&&op.input.action==='handoff'?String(result.id):undefined,state=diagnostic||phase&&!['transfer_published','accepted'].includes(phase)?'blocked':'completed';await controlProblem(op,state==='blocked'?(diagnostic??'CHECKPOINT_REQUIRED'):undefined,handoffId);await ctx.store.transact(tx=>{tx.put('repository-control-operation',op.id,{...op,state,...phase?{phase}:{},...handoffId?{handoffId}:{},...diagnostic?{diagnostic}:{}});tx.emit('repository.operation',{id:op.id,state});});}catch(error){await controlProblem(op,error instanceof AppError?error.code:'REPOSITORY_UNCERTAIN',undefined);await ctx.store.transact(tx=>{tx.put('repository-control-operation',op.id,{...op,state:'blocked',diagnostic:error instanceof AppError?error.code:'REPOSITORY_UNCERTAIN'});tx.emit('repository.operation',{id:op.id,state:'blocked'});});}}}
 return {execute,enqueue,resume,async status(kind:'vault'|'project',id:string){const repo=await repository(kind,id),view=await repositories.inspect(repo.path);return {...await repositories.status(repo),target:view.target??null};},async operation(id:string){const op=await ctx.store.read<ControlOperation>('repository-control-operation',id);if(!op)throw new AppError('NOT_FOUND','Repository operation not found');return metadata(op);},sharingStatus:()=>sharing.inspect(),handoffStatus:(projectId:string)=>handoff().read(projectId),drain(){return draining??=(drainCore().finally(()=>{draining=undefined;}));},async close(){closed=true;await draining;}};
}
export type RepositoryWorkflow=ReturnType<typeof openRepositoryWorkflow>;
