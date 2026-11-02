import {expect,it} from 'vitest';
import {readFile,rename,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {gitVaultFixture} from '../helpers/git-vault.js';
import {scriptedProvider} from '../helpers/scripted-provider.js';
import {ensureLocalAuthority,assertAuthorityDomain} from '../../src/projects/authority-domain.js';
import {openSharing} from '../../src/projects/sharing.js';
import {openConfiguredOwnership,openConfiguredWorkloadOwnership} from '../../src/projects/configured-ownership.js';
import {openRuntime} from '../../src/runtime/pi-host.js';
import {WorkspaceManager} from '../../src/workspaces/manager.js';
import {ProcessSupervisor} from '../../src/workspaces/processes.js';
import {openVaultSync} from '../../src/sync/service.js';
import {backupOffline,restoreOffline} from '../../src/instance/backup.js';
import {verifyRestoredInstance} from '../../src/instance/recovery.js';
import {openState} from '../../src/instance/state.js';
import {attachVault,type InstanceContext} from '../../src/instance/open.js';
import {ASSIGNMENT_REF} from '../../src/git/refs.js';

it.each([false,true])('retains committed retirement after actual older restore and marker removal (commit deletion: %s)',async commitDeletion=>{
 const f=await gitVaultFixture();let runtime:Awaited<ReturnType<typeof openRuntime>>|undefined,restored:InstanceContext|undefined;
 try{
  const local=await ensureLocalAuthority(f.ctx,f.identity,'local');await f.ownership.claim({id:'before',title:'Before',repositoryKey:'fork:before'},'before');
  const remote=join(f.root,'shared.git');expect((await f.git.run(f.root,['init','--bare','--template=','--initial-branch=main',remote])).exitCode).toBe(0);await f.gitAt(['remote','add','origin',remote]);await f.gitAt(['push','origin','main']);
  const stateDir=f.ctx.stateDir,originalId=f.ctx.instanceId,archive=join(f.root,'before-promotion');await f.ctx.close();await backupOffline({stateDir,destination:archive});await f.reopen();
  const provider=scriptedProvider();runtime=await openRuntime({ctx:f.ctx,vault:f.vault,ownership:f.ownership,workspaces:new WorkspaceManager(f.ctx),supervisor:new ProcessSupervisor(f.ctx),models:provider.models,resume:false});
  await openSharing({ctx:f.ctx,vault:f.vault,repositories:f.repositories,ownership:f.ownership,workloads:openConfiguredWorkloadOwnership(f.ctx,f.git),proof:runtime}).enable({expectedDomain:local.domainId,expectedEpoch:1,target:(await f.repositories.inspect(f.path)).target!,protectionAcknowledged:true},'promote');
  const sync=await openVaultSync({ctx:f.ctx,vault:f.vault,runtime,git:f.git,publicationMs:100000});try{await sync.flush();expect(await sync.status()).toMatchObject({state:'synchronized'});}finally{await sync.close();}
  const committed=await f.gitAt(['show','HEAD:.lorecrew/authority.json']);expect(JSON.parse(committed)).toMatchObject({mode:'shared',epoch:2});
  const target=await f.device('target');expect((await f.git.run(target.path,['remote','set-url','origin',remote])).exitCode).toBe(0);
  await openSharing({ctx:target.ctx,vault:target.vault,repositories:target.repositories,ownership:target.ownership,workloads:openConfiguredWorkloadOwnership(target.ctx,f.git),proof:runtime}).join({expectedDomain:local.domainId,target:(await target.repositories.inspect(target.path)).target!},'join');
  const grant=await target.ownership.claim({id:'duplicate',title:'Target',repositoryKey:'fork:duplicate'},'target-claim');expect(grant.ownerId).toBe(target.ctx.instanceId);
  await runtime.close();runtime=undefined;await f.ctx.close();await rename(stateDir,join(f.root,'retained-promoted-state'));await restoreOffline({archivePath:archive,stateDir,originalInstanceFenced:true});await unlink(join(f.path,'.lorecrew/authority.json'));if(commitDeletion){await f.gitAt(['add','-A']);await f.gitAt(['-c','user.name=User','-c','user.email=user@example.test','commit','-m','Remove working retirement file']);}
  restored=await attachVault(await openState({stateDir}),f.path);expect(restored.instanceId).toBe(originalId);if(!commitDeletion)expect(await f.gitAt(['show','HEAD:.lorecrew/authority.json'])).toBe(committed);expect((await f.git.run(remote,['show','main:.lorecrew/authority.json'])).stdout.trim()).toBe(committed);
  await expect(verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true})).rejects.toMatchObject({code:'AUTHORITY_RETIRED'});
  expect(await readFile(join(stateDir,'restore-quarantine.json'),'utf8')).toContain(originalId);
  await expect(assertAuthorityDomain(restored)).rejects.toMatchObject({code:'AUTHORITY_RETIRED'});
  await expect(openConfiguredOwnership(restored,f.git).claim({id:'duplicate',title:'Competing source',repositoryKey:'fork:duplicate'},'restored-claim')).rejects.toMatchObject({code:'AUTHORITY_RETIRED'});
  const control=JSON.parse((await f.git.run(remote,['show',ASSIGNMENT_REF+':control.json'])).stdout);expect(control.epoch).toBe(2);expect(control.assignments.find((a:{projectId:string})=>a.projectId==='duplicate')).toEqual(grant);expect(await restored.store.read('assignment-grants','duplicate')).toBeUndefined();expect(provider.faux.state.callCount).toBe(0);
 }finally{await runtime?.close();await restored?.close();await f.close();}
},30000);
