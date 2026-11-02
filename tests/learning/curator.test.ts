import { applyAccepted } from '../../src/sync/apply.js';
import { revisionOf } from '../../src/vault/parse.js';
import { curatorTools } from '../../src/learning/tools.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { afterEach, expect, it } from 'vitest';
import { cp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { openWorkloadOwnership } from '../../src/projects/workload-grants.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { openVault } from '../../src/vault/write.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
import { openCurator } from '../../src/learning/curator.js';
import type { LearningEvent } from '../../src/learning/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fleet(){const f=await gitFleet();cleanup.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,f.remote);return f;}
async function fixture(){
 const f=await fleet();const {ctx,git}=f.a;await cp('tests/fixtures/vault',ctx.vaultDir,{recursive:true});
 const path=join(ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
 const provider=scriptedProvider();const vault=openVault(ctx);const workload=openWorkloadOwnership(ctx,git,f.remote);
 // This fleet deliberately exercises the retained historical assignment protocol.
 // Inject its matching workload service; normal runtimes use the native domain adapter.
 const options={ctx,vault,ownership:openOwnership(ctx,git,f.remote),workloadOwnership:workload,workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models};
 let runtime=await openRuntime(options);let expectedUncertainClose=false;cleanup.push(async()=>{if(expectedUncertainClose)await expect(runtime.close()).rejects.toMatchObject({code:'NOT_QUIESCENT'});else await runtime.close();});
 const curator=()=>openCurator({ctx,vault,runtime,ownership:workload});
 return {...f,ctx,vault,workload,supervisor:options.supervisor,...provider,get runtime(){return runtime;},curator,async reopen(uncertain=false){if(uncertain){expectedUncertainClose=true;await expect(runtime.close()).rejects.toMatchObject({code:'NOT_QUIESCENT'});}else await runtime.close();runtime=await openRuntime(options);}};
}
const event=(instanceId:string):LearningEvent=>({id:'event-1',taskId:'task-1',instanceId,agentId:'agent-ada',model:{provider:'scripted',modelId:'test-model'},historyPaths:[],changedCommits:[],testReceipts:[],outcome:{summary:'A lesson'}});
it('serializes workload claims on the assignment branch without creating project grants, confirms lost acknowledgments and continues offline',async()=>{
 const f=await fleet();const a=openWorkloadOwnership(f.a.ctx,f.a.git,f.remote),b=openWorkloadOwnership(f.b.ctx,f.b.git,f.remote);
 f.raceNextPushes();const results=await Promise.allSettled([a.claim('curator','a'),b.claim('curator','b')]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(await f.readAssignments()).toEqual([]);expect(await f.a.ctx.store.list('assignment-grants')).toEqual([]);
 f.a.loseNextPushAck();const grant=await a.claim('other','lost');expect(grant.ownerId).toBe(f.a.ctx.instanceId);
 await f.disconnect();await expect(a.assertOwner('other',grant.generation)).resolves.toBeUndefined();await expect(a.claim('new','offline')).rejects.toMatchObject({code:'ASSIGNMENT_UNCONFIRMED'});
});
it('closes, proves and revokes the exact workload transition before transfer and cannot reopen old generations',async()=>{
 const f=await fleet();const a=openWorkloadOwnership(f.a.ctx,f.a.git,f.remote),b=openWorkloadOwnership(f.b.ctx,f.b.git,f.remote);await a.claim('curator','initial');
 const input={workloadId:'curator',expectedGeneration:1,targetInstanceId:f.b.ctx.instanceId,transitionId:'move'};
 await expect(a.transfer({...input,probe:{stopAndProve:async()=>({quiescent:false})}})).rejects.toMatchObject({code:'NOT_QUIESCENT'});
 await expect(a.assertOwner('curator',1)).rejects.toMatchObject({code:'ADMISSION_CLOSED'});
 f.a.loseNextPushAck();const moved=await a.transfer({...input,probe:{stopAndProve:async()=>({quiescent:true})}});expect(moved.generation).toBe(2);
 expect(await b.accept('curator')).toEqual(moved);await expect(a.accept('curator')).rejects.toMatchObject({code:'NOT_OWNER'});await expect(a.assertOwner('curator',1)).rejects.toMatchObject({code:'OWNER_REVOKED'});
});
it('waits visibly without assignment, never runs the nonowner, and resumes one ordinary Pi consolidation after receipt loss and restart',async()=>{
 const f=await fixture();await f.runtime.learning.captureLesson(event(f.ctx.instanceId));await f.curator().tick();expect((await f.curator().status()).state).toBe('waiting_assignment');expect(f.faux.state.callCount).toBe(0);
 await f.curator().assign({agentId:'agent-ada',ownerId:f.b.ctx.instanceId,generation:1});await f.curator().tick();expect(f.faux.state.callCount).toBe(0);
 const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:grant.generation});
 f.faux.setResponses([fauxAssistantMessage('Consolidated')]);await f.curator().tick();await expect.poll(()=>f.faux.state.callCount).toBe(1);await f.reopen();await f.curator().tick();await f.runtime.learning.captureLesson(event(f.ctx.instanceId));await f.curator().tick();expect(f.faux.state.callCount).toBe(1);
 const records=await f.ctx.store.list<any>('runtime-session');expect(records).toHaveLength(1);expect(records[0].session.projectId).toBeUndefined();expect(records[0].session.model.modelId).toBe('test-model');expect(records[0].cwd.startsWith(join(f.ctx.stateDir,'staging'))).toBe(true);
});
it('checkpoints priority at the next nested tool boundary and resumes after foreground dependencies stop being runnable',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});
 // A durable runnable foreground submission blocks background admission; a human wait does not.
 await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'running',dependsOn:[],executingSessionId:'fg'}));
 await f.runtime.learning.captureLesson(event(f.ctx.instanceId));f.faux.setResponses([fauxAssistantMessage('Consolidated')]);await f.curator().tick();
 const job=(await f.ctx.store.list<any>('curator-work'))[0];await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).blockedReason).toBe('foreground_priority');
 expect(f.faux.state.callCount).toBe(0);await f.reopen();expect((await f.runtime.snapshot(job.sessionId)).blockedReason).toBe('foreground_priority');expect(f.faux.state.callCount).toBe(0);
 await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'waiting_decision',dependsOn:[],executingSessionId:'fg'}));await f.curator().tick();await expect.poll(()=>f.faux.state.callCount).toBe(1);
});
it('retains both conflict evidence references in a bounded tentative proposal and excludes generic Git/project tools',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});
 const conflict={id:'disagreement',batchId:'batch',originId:'other',paths:['lessons/shared.md'],reason:'different remedies',versions:[{path:'lessons/shared.md',base:{hash:'base',commit:'base-commit',path:'lessons/shared.md'},left:{hash:'left',commit:'left-commit',path:'lessons/shared.md'},right:{hash:'right',commit:'right-commit',path:'lessons/shared.md'}}]};
 await f.ctx.store.transact(tx=>tx.put('curator-work','conflict:disagreement',{id:'conflict:disagreement',sourcePaths:conflict.paths,conflict,state:'pending'}));
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.curator_propose({kind:"lesson",title:"Preserved disagreement",description:"Two candidate remedies",body:"Keep both claims until tests establish applicability."})); text(Object.keys(tools));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Proposed')]);
 await f.curator().tick();await expect.poll(async()=>(await f.vault.list()).filter(c=>c.metadata.type==='LearningProposal').length).toBe(1);
 const proposal=(await f.vault.list()).find(c=>c.metadata.type==='LearningProposal')!;expect(JSON.stringify(proposal)).toContain('left-commit');expect(JSON.stringify(proposal)).toContain('right-commit');expect(proposal.metadata.evidenceState).toBe('tentative');expect(proposal.metadata.verified).toBeUndefined();
 const job=(await f.ctx.store.list<any>('curator-work'))[0];await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).status).toBe('completed');const history=JSON.stringify((await f.runtime.snapshot(job.sessionId)).tools);expect(history).not.toContain('"bash"');
});
it('runs fixture tests only in a separate workload workspace and rejects traversal paths',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});await f.runtime.learning.captureLesson(event(f.ctx.instanceId));
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'try { text(await tools.curator_test({files:[{path:"../escape.test.mjs",content:""}]})); } catch(e) { text(String(e)); } text(await tools.curator_test({files:[{path:"sample.test.mjs",content:"import {test} from \'node:test\'; import {strict as assert} from \'node:assert\'; test(\'fixture\',()=>assert.equal(2+2,4));"}]}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Tested')]);
 await f.curator().tick();await expect.poll(async()=>(await f.ctx.store.list('learning-execution')).length).toBe(1);
 const executions=await f.ctx.store.list<any>('learning-execution');expect(executions[0].exitCode).toBe(0);const processes=await f.ctx.store.list<any>('host-process');expect(processes).toHaveLength(1);expect(processes[0].projectId).toBeUndefined();expect(processes[0].workloadId).toBe('curator');
 expect(await f.ctx.store.list('workspace')).toEqual([]);const workspaces=await f.ctx.store.list<any>('workload-workspace');expect(workspaces[0].path.startsWith(join(f.ctx.stateDir,'staging'))).toBe(true);
});
it('lets an in-flight background model call finish, then runs foreground before a nested curator tool',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});await f.runtime.learning.captureLesson(event(f.ctx.instanceId));
 let finishBackground!:()=>void;const backgroundCall=new Promise<void>(resolve=>{finishBackground=resolve;});let finishForeground!:()=>void;const foregroundCall=new Promise<void>(resolve=>{finishForeground=resolve;});const order:string[]=[];
 f.faux.setResponses([async()=>{order.push('background-model');await backgroundCall;return fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.curator_propose({kind:"lesson",title:"After foreground",description:"Waited",body:"Preserve evidence"}));'}),{stopReason:'toolUse'});},async()=>{order.push('foreground-model');await foregroundCall;return fauxAssistantMessage('Foreground done');},()=>{order.push('background-next-model');return fauxAssistantMessage('Background done');}]);
 await f.curator().tick();await expect.poll(()=>order.length).toBe(1);
 const foreground=await f.runtime.createSession({requestId:'foreground',agentId:'agent-ada'});await f.runtime.submit({sessionId:foreground.id,requestId:'fg-submit',text:'Foreground task'});await expect.poll(()=>order.length).toBe(2);
 finishBackground();const job=(await f.ctx.store.list<any>('curator-work'))[0];await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).blockedReason).toBe('foreground_priority');expect((await f.vault.list()).filter(c=>c.metadata.type==='LearningProposal')).toHaveLength(0);
 finishForeground();await expect.poll(async()=>(await f.vault.list()).filter(c=>c.metadata.type==='LearningProposal').length).toBe(1);await expect.poll(()=>order.length).toBe(3);expect(order).toEqual(['background-model','foreground-model','background-next-model']);
});
it('rechecks revoked workload admission after a durable priority wait before any model request',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});await f.runtime.learning.captureLesson(event(f.ctx.instanceId));
 await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'running',dependsOn:[],executingSessionId:'fg'}));await f.curator().tick();const job=(await f.ctx.store.list<any>('curator-work'))[0];await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).blockedReason).toBe('foreground_priority');await f.workload.revoke('curator',1);
 await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'completed',dependsOn:[],executingSessionId:'fg'}));await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).blockedReason).toBe('owner_revoked');expect(f.faux.state.callCount).toBe(0);
});
it('runtime lifecycle drains captured work using the explicit assignment without a manual curator tick',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});f.faux.setResponses([fauxAssistantMessage('Automatic consolidation')]);await f.runtime.learning.captureLesson(event(f.ctx.instanceId));await expect.poll(()=>f.faux.state.callCount,{timeout:2000}).toBe(1);
});

it('queues shared lesson revisions once, keeps changed claims distinct, and never feeds curator output back into itself',async()=>{
 const f=await fixture();const path='lessons/shared.md';const one='---\n{"type":"Lesson","title":"Remote lesson"}\n---\nUse version one\n';const two=one.replace('version one','version two');
 await applyAccepted({ctx:f.ctx,vault:f.vault,commit:'first',files:[{path,content:one,baseHash:null}]});await applyAccepted({ctx:f.ctx,vault:f.vault,commit:'first',files:[{path,content:one,baseHash:null}]});expect(await f.ctx.store.list('curator-work')).toHaveLength(1);
 await applyAccepted({ctx:f.ctx,vault:f.vault,commit:'second',files:[{path,content:two,baseHash:revisionOf(one)}]});expect(await f.ctx.store.list('curator-work')).toHaveLength(2);
 await applyAccepted({ctx:f.ctx,vault:f.vault,commit:'third',files:[{path:'learning/proposals/example.md',content:'---\ntype: LearningProposal\n---\nA resolution\n',baseHash:null}]});expect(await f.ctx.store.list('curator-work')).toHaveLength(2);
});
it('replays a lost proposal receipt with original source bytes even when the lesson changes before restart',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});const captured=await f.runtime.learning.captureLesson(event(f.ctx.instanceId));
 const session=await f.runtime.createSession({requestId:'manual-curator',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});await f.ctx.store.transact(tx=>tx.put('curator-work','manual',{id:'manual',sourcePaths:[captured.path],sessionId:session.id,generation:1,state:'running',prompt:'fixture'}));
 const record=(await f.ctx.store.list<any>('runtime-session')).find(r=>r.session.id===session.id);const tools=curatorTools(f.ctx,f.vault,new ProcessSupervisor(f.ctx),()=>record);const proposal=tools.tools!.find(t=>t.name==='curator_propose')! as import('@earendil-works/pi-durable').ToolRegistration;
 const args={kind:'lesson',title:'Resolution',description:'Captured sources',body:'A proposal'};const api={conversationId:record.conversationId,taskId:98765} as any;const propose=f.vault.propose;let fail=true;f.vault.propose=async input=>{const result=await propose(input);if(fail){fail=false;throw new Error('lost receipt');}return result;};
 await expect(proposal.execute(args,api,BACKGROUND_CONTEXT)).rejects.toThrow('lost receipt');const before=(await f.vault.list()).find(c=>c.metadata.type==='LearningProposal')!;
 const source=await f.vault.read(captured.path);await propose({id:'source-edit',path:captured.path,expectedRevision:source.revision,actor:'human',content:{metadata:{},body:'Contradictory new remedy'}});
 await expect(proposal.execute(args,api,BACKGROUND_CONTEXT)).resolves.toBeDefined();expect((await f.vault.read(before.path)).revision).toBe(before.revision);
});

it('keeps a completed background result completed when new foreground work arrives',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});f.faux.setResponses([fauxAssistantMessage('Done')]);await f.runtime.learning.captureLesson(event(f.ctx.instanceId));await f.curator().tick();const job=(await f.ctx.store.list<any>('curator-work'))[0];await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).status).toBe('completed');
 await f.ctx.store.transact(tx=>tx.put('team-task','fg',{id:'fg',state:'running',dependsOn:[],executingSessionId:'missing'}));expect((await f.runtime.snapshot(job.sessionId)).status).toBe('completed');
});
it('blocks a changed workload staging path instead of resuming in another workspace',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});const session=await f.runtime.createSession({requestId:'symlink',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});
 const record=(await f.ctx.store.list<any>('runtime-session')).find(r=>r.session.id===session.id);const root=record.cwd;const {rename}=await import('node:fs/promises');await rename(root,root+'-preserved');await symlink(f.ctx.vaultDir,root);
 f.faux.setResponses([fauxAssistantMessage('Must not run')]);await f.runtime.submit({sessionId:session.id,requestId:'run',text:'Try'});expect((await f.runtime.snapshot(session.id)).blockedReason).toBe('unsafe_workspace');expect(f.faux.state.callCount).toBe(0);
});
it('uses the real Pi quiescence probe to transfer a waiting curator and never resumes its revoked generation',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});await f.ctx.store.transact(tx=>tx.put('team-task','fg',{id:'fg',state:'running',dependsOn:[],executingSessionId:'missing'}));await f.runtime.learning.captureLesson(event(f.ctx.instanceId));await f.curator().tick();
 const job=(await f.ctx.store.list<any>('curator-work'))[0];await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).blockedReason).toBe('foreground_priority');
 const next=await f.workload.transfer({workloadId:'curator',expectedGeneration:1,targetInstanceId:f.b.ctx.instanceId,transitionId:'real-runtime-transfer',probe:{stopAndProve:id=>f.runtime.stopWorkloadAndProve(id)}});expect(next.generation).toBe(2);expect(await openWorkloadOwnership(f.b.ctx,f.b.git,f.remote).accept('curator')).toEqual(next);
 await f.reopen();expect((await f.runtime.snapshot(job.sessionId)).status).toBe('cancelled');expect(f.faux.state.callCount).toBe(0);await expect(f.workload.assertOwner('curator',1)).rejects.toMatchObject({code:'OWNER_REVOKED'});
});

async function survivingFixture(detached:boolean){
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});await f.runtime.learning.captureLesson(event(f.ctx.instanceId));
 const content=`import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:${detached},stdio:'ignore'}); writeFileSync('child.pid',String(child.pid)); child.unref();`;
 const code=`text(await tools.curator_test(${JSON.stringify({files:[{path:'child.test.mjs',content}]})}));`;
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'}),fauxAssistantMessage('Fixture returned')]);await f.curator().tick();const job=(await f.ctx.store.list<any>('curator-work'))[0];
 await expect.poll(async()=>(await f.runtime.snapshot(job.sessionId)).status).toBe('completed');const processRecord=(await f.ctx.store.list<any>('host-process'))[0];const workspace=await f.ctx.store.read<any>('workload-workspace',processRecord.workspaceId);const invocation=(await f.ctx.store.list<any>('workload-workspace')).find(w=>w.id!==workspace.id&&processRecord.command.includes(w.path));const pid=Number(await readFile(join(invocation.path,'child.pid'),'utf8'));
 cleanup.push(async()=>{try{process.kill(pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}});
 return {...f,get runtime(){return f.runtime;},sessionId:job.sessionId as string,processRecord,workspace,pid};
}
it('cancellation joins every returned fixture proof and leaves another workload session untouched',async()=>{
 const f=await survivingFixture(false);expect(f.processRecord.settled).toBe(false);expect(f.workspace.taskId).toBe(f.sessionId);
 const sibling=await f.runtime.createSession({requestId:'uncancelled-sibling',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});const siblingRecord=await f.ctx.store.read<any>('runtime-session',sibling.id);
 const original=f.supervisor.stopWorkspace.bind(f.supervisor);let reached=false;let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});cleanup.push(async()=>{release();});
 f.supervisor.stopWorkspace=async id=>{const proof=await original(id);if(id===f.workspace.id){reached=true;await held;}return proof;};
 let done=false;const cancel=f.runtime.cancel(f.sessionId).then(()=>{done=true;});await expect.poll(()=>reached).toBe(true);expect(done).toBe(false);expect((await f.ctx.store.read<any>('runtime-session',f.sessionId)).cancellationSettled).toBeUndefined();
 release();await cancel;expect((await f.ctx.store.read<any>('runtime-session',f.sessionId)).cancellationSettled).toBe(true);expect((await f.ctx.store.read<any>('host-process',f.processRecord.id)).state).toBe('stopped');
 expect((await f.ctx.store.read<any>('runtime-session',sibling.id)).cancelled).toBeUndefined();expect(await f.ctx.store.read('workspace-process-fence',siblingRecord.workspaceId)).toBeUndefined();
});
it('cancellation refuses an escaped returned fixture after restart and retains unsettled session ownership',async()=>{
 const f=await survivingFixture(true);expect(f.processRecord.state).toBe('uncertain');await f.reopen(true);
 expect((await f.ctx.store.read<any>('workload-workspace',f.workspace.id)).taskId).toBe(f.sessionId);await expect(f.runtime.cancel(f.sessionId)).rejects.toMatchObject({code:'NOT_QUIESCENT'});
 expect((await f.ctx.store.read<any>('runtime-session',f.sessionId)).cancellationSettled).toBeUndefined();await f.reopen(true);await expect(f.runtime.cancel(f.sessionId)).rejects.toMatchObject({code:'NOT_QUIESCENT'});
 expect((await f.ctx.store.read<any>('runtime-session',f.sessionId)).cancellationSettled).toBeUndefined();
});
it('joins the active fixture abort proof before acknowledging cancellation',async()=>{
 const f=await fixture();const grant=await f.workload.claim('curator','assign');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});await f.runtime.learning.captureLesson(event(f.ctx.instanceId));
 const content="import {test} from 'node:test'; test('long fixture',async()=>{await new Promise(resolve=>setTimeout(resolve,10000));});";const code=`text(await tools.curator_test(${JSON.stringify({files:[{path:'long.test.mjs',content}]})}));`;
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'}),fauxAssistantMessage('Should be cancelled')]);await f.curator().tick();const job=(await f.ctx.store.list<any>('curator-work'))[0];
 await expect.poll(async()=>(await f.ctx.store.list<any>('host-process'))[0]?.state).toBe('running');const host=(await f.ctx.store.list<any>('host-process'))[0];
 await f.runtime.cancel(job.sessionId);expect((await f.ctx.store.read<any>('runtime-session',job.sessionId)).cancellationSettled).toBe(true);expect((await f.ctx.store.read<any>('host-process',host.id)).state).toBe('stopped');
});
it.each(['low','alien'])('uses or rejects the actual curator thinking choice %s',async level=>{
 const f=await fixture(),c=await f.vault.read('agents/ada.md'),agent=c.metadata.lorecrew as any;await f.vault.propose({id:'thinking-curator',path:c.path,expectedRevision:c.revision,actor:'fixture',content:{metadata:{lorecrew:{...agent,model:{...agent.model,thinkingLevel:level}}}}});
 const seen:unknown[]=[];f.faux.setResponses([(_c,options)=>{seen.push(options?.reasoning);return fauxAssistantMessage('Curator thinking');}]);const grant=await f.workload.claim('curator','thinking-claim');await f.curator().assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:grant.generation});await f.runtime.learning.captureLesson(event(f.ctx.instanceId));await f.curator().tick();
 if(level==='alien'){expect(await f.curator().status()).toMatchObject({state:'blocked',reason:'UNSUPPORTED_THINKING_LEVEL'});expect(seen).toEqual([]);expect(await f.ctx.store.list('runtime-session')).toEqual([]);}else{await expect.poll(()=>seen).toEqual(['low']);}
});
