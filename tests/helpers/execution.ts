import type { InstanceContext } from '../../src/instance/open.js';
import type { WorkspaceRecord } from '../../src/workspaces/types.js';
import { stableId } from '../../src/runtime/admission.js';
/** Low-level workspace tests supply explicit local authority instead of using a network remote. */
export async function workspaceContext(ctx:InstanceContext,workspaceId:string):Promise<string>{
 const w=await ctx.store.read<WorkspaceRecord>('workspace',workspaceId);if(!w)return 'missing-context';
 const id=stableId('fixture-context',workspaceId);await ctx.store.transact(tx=>{
  let grant=tx.get<{assignment:{generation:number;ownerId:string}}>('assignment-grants',w.projectId);
  if(!grant){grant={assignment:{generation:1,ownerId:ctx.instanceId}};tx.put('assignment-grants',w.projectId,grant);}
  if(!tx.get('execution-context',id))tx.put('execution-context',id,{id,sessionId:w.taskId,epoch:1,cwd:w.path,owner:{kind:'project',projectId:w.projectId,generation:grant.assignment.generation,workspaceId},state:'active'});
 });return id;
}
