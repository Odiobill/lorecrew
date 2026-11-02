import {INITIAL_VAULT_INDEX} from '../../src/vault/start.js';
import {join} from 'node:path';
import {openState} from '../../src/instance/state.js';
import {attachVault,type InstanceContext} from '../../src/instance/open.js';
import {openVault} from '../../src/vault/write.js';
import {GitClient} from '../../src/git/client.js';
import {openRepositories} from '../../src/repositories/service.js';
import {planVaultIdentity,readVaultIdentity} from '../../src/repositories/identity.js';
import {openConfiguredOwnership} from '../../src/projects/configured-ownership.js';
import {repositoryFixture} from './repository.js';
export type GitVaultFixture=Awaited<ReturnType<typeof gitVaultFixture>>;
export async function gitVaultFixture(_options:{shared?:boolean}={}){
 const f=await repositoryFixture(),git=new GitClient();const path=join(f.root,'vault');const identity=await planVaultIdentity(f.state,path,'vault');await f.repositories.create({repo:{kind:'vault',id:identity.vaultId,path},parentPath:f.root,folderName:'vault',scaffold:[{path:'index.md',content:INITIAL_VAULT_INDEX},{path:'.lorecrew/vault.json',content:JSON.stringify(identity)+'\n'}]},'create-vault');let ctx=await attachVault(f.state,path);const children:InstanceContext[]=[];
 const at=async(args:string[])=>{const r=await git.run(path,args);if(r.exitCode)throw Error(r.stderr);return r.stdout.trim();};
 return {root:f.root,path,identity,git,gitAt:at,get ctx(){return ctx;},get state(){return ctx;},get vault(){return openVault(ctx);},get repositories(){return openRepositories({state:ctx,git});},get ownership(){return openConfiguredOwnership(ctx,git);},async reopen(){await f.reopen();ctx=await attachVault(f.state,path);},async device(name:string){const state=await openState({stateDir:join(f.root,name+'-state')});const destination=join(f.root,name);const repositories=openRepositories({state,git});await repositories.clone({repo:{kind:'vault',id:identity.vaultId,path:destination},url:path,parentPath:f.root,folderName:name},name+'-clone');const other=await attachVault(state,destination);children.push(other);return {ctx:other,identity:await readVaultIdentity(destination),path:destination,vault:openVault(other),repositories,ownership:openConfiguredOwnership(other,git)};},async close(){for(const child of children)await child.close();await f.close();}};
}
