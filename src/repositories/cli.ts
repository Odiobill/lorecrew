import {readFile} from 'node:fs/promises';
import {Value} from 'typebox/value';
import {RepositoryActionSchema} from '../api/repository-routes.js';
import {AppError,type Json} from '../contracts/base.js';
import type {InstanceContext} from '../instance/open.js';
import {GitClient} from '../git/client.js';
import {openConfiguredOwnership} from '../projects/configured-ownership.js';
import {openRuntime} from '../runtime/pi-host.js';
import {openVault} from '../vault/write.js';
import {WorkspaceManager} from '../workspaces/manager.js';
import {ProcessSupervisor} from '../workspaces/processes.js';
import {openRepositories} from './service.js';
import {readVaultIdentity} from './identity.js';
import type {RepositoryAction} from './workflow.js';
export async function repositoryCli(ctx:InstanceContext,command:string,action:string,values:Record<string,string|boolean|undefined>):Promise<{[key:string]:Json}>{
 const git=new GitClient(),id=typeof values.id==='string'?values.id:'current',kind=values.repository==='project'?'project':'vault';
 if(command==='repository'&&action==='status'){const path=kind==='vault'?ctx.vaultDir:(await ctx.store.read<{path:string}>('project-binding',id))?.path;if(!path)throw new AppError('PROJECT_NOT_BOUND','Bind the project before inspecting it');const repositories=openRepositories({state:ctx,git}),view=await repositories.inspect(path);return JSON.parse(JSON.stringify({...await repositories.status({kind,id:kind==='vault'?(await readVaultIdentity(ctx.vaultDir)).vaultId:id,path}),target:view.target??null})) as {[key:string]:Json};}
 const ownership=openConfiguredOwnership(ctx,git),runtime=await openRuntime({ctx,vault:openVault(ctx),ownership,workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),resume:false});try{const workflow=runtime.repositories!;
 if(command==='sharing'&&action==='status')return JSON.parse(JSON.stringify(await workflow.sharingStatus())) as {[key:string]:Json};
 if(command==='project'&&action==='handoff-status')return JSON.parse(JSON.stringify(await workflow.handoffStatus(id))) as {[key:string]:Json};
 if(!values.input||typeof values.input!=='string'||typeof values['request-id']!=='string')throw new AppError('USAGE','This action requires --input FILE and --request-id STABLE_ID with reviewed exact checkpoint/remote choices');
 const input:unknown=JSON.parse(await readFile(values.input,'utf8'));if(!Value.Check(RepositoryActionSchema,input))throw new AppError('INVALID_REQUEST','The reviewed repository action has an invalid or unbounded shape');const selected=input as RepositoryAction,expected=command==='sharing'?'sharing-'+action:command==='project'?action==='handoff'?'handoff':action:action;if(selected.action!==expected)throw new AppError('USAGE','Input action does not match the command');
 const result=await workflow.execute(selected,values['request-id']);return {result:JSON.parse(JSON.stringify(result)) as Json};
 }finally{await runtime.close();}
}
