import {AsyncLocalStorage} from 'node:async_hooks';
import type {InstanceContext} from '../instance/open.js';
import type {ProjectBinding} from '../workspaces/types.js';
import {AppError} from '../contracts/base.js';
const queues=new WeakMap<object,Promise<unknown>>(),writer=new AsyncLocalStorage<object>();
/** A legacy workflow calls its connection adapter within this same admission. */
export function withProjectEntry<T>(store:object,work:()=>Promise<T>):Promise<T>{if(writer.getStore()===store)return work();const next=(queues.get(store)??Promise.resolve()).then(()=>writer.run(store,work));queues.set(store,next.catch(()=>{}));return next;}
type Entry={family:'general'|'legacy';operationId:string;projectId:string;path:string;commonDir?:string;repositoryKey?:string};
export async function assertProjectEntryAvailable(ctx:InstanceContext,candidate:Entry){
 const conflict=(other:Entry)=>candidate.projectId===other.projectId||candidate.path===other.path||!!candidate.commonDir&&candidate.commonDir===other.commonDir||!!candidate.repositoryKey&&candidate.repositoryKey===other.repositoryKey;
 const check=(other:Entry)=>{if(other.family===candidate.family&&other.operationId===candidate.operationId&&other.projectId===candidate.projectId&&other.path===candidate.path)return;if(conflict(other))throw new AppError('PROJECT_OPERATION_PENDING','Resume the original project entry before starting another operation for this identity or repository.');};
 for(const intent of await ctx.store.list<{operationId:string;phase:string;preview:{projectId:string;path:string};analysis:{repositoryKey:string;snapshot?:{commonDir:string}};repositoryCommonDir?:string}>('project-flow'))if(intent.phase!=='completed')check({family:'general',operationId:intent.operationId,projectId:intent.preview.projectId,path:intent.preview.path,...intent.repositoryCommonDir??intent.analysis.snapshot?.commonDir?{commonDir:intent.repositoryCommonDir??intent.analysis.snapshot!.commonDir}:{},repositoryKey:intent.analysis.repositoryKey});
 for(const intent of await ctx.store.list<{requestId:string;projectId:string;path:string;commonDir?:string;repositoryKey:string;result?:{state:string}}>('setup-project-workflow'))if(intent.result?.state!=='ready')check({family:'legacy',operationId:intent.requestId,projectId:intent.projectId,path:intent.path,...intent.commonDir?{commonDir:intent.commonDir}:{},repositoryKey:intent.repositoryKey});
 for(const intent of await ctx.store.list<{requestId:string;projectId:string;path:string;commonDir:string;repositoryKey:string}>('setup-project-intent')){const binding=await ctx.store.read<ProjectBinding>('project-binding',intent.projectId);if(binding?.path===intent.path)continue;check({family:'legacy',operationId:intent.requestId,projectId:intent.projectId,path:intent.path,commonDir:intent.commonDir,repositoryKey:intent.repositoryKey});}
}
