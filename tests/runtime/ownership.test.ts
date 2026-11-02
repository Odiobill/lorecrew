import {gitProject} from '../helpers/git-project.js';
import { workspaceContext } from '../helpers/execution.js';
import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { GitClient } from '../../src/git/client.js';
import type { InstanceContext } from '../../src/instance/open.js';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { bindProject } from '../../src/projects/bindings.js';
import { handoffProject } from '../../src/projects/handoff.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openVault } from '../../src/vault/write.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function setup(extensions:Parameters<typeof openRuntime>[0]['extensions']=[], managerFactory=(ctx:InstanceContext)=>new WorkspaceManager(ctx)) {
  const f=await gitFleet();cleanup.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,'origin');
  const ownership=openOwnership(f.a.ctx,f.a.git,'origin');await ownership.claim({id:'project',repositoryKey:'fork:project',title:'Project'},'claim');
  await cp('tests/fixtures/vault/agents',join(f.a.ctx.vaultDir,'agents'),{recursive:true});
  const path=join(f.a.ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
  const project=join(f.root,'project');await gitProject(project);await bindProject(f.a.ctx,{projectId:'project',path:project});
  const workspaces=managerFactory(f.a.ctx);const supervisor=new ProcessSupervisor(f.a.ctx);const provider=scriptedProvider();
  const options={ctx:f.a.ctx,vault:openVault(f.a.ctx),ownership,workspaces,supervisor,models:provider.models,extensions};
  let runtime=await openRuntime(options);cleanup.push(()=>runtime.close());
  return {...f,ownership,workspaces,supervisor,...provider,get runtime(){return runtime;},async reopen(){await runtime.close();runtime=await openRuntime(options);}};
}
it('cancelling one session leaves other project work admissible',async()=>{
  const f=await setup();const s=await f.runtime.createSession({agentId:'agent-ada',requestId:'s',projectId:'project'});
  await f.runtime.cancel(s.id);
  const workspace=await f.workspaces.acquire({projectId:'project',taskId:'another'});
  const result=await f.supervisor.run({contextId:await workspaceContext(f.a.ctx,workspace.id),command:'printf ready',requestId:'other-command'});
  expect(result.output).toBe('ready');
});
it('handoff joins actual Pi tasks and closes runtime admission before publishing',async()=>{
  let started!:()=>void;const active=new Promise<void>(r=>started=r);let stopped=false;
  const extension=defineExtension({name:'waiting',tools:[defineTool({name:'wait',description:'wait',parameters:Type.Object({}),replay:'safe',async execute(_args,_api,c){
    started();await new Promise<void>((_r,reject)=>c.abortSignal?.addEventListener('abort',()=>{stopped=true;reject(new Error('stopped'));},{once:true}));return {output:[]};
  }})]});
  const f=await setup([extension]);f.faux.setResponses([fauxAssistantMessage(fauxToolCall('wait',{}),{stopReason:'toolUse'})]);
  const s=await f.runtime.createSession({agentId:'agent-ada',requestId:'s',projectId:'project'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Wait'});await active;
  const assigned=await handoffProject({ownership:f.ownership,probe:f.runtime,projectId:'project',expectedGeneration:1,targetInstanceId:f.b.ctx.instanceId,requestId:'move'});
  expect(stopped).toBe(true);expect(assigned.generation).toBe(2);expect((await f.runtime.snapshot(s.id)).status).toBe('cancelled');
  await expect(f.runtime.submit({sessionId:s.id,requestId:'late',text:'No'})).rejects.toMatchObject({code:'SESSION_CANCELLED'});
});
it('checks generation again at the tool boundary after a model request started',async()=>{
  let release!:()=>void;let requested!:()=>void;const active=new Promise<void>(r=>requested=r);const barrier=new Promise<void>(r=>release=r);let effects=0;
  const extension=defineExtension({name:'effect',tools:[defineTool({name:'effect',description:'effect',parameters:Type.Object({}),replay:'unsafe',async execute(){effects++;return {output:[]};}})]});
  const f=await setup([extension]);f.faux.setResponses([async()=>{requested();await barrier;return fauxAssistantMessage(fauxToolCall('effect',{}),{stopReason:'toolUse'});}]);
  const s=await f.runtime.createSession({agentId:'agent-ada',requestId:'s',projectId:'project'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});await active;await f.ownership.revokeLocal('project',1);release();
  await expect.poll(async()=>(await f.runtime.snapshot(s.id)).blockedReason).toBe('admission_closed');
  await f.runtime.cancel(s.id);expect(effects).toBe(0);
});
it('a later accepted project generation can admit a new session after an earlier runtime stop',async()=>{
  const f=await setup();await f.runtime.stopAndProve('project');
  // Exercise the generation-aware local runtime fence after a separately confirmed later grant.
  await f.a.ctx.store.transact(tx=>{
    const grant=tx.get<{remote:string;assignment:{generation:number}}>('assignment-grants','project')!;
    tx.put('assignment-grants','project',{...grant,assignment:{...grant.assignment,generation:3}});
  });
  const s=await f.runtime.createSession({agentId:'agent-ada',requestId:'new-generation',projectId:'project'});
  expect((await f.runtime.snapshot(s.id)).status).toBe('idle');
  expect(await f.a.ctx.store.read('process-fence','project')).toMatchObject({generation:1});
  const record=await f.a.ctx.store.read<import('../../src/runtime/types.js').SessionRecord>('runtime-session',s.id);
  expect((await f.supervisor.run({contextId:record!.executionContextId!,command:'printf new-generation',requestId:'after-transfer-back'})).output).toBe('new-generation');
});
it('runs CodeMode shell calls through the process journal and joins a live command during handoff',async()=>{
  const f=await setup();f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.bash({command:"sleep 30"}));'}),{stopReason:'toolUse'})]);
  const s=await f.runtime.createSession({agentId:'agent-ada',requestId:'shell',projectId:'project'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run shell'});
  await expect.poll(async()=> (await f.a.ctx.store.list<{state:string;start?:string}>('host-process')).some(p=>p.state==='running' && p.start!==undefined)).toBe(true);
  const assignment=await handoffProject({ownership:f.ownership,probe:f.runtime,projectId:'project',expectedGeneration:1,targetInstanceId:f.b.ctx.instanceId,requestId:'shell-handoff'});
  expect(assignment.generation).toBe(2);
  expect((await f.runtime.snapshot(s.id)).status).toBe('cancelled');
  const processes=await f.a.ctx.store.list<{state:string;settled?:boolean}>('host-process');
  expect(processes).toHaveLength(1);expect(processes[0]!.state==='stopped'||processes[0]!.settled).toBe(true);
});

async function bounded<T>(promise:Promise<T>,message:string):Promise<T> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([promise,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error(message)),750);})]);}
  finally{clearTimeout(timer);}
}
it('admits isolated Git writers responsively and cancels only the selected writer',async()=>{
  const f=await setup();
  const a=await f.runtime.createSession({agentId:'agent-ada',requestId:'writer-a',projectId:'project'});
  const other=await f.runtime.createSession({agentId:'agent-ada',requestId:'independent'});
  const pending=f.runtime.createSession({agentId:'agent-ada',requestId:'writer-b',projectId:'project'});
  const workspace=(await f.a.ctx.store.read<{workspaceId:string}>('runtime-session',a.id))!.workspaceId;
  try {
    const b=await bounded(pending,'writer contention blocked the shared runtime queue');
    expect((await f.runtime.snapshot(b.id)).status).toBe('idle');const second=(await f.a.ctx.store.read<{workspaceId:string}>('runtime-session',b.id))!.workspaceId;expect(second).not.toBe(workspace);
    f.faux.setResponses([fauxAssistantMessage('Independent work')]);
    await bounded(f.runtime.submit({sessionId:other.id,requestId:'other',text:'Hello'}),'unrelated submission blocked');
    await bounded(f.runtime.cancel(a.id),'writer cancellation blocked');
    expect((await f.a.ctx.store.read<{state:string}>('workspace',workspace))!.state).toBe('released');
    expect((await f.runtime.snapshot(b.id)).status).toBe('idle');
    await expect.poll(async()=>(await f.runtime.snapshot(other.id)).status).toBe('completed');
  } finally {
    // Unblock the old implementation after the bounded RED assertion, without leaving a hung teardown.
    await f.workspaces.release(workspace);await pending.catch(()=>{});
  }
});
it('can cancel a waiting writer and close without acquiring or leaking its write lock',async()=>{
  const f=await setup();
  const a=await f.runtime.createSession({agentId:'agent-ada',requestId:'owner',projectId:'project'});
  const pending=f.runtime.createSession({agentId:'agent-ada',requestId:'waiting',projectId:'project'});
  const workspace=(await f.a.ctx.store.read<{workspaceId:string}>('runtime-session',a.id))!.workspaceId;
  try {
    const b=await bounded(pending,'waiting writer prevented cancellation');
    await bounded(f.runtime.cancel(b.id),'waiting writer cancel did not settle');
    await bounded(f.runtime.cancel(a.id),'active writer cancel did not settle');
    const other=(await f.a.ctx.store.read<{workspaceId:string}>('runtime-session',b.id))!.workspaceId;expect(other).not.toBe(workspace);expect((await f.a.ctx.store.read<{state:string}>('workspace',other))!.state).toBe('released');
    await bounded(f.runtime.close(),'close waited on a cancelled allocation');
  } finally {await f.workspaces.release(workspace);await pending.catch(()=>{});}
});
it('reopens healthy sessions when another session has a durably failed worktree allocation',async()=>{
  const git=new GitClient();
  const f=await setup([],ctx=>new WorkspaceManager(ctx,{run:async(cwd,args)=>args.includes('worktree')?{stdout:'',stderr:'Injected worktree allocation failure',exitCode:1}:git.run(cwd,args)}));
  await f.ownership.claim({id:'git-failure',repositoryKey:'fork:git-failure',title:'Failed worktree'},'claim-failure');
  await bindProject(f.a.ctx,{projectId:'git-failure',path:await gitProject(join(f.root,'git-failure'))});
  const healthy=await f.runtime.createSession({agentId:'agent-ada',requestId:'healthy'});
  await f.runtime.createSession({agentId:'agent-ada',requestId:'failed',projectId:'git-failure'}).catch(()=>undefined);
  await f.reopen();
  const failed=(await f.a.ctx.store.list<{session:{id:string;projectId?:string}}>('runtime-session')).find(s=>s.session.projectId==='git-failure')!;
  expect((await f.runtime.snapshot(failed.session.id)).blockedReason).toBe('workspace_uncertain');
  f.faux.setResponses([fauxAssistantMessage('Healthy after reopen')]);
  await f.runtime.submit({sessionId:healthy.id,requestId:'healthy-run',text:'Continue'});
  await expect.poll(async()=>(await f.runtime.snapshot(healthy.id)).status).toBe('completed');
});
it('retains the writer lock when cancellation cannot prove process quiescence',async()=>{
  const f=await setup();const a=await f.runtime.createSession({agentId:'agent-ada',requestId:'uncertain-writer',projectId:'project'});
  const record=(await f.a.ctx.store.read<{workspaceId:string}>('runtime-session',a.id))!;
  const original=f.supervisor.stopWorkspace.bind(f.supervisor);
  f.supervisor.stopWorkspace=async()=>({quiescent:false,reason:'Process evidence is incomplete'});
  await expect(f.runtime.cancel(a.id)).rejects.toMatchObject({code:'NOT_QUIESCENT'});
  expect((await f.a.ctx.store.read<{cancellationSettled?:true}>('runtime-session',a.id))!.cancellationSettled).toBeUndefined();
  expect((await f.a.ctx.store.read<{state:string}>('workspace',record.workspaceId))!.state).toBe('active');
  const b=await f.runtime.createSession({agentId:'agent-ada',requestId:'blocked-writer',projectId:'project'});
  expect((await f.runtime.snapshot(b.id)).status).toBe('idle');expect((await f.a.ctx.store.read<{workspaceId:string}>('runtime-session',b.id))!.workspaceId).not.toBe(record.workspaceId);
  f.supervisor.stopWorkspace=original;await f.runtime.cancel(a.id);
  expect((await f.a.ctx.store.read<{cancellationSettled?:true}>('runtime-session',a.id))!.cancellationSettled).toBe(true);
  await f.reopen();expect((await f.a.ctx.store.read<{cancellationSettled?:true}>('runtime-session',a.id))!.cancellationSettled).toBe(true);
  expect((await f.runtime.snapshot(b.id)).status).toBe('idle');
});
it('isolates ownership revocation during allocation from unrelated sessions on reopen',async()=>{
  const f=await setup();const healthy=await f.runtime.createSession({agentId:'agent-ada',requestId:'healthy'});
  const original=f.ownership.assertOwner.bind(f.ownership);let revoke=true;
  f.ownership.assertOwner=async(project,generation)=>{if(revoke){revoke=false;await f.ownership.revokeLocal(project,generation);}await original(project,generation);};
  const blocked=await f.runtime.createSession({agentId:'agent-ada',requestId:'revoked',projectId:'project'});
  expect((await f.runtime.snapshot(blocked.id)).blockedReason).toBe('admission_closed');
  await f.reopen();f.faux.setResponses([fauxAssistantMessage('Independent')]);
  await f.runtime.submit({sessionId:healthy.id,requestId:'continue',text:'Continue'});
  await expect.poll(async()=>(await f.runtime.snapshot(healthy.id)).status).toBe('completed');
});
it('does not turn unexpected allocation infrastructure failure into an ordinary blocked session',async()=>{
  const f=await setup();
  f.workspaces.acquire=async()=>{throw new Error('Unexpected infrastructure failure');};
  await expect(f.runtime.createSession({agentId:'agent-ada',requestId:'infra',projectId:'project'})).rejects.toThrow('Unexpected infrastructure failure');
  await expect(f.reopen()).rejects.toThrow('Unexpected infrastructure failure');
});
it('observes an admitted session before workspace allocation without sending an undefined Pi identity',async()=>{
 let reached!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>reached=r),held=new Promise<void>(r=>release=r);
 const f=await setup([],ctx=>{const manager=new WorkspaceManager(ctx),acquire=manager.acquire.bind(manager);manager.acquire=async(...args)=>{reached();await held;return acquire(...args);};return manager;});
 const creating=f.runtime.createSession({agentId:'agent-ada',requestId:'observed-during-allocation',projectId:'project'});void creating.catch(()=>{});await entered;
 try{const record=(await f.a.ctx.store.list<import('../../src/runtime/types.js').SessionRecord>('runtime-session'))[0]!;expect(record.conversationId).toBeUndefined();const view=await f.runtime.snapshot(record.session.id);expect(view).toMatchObject({session:{id:record.session.id},status:'blocked',messages:[]});}finally{release();}
 const session=await creating;f.faux.setResponses([fauxAssistantMessage('Still healthy')]);await f.runtime.submit({sessionId:session.id,requestId:'after-observation',text:'Hello'});await expect.poll(async()=>(await f.runtime.snapshot(session.id)).status).toBe('completed');
});
