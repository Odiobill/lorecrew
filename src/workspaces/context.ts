import { assertAuthorityScope,authorityScope,type AuthorityScope } from '../projects/authority-domain.js';
import type { AuthorityBinding } from '../repositories/types.js';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Tx } from '../storage/store.js';
import { assertRestoredExecutionAllowed } from '../instance/recovery.js';
import { assertWorkloadAdmission } from '../projects/workload-grants.js';
import { assertWorkloadWorkspace } from '../learning/tools.js';
import { stableId } from '../runtime/admission.js';
import type { WorkspaceRecord, WorkloadWorkspace } from './types.js';
export type ExecutionOwner={kind:'session'}|{kind:'project';projectId:string;generation:number;workspaceId:string}|{kind:'workload';workloadId:string;generation:number;workspaceId:string};
export interface ExecutionContext {authority?:AuthorityScope;id:string;sessionId:string;epoch:number;cwd:string;owner:ExecutionOwner;state:'active'|'draining'|'stopped'}
export async function assertExecutionCwd(cwd:string):Promise<void>{try{if(!isAbsolute(cwd)||!(await stat(cwd)).isDirectory())throw new Error();}catch{throw new AppError('EXECUTION_CWD_UNAVAILABLE','The recorded working directory is unavailable; restore it before continuing. No fallback directory is used.',{cwd});}}
export function assertContextAdmission(ctx:InstanceContext,tx:Tx,id:string):ExecutionContext {
 const c=tx.get<ExecutionContext>('execution-context',id);if(!c)throw new AppError('CONTEXT_NOT_FOUND','Unknown execution context');
 if(c.state!=='active'||tx.get('execution-context-fence',id))throw new AppError('CONTEXT_STOPPED','Execution epoch is permanently stopped or draining');
 if(tx.get<{cancelled?:boolean}>('runtime-session',c.sessionId)?.cancelled||tx.get('session-process-fence',c.sessionId))throw new AppError('SESSION_CANCELLED','Session process admission is closed');
 const owner=c.owner;if(owner.kind!=='session')assertAuthorityScope(tx,c.authority);
 if(owner.kind==='project'){
  if(tx.get<{closed:boolean}>('project-admission',owner.projectId)?.closed)throw new AppError('ADMISSION_CLOSED','Project handoff has closed local admission');
  const grant=tx.get<{assignment:{generation:number;ownerId:string}}>('assignment-grants',owner.projectId)?.assignment;
  if(tx.get('assignment-revocations',JSON.stringify([owner.projectId,owner.generation])))throw new AppError('OWNER_REVOKED','Execution generation was revoked');
  if(grant?.generation!==owner.generation||grant.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Execution generation is no longer locally owned');
  const fence=tx.get<{generation?:number}>('process-fence',owner.projectId);
  if(fence&&owner.generation<=(fence.generation??Infinity))throw new AppError('PROJECT_STOPPED','Project process admission is stopped');
 } else if(owner.kind==='workload')assertWorkloadAdmission(ctx,tx,owner.workloadId,owner.generation);
 if(owner.kind!=='session'){
  if(owner.kind==='project'&&tx.get('repository-retired-execution',JSON.stringify(['workspace',owner.workspaceId])))throw new AppError('MIGRATION_REQUIRED','A stopped legacy workspace cannot execute; create fresh Git work');
  const w=tx.get<WorkspaceRecord|WorkloadWorkspace>(owner.kind==='project'?'workspace':'workload-workspace',owner.workspaceId);
  if(!w||w.state!=='active'||w.path!==c.cwd||(owner.kind==='project'? !('projectId' in w)||w.projectId!==owner.projectId:!('workloadId' in w)||w.workloadId!==owner.workloadId||w.generation!==owner.generation))throw new AppError('WORKSPACE_NOT_ACTIVE','Execution workspace binding changed');
  if(tx.get('workspace-process-fence',owner.workspaceId))throw new AppError('WORKSPACE_STOPPED','Workspace process admission is stopped');
 }
 return c;
}
export async function currentExecutionContext(ctx:InstanceContext,sessionId:string):Promise<ExecutionContext|undefined>{const ref=await ctx.store.read<{contextId:string}>('session-execution-context',sessionId);return ref?ctx.store.read<ExecutionContext>('execution-context',ref.contextId):undefined;}
export async function assertExecutionContext(ctx:InstanceContext,id:string):Promise<ExecutionContext>{await assertRestoredExecutionAllowed(ctx);const c=await ctx.store.transact(tx=>assertContextAdmission(ctx,tx,id));await assertExecutionCwd(c.cwd);if(c.owner.kind==='workload'){const workspace=await ctx.store.read<WorkloadWorkspace>('workload-workspace',c.owner.workspaceId);await assertWorkloadWorkspace(ctx,workspace!);}return c;}
export async function ensureExecutionContext(ctx:InstanceContext,input:{sessionId:string;cwd:string;owner:ExecutionOwner;afterStoppedContextId?:string}):Promise<ExecutionContext>{
 await assertRestoredExecutionAllowed(ctx);await assertExecutionCwd(input.cwd);
 return ctx.store.transact(tx=>{
  const ref=tx.get<{contextId:string}>('session-execution-context',input.sessionId);const previous=ref?tx.get<ExecutionContext>('execution-context',ref.contextId):undefined;
  if(previous){
   if(previous.cwd!==input.cwd||!isDeepStrictEqual(previous.owner,input.owner))throw new AppError('CONTEXT_CONFLICT','Session execution binding cannot silently change');
   if(!input.afterStoppedContextId){assertContextAdmission(ctx,tx,previous.id);return previous;}
   if(previous.state==='active'&&tx.get<{contextId:string}>('execution-predecessor',previous.id)?.contextId===input.afterStoppedContextId){assertContextAdmission(ctx,tx,previous.id);return previous;}
   if(previous.id!==input.afterStoppedContextId||previous.state!=='stopped')throw new AppError('CONTEXT_STOPPED','A successor requires the exact positively stopped predecessor');
  }else if(input.afterStoppedContextId)throw new AppError('CONTEXT_CONFLICT','No stopped predecessor exists');
  const binding=tx.get<AuthorityBinding>('authority-binding','current');const scope=input.owner.kind!=='session'&&binding?{authority:authorityScope(binding)}:{};
  const epoch=(previous?.epoch??0)+1;const c:ExecutionContext={...scope,id:stableId('execution',input.sessionId,String(epoch)),sessionId:input.sessionId,epoch,cwd:input.cwd,owner:input.owner,state:'active'};
  tx.insert('execution-context',c.id,c);if(previous)tx.put('execution-predecessor',c.id,{contextId:previous.id});tx.put('session-execution-context',input.sessionId,{contextId:c.id});if(input.afterStoppedContextId)tx.delete('execution-resume',input.sessionId);assertContextAdmission(ctx,tx,c.id);return c;
 });
}
/** Existing managed workspace callers use the same admission and journal as ordinary sessions. */
export async function ensureWorkspaceExecutionContext(ctx:InstanceContext,sessionId:string,workspaceId:string):Promise<ExecutionContext>{
 const workload=await ctx.store.read<WorkloadWorkspace>('workload-workspace',workspaceId);const w=workload??await ctx.store.read<WorkspaceRecord>('workspace',workspaceId);
 if(!w)throw new AppError('WORKSPACE_NOT_ACTIVE','An active workspace is required');
 const owner:ExecutionOwner=workload?{kind:'workload',workloadId:workload.workloadId,generation:workload.generation,workspaceId}:{kind:'project',projectId:(w as WorkspaceRecord).projectId,generation:(await ctx.store.read<{assignment:{generation:number}}>('assignment-grants',(w as WorkspaceRecord).projectId))?.assignment.generation??0,workspaceId};
 return ensureExecutionContext(ctx,{sessionId,cwd:w.path,owner});
}
