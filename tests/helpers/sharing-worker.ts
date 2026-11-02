import {access,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {gitTaskFixture} from './git-task-fixture.js';
import {openState} from '../../src/instance/state.js';
import {attachVault} from '../../src/instance/open.js';
import {openVault} from '../../src/vault/write.js';
import {GitClient} from '../../src/git/client.js';
import {openRepositories} from '../../src/repositories/service.js';
import {openConfiguredOwnership,openConfiguredWorkloadOwnership} from '../../src/projects/configured-ownership.js';
import {openRuntime} from '../../src/runtime/pi-host.js';
import {WorkspaceManager} from '../../src/workspaces/manager.js';
import {ProcessSupervisor} from '../../src/workspaces/processes.js';
import {scriptedProvider} from './scripted-provider.js';
import {openSharing} from '../../src/projects/sharing.js';
const [root,phase]=process.argv.slice(2) as [string,string],git=new GitClient(),remote=join(root,'shared.git');
let exists=true;try{await access(join(root,'state','config.json'));}catch{exists=false;}
let calls=0;let ctx:Awaited<ReturnType<typeof attachVault>>,runtime:Awaited<ReturnType<typeof openRuntime>>;
if(!exists){const f=await gitTaskFixture(root);ctx=f.ctx;runtime=f.runtime;await git.run(root,['init','--bare','--template=','--initial-branch=main',remote]);await git.run(remote,['config','receive.denyNonFastForwards','true']);await git.run(remote,['config','receive.denyDeletes','true']);await git.run(ctx.vaultDir,['remote','add','origin',remote]);await f.run();}
else {const state=await openState({stateDir:join(root,'state')});ctx=await attachVault(state,join(root,'vault'));const provider=scriptedProvider();provider.faux.setResponses([()=>{calls++;throw Error('Promotion restart must not replay a model');}]);runtime=await openRuntime({ctx,vault:openVault(ctx),ownership:openConfiguredOwnership(ctx,git),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,resume:false});}
const repositories=openRepositories({state:ctx,git}),target=(await repositories.inspect(ctx.vaultDir)).target!,binding=(await ctx.store.read<{domainId:string;epoch:number}>('authority-promotion-request','share')) as unknown as {old?:{domainId:string;epoch:number}}|undefined,local=binding?.old??(await ctx.store.read<{domainId:string;epoch:number}>('authority-binding','current'))!;
const input={expectedDomain:local.domainId,expectedEpoch:local.epoch,target,protectionAcknowledged:true as const},transact=ctx.store.transact.bind(ctx.store);let paused=false;
ctx.store.transact=async fn=>{const result=await transact(fn),p=await ctx.store.read<{phase:string}>('authority-promotion-request','share');if(!paused&&p?.phase===phase){paused=true;await writeFile(join(root,'paused'),JSON.stringify({phase,pid:process.pid}));await new Promise<void>(()=>{setInterval(()=>{},1000);});}return result;};
try{const result=await openSharing({ctx,vault:openVault(ctx),repositories,ownership:openConfiguredOwnership(ctx,git),workloads:openConfiguredWorkloadOwnership(ctx,git),proof:runtime}).enable(input,'share');await runtime.close();await ctx.close();await writeFile(join(root,'result.json'),JSON.stringify({binding:result,modelCalls:calls}));}catch(error){await writeFile(join(root,'failure.txt'),error instanceof Error?error.stack??error.message:String(error));process.exitCode=1;await runtime.close();await ctx.close();}
