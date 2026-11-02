import { openConfiguredOwnership,openConfiguredWorkloadOwnership } from '../../src/projects/configured-ownership.js';
import { join } from 'node:path';
import { gitVaultFixture } from './git-vault.js';
import { openInstance } from '../../src/instance/open.js';
import { openVault } from '../../src/vault/write.js';
import { GitClient } from '../../src/git/client.js';
import { openOwnership } from '../../src/projects/ownership.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { scriptedProvider } from './scripted-provider.js';
import { openCredentialFile } from '../../src/runtime/provider-credentials.js';
import { scriptedLoginProviders } from './provider-login.js';
export async function setupFixture(options:{extensions?:import('@earendil-works/pi-durable').Extension[]}={}){
 const native=await gitVaultFixture(),temp={root:native.root,paths:{stateDir:native.ctx.stateDir,vaultDir:native.path},cleanup:()=>native.close()},ctx=native.ctx,vault=openVault(ctx),git=new GitClient(),ownership=openConfiguredOwnership(ctx,git),workspaces=new WorkspaceManager(ctx),provider=scriptedProvider();
 const providerOptions={credentials:openCredentialFile(join(ctx.stateDir,'test-auth.json')),factories:scriptedLoginProviders};
 const runtime=await openRuntime({ctx,vault,ownership,workspaces,supervisor:new ProcessSupervisor(ctx),models:provider.models,providerOptions,...options.extensions?{extensions:options.extensions}:{}});
 return {...temp,ctx,vault,git,ownership,workspaces,provider,providerOptions,runtime,async agent(id='assistant'){await vault.propose({id:'create-'+id,path:`agents/${id}.md`,expectedRevision:null,actor:'fixture',content:`---\n${JSON.stringify({type:'Agent',lorecrew:{id,name:'Assistant',personality:'Help carefully',responsibilities:['Draft and plan'],groups:[],model:{provider:'scripted',modelId:'test-model'}}})}\n---\n`});return id;},async close(){await runtime.close();await ctx.close();await temp.cleanup();}};
}
