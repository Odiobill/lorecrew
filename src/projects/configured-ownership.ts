import {canonicalRepositoryKey} from './registry.js';
import {openProjectCatalog,validateProjectCatalogEntry} from './catalog.js';
import {openVault} from '../vault/write.js';
import {openRepositories} from '../repositories/service.js';
import {inputHash} from '../repositories/inspect.js';
import type { InstanceContext } from '../instance/open.js';
import type { GitClient } from '../git/client.js';
import {assertAuthorityDomain} from './authority-domain.js';
import { AppError } from '../contracts/base.js';
import { openOwnership } from './ownership.js';
import { openWorkloadOwnership } from './workload-grants.js';
async function endpoint(ctx:InstanceContext,fallback:string):Promise<string>{
 const binding=await ctx.store.read<{remote:string}>('fleet','assignments');
 if(binding)return binding.remote;
 if((await ctx.store.read<{phase:string}>('setup-ownership','current'))?.phase==='pending')throw new AppError('OWNERSHIP_SETUP_PENDING','Finish the current project ownership setup before starting owned work.');
 return fallback;
}
/** Resolve confirmed configuration per operation; existing grants and fences remain authoritative. */
function configured<T extends object>(ctx:InstanceContext,git:GitClient,fallback:string,open:(ctx:InstanceContext,git:GitClient,remote:string)=>T):T{
 return new Proxy(open(ctx,git,fallback),{get(target,key){const value=Reflect.get(target,key);if(typeof value!=='function')return value;return async(...args:unknown[])=>{if(['claim','assertOwner','acceptGrant','accept','transfer'].includes(String(key))){if(ctx.store.repositoryFormat()!==2)throw new AppError('MIGRATION_REQUIRED','Stop and convert legacy authority before managed execution');await assertAuthorityDomain(ctx);}if(key==='claim'&&args[0]&&typeof args[0]==='object'){const input=args[0] as {id:string;title:string;repositoryKey:string};validateProjectCatalogEntry({version:1,projectId:input.id,title:input.title,repositoryAliases:[canonicalRepositoryKey(input.repositoryKey)]});}const service=open(ctx,git,await endpoint(ctx,fallback));const action=Reflect.get(service,key);if(typeof action!=='function')throw new AppError('INVALID_REQUEST','Unknown ownership operation');const result=await Reflect.apply(action,service,args);if(key==='claim'&&result&&typeof result.projectId==='string'){await openProjectCatalog({ctx,vault:openVault(ctx),repositories:openRepositories({state:ctx,git})}).register({projectId:result.projectId,title:(args[0] as {title:string}).title,repositoryAliases:[result.repositoryKey]},'authority-claim:'+inputHash({projectId:result.projectId,requestId:args[1]}));}return result;};}});
}
export const openConfiguredOwnership=(ctx:InstanceContext,git:GitClient,fallback='origin')=>configured(ctx,git,fallback,openOwnership);
export const openConfiguredWorkloadOwnership=(ctx:InstanceContext,git:GitClient,fallback='origin')=>configured(ctx,git,fallback,openWorkloadOwnership);
