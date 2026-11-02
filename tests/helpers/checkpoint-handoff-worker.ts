import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {checkpointHandoffFixture} from './checkpoint-handoff.js';
import {openState} from '../../src/instance/state.js';
import {attachVault} from '../../src/instance/open.js';
import {openVault} from '../../src/vault/write.js';
import {openRuntime} from '../../src/runtime/pi-host.js';
import {openRepositories} from '../../src/repositories/service.js';
import {openConfiguredOwnership} from '../../src/projects/configured-ownership.js';
import {openCheckpointHandoff} from '../../src/projects/checkpoint-handoff.js';
import {WorkspaceManager} from '../../src/workspaces/manager.js';
import {ProcessSupervisor} from '../../src/workspaces/processes.js';
import {scriptedProvider} from './scripted-provider.js';
import {GitClient} from '../../src/git/client.js';
import {inputHash} from '../../src/repositories/inspect.js';
import {ASSIGNMENT_REF} from '../../src/git/refs.js';
const [root,phase]=process.argv.slice(2) as [string,string];
async function pause(){const stat=await readFile('/proc/self/stat','utf8'),start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];await writeFile(join(root,'paused'),JSON.stringify({phase,pid:process.pid,start}));await new Promise<void>(()=>{setInterval(()=>{},1000);});}
if(phase==='resume'){
 const state=await openState({stateDir:join(root,'state')}),ctx=await attachVault(state,join(root,'vault')),git=new GitClient(),ownership=openConfiguredOwnership(ctx,git),provider=scriptedProvider();let calls=0;provider.faux.setResponses([()=>{calls++;throw Error('Source checkpoint recovery cannot replay a model');}]);const runtime=await openRuntime({ctx,vault:openVault(ctx),ownership,workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,resume:false});
 try{const fixture=JSON.parse(await readFile(join(root,'handoff-input.json'),'utf8')),view=await openCheckpointHandoff({ctx,vault:openVault(ctx),repositories:openRepositories({state:ctx,git}),checkpoints:runtime.projectCheckpoints!,ownership,runtime}).begin(fixture.input,'kill-handoff');if(view.phase!=='transfer_published')throw Error('Recovery phase '+view.phase+' '+view.diagnostic);const reportsMatch=inputHash(await ctx.store.list('team-report'))===fixture.reportsHash;await runtime.close();await ctx.close();await writeFile(join(root,'result.json'),JSON.stringify({id:view.id,phase:view.phase,modelCalls:calls,reportsMatch}));}catch(error){await writeFile(join(root,'failure.txt'),error instanceof Error?error.stack??error.message:String(error));process.exitCode=1;await runtime.close();await ctx.close();}
}else{
 const f=await checkpointHandoffFixture(root);try{const cp=await f.selected(),input={projectId:'code',checkpointId:cp.id,expectedGeneration:1,targetInstanceId:f.target.ctx.instanceId},id=inputHash([input.projectId,input.expectedGeneration,input.targetInstanceId,'kill-handoff']);await writeFile(join(root,'handoff-input.json'),JSON.stringify({input,reportsHash:inputHash(await f.source.ctx.store.list('team-report'))}));let paused=false;const transact=f.source.ctx.store.transact.bind(f.source.ctx.store);f.source.ctx.store.transact=async fn=>{const result=await transact(fn);const source=await f.source.ctx.store.read<{phase:string}>('checkpoint-handoff-source',id),native=await f.source.ctx.store.read<{phase:string}>('project-handoff','code');if(!paused&&(source?.phase===phase||phase==='native-receipt'&&native?.phase==='published')){paused=true;await pause();}return result;};
  if(phase==='control-sent'){const native=GitClient.prototype.run;GitClient.prototype.run=async function(cwd,args,options){const result=await native.call(this,cwd,args,options);if(!paused&&args.includes('push')&&args.includes(f.vaultRemote)&&args.some(arg=>arg.endsWith(':'+ASSIGNMENT_REF))&&result.exitCode===0){paused=true;await pause();}return result;};}
  const view=await f.sourceService().begin(input,'kill-handoff');throw Error('Worker never reached requested pause: '+phase+'; result '+view.phase+' '+view.diagnostic);
 }catch(error){await writeFile(join(root,'failure.txt'),error instanceof Error?error.stack??error.message:String(error));process.exitCode=1;await f.close();}
}
