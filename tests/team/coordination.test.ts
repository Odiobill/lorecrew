import {gitProject} from '../helpers/git-project.js';
import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';
import { DatabaseSync } from 'node:sqlite';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { bindProject } from '../../src/projects/bindings.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openVault } from '../../src/vault/write.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { stableId } from '../../src/runtime/admission.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function fixture(extensions:Extension[]=[],plain=false) {
  const f=await gitFleet();cleanup.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,'origin');
  const ownership=openOwnership(f.a.ctx,f.a.git,'origin');await ownership.claim({id:'project',repositoryKey:'fork:team',title:'Team'},'claim');
  await cp('tests/fixtures/vault/agents',join(f.a.ctx.vaultDir,'agents'),{recursive:true});
  for(const name of ['ada','lin']) {
    const path=join(f.a.ctx.vaultDir,`agents/${name}.md`);
    await writeFile(path,(await readFile(path,'utf8')).replaceAll('local-openai','scripted').replaceAll('coding-model','test-model').replaceAll('local-anthropic','scripted').replaceAll('review-model','test-model'));
  }
  // Concurrent writers get actual separate Git worktrees.
  const project=await gitProject(join(f.root,plain?'legacy-case-converted-code':'code-project'));
  await bindProject(f.a.ctx,{projectId:'project',path:project});
  const provider=scriptedProvider();provider.faux.setResponses(Array.from({length:30},()=>fauxAssistantMessage('Ready')));
  const options={ctx:f.a.ctx,vault:openVault(f.a.ctx),ownership,workspaces:new WorkspaceManager(f.a.ctx),supervisor:new ProcessSupervisor(f.a.ctx),models:provider.models,extensions};
  let runtime=await openRuntime(options);cleanup.push(()=>runtime.close());
  return {...f,...provider,supervisor:options.supervisor,get runtime(){return runtime;},get team(){return runtime.team;},async reopen(){await runtime.close();runtime=await openRuntime(options);}};
}
const rootInput={requestId:'root',projectId:'project',leadAgentId:'agent-ada',objective:'Coordinate changes'};
const assignment=(parentTaskId:string,requestId='child')=>({requestId,parentTaskId,agentId:'agent-lin',objective:'Implement change',deliverable:'Patch and checks',contextPaths:['index.md'],dependsOn:[] as string[]});
it('deduplicates delegation and records real Pi child ownership and separate workspaces',async()=>{
  const f=await fixture();expect(f.team).toBeDefined();const root=await f.team.createTask(rootInput);
  const child=await f.team.delegate(assignment(root.id));expect((await f.team.delegate(assignment(root.id))).id).toBe(child.id);
  expect(child.workspaceId).not.toBe(root.workspaceId);expect((await f.a.ctx.store.read<{branch:string}>('workspace',root.workspaceId))!.branch).toMatch(/^lorecrew\/lead\/project\//);expect(child.returnSessionId).toBe(root.leadSessionId);
  await f.reopen();expect((await f.team.delegate(assignment(root.id))).id).toBe(child.id);
  const db=new DatabaseSync(join(f.a.ctx.stateDir,'pi.sqlite'),{readOnly:true});
  try {const rows=db.prepare('SELECT * FROM conversations').all();expect(rows).toHaveLength(2);expect(JSON.stringify(rows)).toContain('task');}finally{db.close();}
  await expect(f.team.delegate({...assignment(root.id),objective:'Conflicting request'})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
});
it('blocks only decision dependents and persists answers, steering and complete outcomes',async()=>{
  const f=await fixture();expect(f.team).toBeDefined();const root=await f.team.createTask(rootInput);
  const child=await f.team.delegate(assignment(root.id));const independent=await f.team.delegate(assignment(root.id,'independent'));
  await f.team.ask({id:'choice',taskId:root.id,question:'Which approach?',recommendation:'Small change',blockedTaskIds:[child.id]});
  expect((await f.team.getTask(child.id)).state).toBe('waiting_decision');expect((await f.team.getTask(independent.id)).state).toBe('running');
  await f.team.steer({taskId:child.id,requestId:'steer',text:'Change the scope'});
  await expect.poll(async()=>JSON.stringify((await f.runtime.snapshot(root.leadSessionId)).messages)).toContain('Change the scope');
  await f.reopen();expect((await f.team.getTask(child.id)).state).toBe('waiting_decision');
  await f.team.answer({id:'choice',requestId:'answer',text:'Use the small change'});
  expect((await f.team.getTask(child.id)).state).toBe('running');
  expect((await f.a.ctx.store.read<{state:string;answer:string}>('team-decision','choice'))).toMatchObject({state:'answered',answer:'Use the small change'});
  await f.team.report({taskId:child.id,requestId:'result',outcome:{summary:'Done',tests:['passing']},state:'completed'});
  expect((await f.team.getTask(child.id))).toMatchObject({state:'completed',outcome:{summary:'Done',tests:['passing']}});
  await expect.poll(async()=>JSON.stringify((await f.runtime.snapshot(root.leadSessionId)).messages)).toContain('passing');
  const history=await f.runtime.history(root.leadSessionId);expect(history.some(e=>e.kind==='delegation'&&JSON.stringify(e.data).includes(child.id))).toBe(true);expect(history.filter(e=>e.kind==='decision')).toHaveLength(2);expect(JSON.stringify(history)).toContain('Use the small change');
});
it('recovers a peer message after delivery receipt loss without duplicating input',async()=>{
  const f=await fixture();expect(f.team).toBeDefined();const root=await f.team.createTask(rootInput);const child=await f.team.delegate(assignment(root.id));
  const original=f.a.ctx.store.transact;let fail=true;
  f.a.ctx.store.transact=fn=>original(tx=>fn({...tx,delete(kind,id){if(fail&&kind==='team-outbox'){fail=false;throw new Error('lost team receipt');}tx.delete(kind,id);}}));
  const input={id:'peer',fromSessionId:root.leadSessionId,toSessionId:child.executingSessionId,text:'Unique peer text'};
  await expect(f.team.message(input)).rejects.toThrow('lost team receipt');await f.reopen();await f.team.message(input);
  await expect.poll(async()=>(await f.runtime.snapshot(child.executingSessionId)).messages.filter(m=>m.kind==='user'&&JSON.stringify(m.data).includes('Unique peer text')).length).toBe(1);
  expect(await f.a.ctx.store.list('team-outbox')).toHaveLength(0);
});
it('rejects remote recipients and dependency cycles before admitting any child execution',async()=>{
  const f=await fixture();expect(f.team).toBeDefined();const root=await f.team.createTask(rootInput);
  await expect(f.team.message({id:'remote',fromSessionId:root.leadSessionId,toSessionId:'remote-instance:session',text:'No remote control'})).rejects.toMatchObject({code:'SESSION_NOT_FOUND'});
  const self=stableId(f.a.ctx.instanceId,'team-task','cycle');
  await expect(f.team.delegate({...assignment(root.id,'cycle'),dependsOn:[self]})).rejects.toMatchObject({code:'DEPENDENCY_CYCLE'});
  await expect(f.team.delegate({...assignment(root.id,'parent-cycle'),dependsOn:[root.id]})).rejects.toMatchObject({code:'DEPENDENCY_CYCLE'});
  expect(await f.a.ctx.store.list('team-task')).toHaveLength(1);
});
it('records helper provenance without changing portable agents and waits for prerequisite outcomes',async()=>{
  const f=await fixture();expect(f.team).toBeDefined();const root=await f.team.createTask(rootInput);const child=await f.team.delegate(assignment(root.id));
  const before=await readFile(join(f.a.ctx.vaultDir,'agents/ada.md'),'utf8');
  const helper=await f.team.delegate({...assignment(root.id,'helper'),agentId:'helper:reviewer',dependsOn:[child.id]});
  expect(helper.temporaryIdentity).toMatchObject({id:'helper:reviewer',sourceAgentId:'agent-ada'});expect(helper.state).toBe('pending');
  await f.team.report({taskId:child.id,requestId:'result',state:'completed',outcome:{summary:'Patch ready'}});
  expect((await f.team.getTask(helper.id)).state).toBe('running');await expect.poll(async()=>(await f.runtime.snapshot(helper.executingSessionId)).messages.some(m=>m.kind==='assistant')).toBe(true);expect(await readFile(join(f.a.ctx.vaultDir,'agents/ada.md'),'utf8')).toBe(before);
});
it('exposes working replay-safe team tools to a real Pi model and CodeMode',async()=>{
  const f=await fixture();expect(f.team).toBeDefined();
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.team_delegate({agentId:"helper:tester",objective:"Check patch",deliverable:"Test report",contextPaths:[],dependsOn:[]}));'}),{stopReason:'toolUse'}),...Array.from({length:10},()=>fauxAssistantMessage('Delegated'))]);
  const root=await f.team.createTask(rootInput);
  await expect.poll(async()=>(await f.a.ctx.store.list<{parentTaskId?:string}>('team-task')).filter(t=>t.parentTaskId===root.id).length).toBe(1);
  await f.reopen();expect((await f.a.ctx.store.list('team-task')).length).toBe(2);
});

it('cancels owned child execution and releases every child workspace when its lead is cancelled',async()=>{
  let entered!:()=>void;const active=new Promise<void>(r=>entered=r);let stopped=false;
  const wait=defineExtension({name:'team-wait',tools:[defineTool({name:'wait',description:'Wait',parameters:Type.Object({}),replay:'safe',async execute(_a,_api,c){entered();await new Promise<void>((_r,reject)=>c.abortSignal?.addEventListener('abort',()=>{stopped=true;reject(new Error('cancelled'));},{once:true}));return {output:[]};}})]});
  const f=await fixture([wait]);const root=await f.team.createTask(rootInput);
  await expect.poll(async()=>(await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('wait',{}),{stopReason:'toolUse'})]);
  const child=await f.team.delegate(assignment(root.id));await active;
  await f.runtime.cancel(root.executingSessionId);expect(stopped).toBe(true);
  expect((await f.runtime.snapshot(child.executingSessionId)).status).toBe('cancelled');
  expect((await f.team.getTask(child.id)).state).toBe('cancelled');
  for(const task of [root,child])expect((await f.a.ctx.store.read<{state:string}>('workspace',task.workspaceId))!.state).toBe('released');
});
it('admits a helper in a distinct Git worktree without a capability bypass',async()=>{
  const f=await fixture([],true);const root=await f.team.createTask(rootInput);const child=await f.team.delegate(assignment(root.id));
  expect((await f.a.ctx.store.list<{state:string}>('workspace')).filter(w=>w.state==='active')).toHaveLength(2);expect(child.workspaceId).not.toBe(root.workspaceId);
  await f.runtime.cancel(root.executingSessionId);
});
it('gates an in-flight tool for a decision while independent work runs, and resumes on answer',async()=>{
  let effects=0;let requested!:()=>void;const active=new Promise<void>(r=>requested=r);let release!:()=>void;const barrier=new Promise<void>(r=>release=r);
  const effect=defineExtension({name:'team-effect',tools:[defineTool({name:'effect',description:'Effect',parameters:Type.Object({}),replay:'safe',async execute(){effects++;return {output:[]};}})]});
  const f=await fixture([effect]);const root=await f.team.createTask(rootInput);await expect.poll(async()=>(await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
  f.faux.setResponses([async()=>{requested();await barrier;return fauxAssistantMessage(fauxToolCall('effect',{}),{stopReason:'toolUse'});},...Array.from({length:10},()=>fauxAssistantMessage('Done'))]);
  const child=await f.team.delegate(assignment(root.id));await active;
  await f.team.ask({id:'gate',taskId:root.id,question:'Proceed?',recommendation:'Yes',blockedTaskIds:[child.id]});release();
  await expect.poll(async()=>(await f.runtime.snapshot(child.executingSessionId)).blockedReason).toBe('waiting_decision');
  const other=await f.team.delegate(assignment(root.id,'other'));await expect.poll(async()=>(await f.runtime.snapshot(other.executingSessionId)).messages.some(m=>m.kind==='assistant')).toBe(true);expect(effects).toBe(0);
  await f.team.answer({id:'gate',requestId:'yes',text:'Proceed'});await expect.poll(()=>effects).toBe(1);
});
it('recovers delegation after the Pi child mapping receipt is lost',async()=>{
  const f=await fixture();const root=await f.team.createTask(rootInput);const original=f.a.ctx.store.transact;let fail=true;
  f.a.ctx.store.transact=fn=>original(tx=>fn({...tx,put(kind,id,value){const row=value as {conversationId?:number;input?:{parentSessionId?:string}};if(fail&&kind==='runtime-session'&&row.conversationId&&row.input?.parentSessionId){fail=false;throw new Error('lost child mapping');}tx.put(kind,id,value);}}));
  await expect(f.team.delegate(assignment(root.id))).rejects.toThrow('lost child mapping');await f.reopen();const child=await f.team.delegate(assignment(root.id));
  await expect.poll(async()=>(await f.runtime.snapshot(child.executingSessionId)).messages.filter(m=>m.kind==='user').length).toBe(1);
  const db=new DatabaseSync(join(f.a.ctx.stateDir,'pi.sqlite'),{readOnly:true});try{expect(db.prepare('SELECT count(*) AS n FROM conversations').get()?.n).toBe(2);}finally{db.close();}
});
it('does not let a cancelled undelivered envelope prevent healthy sessions from reopening',async()=>{
  const f=await fixture();const root=await f.team.createTask(rootInput);const child=await f.team.delegate(assignment(root.id));
  const submit=f.runtime.submit;let fail=true;
  f.runtime.submit=async input=>{if(fail&&input.text.includes('Queued before cancellation')){fail=false;throw new Error('before delivery');}return submit(input);};
  await expect(f.team.message({id:'queued',fromSessionId:root.executingSessionId,toSessionId:child.executingSessionId,text:'Queued before cancellation'})).rejects.toThrow('before delivery');
  await f.runtime.cancel(root.executingSessionId);await f.reopen();
  expect(await f.a.ctx.store.list('team-outbox')).toHaveLength(0);
  const healthy=await f.runtime.createSession({requestId:'healthy',agentId:'agent-ada'});expect((await f.runtime.snapshot(healthy.id)).status).toBe('idle');
});
it('rejects an unknown delegate without leaving an unrecoverable assignment',async()=>{
  const f=await fixture();const root=await f.team.createTask(rootInput);
  await expect(f.team.delegate({...assignment(root.id),agentId:'missing-agent'})).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(await f.a.ctx.store.list('team-task')).toHaveLength(1);await f.reopen();
});
it('executes peer message, human question and final report tools through real CodeMode',async()=>{
  const f=await fixture();const root=await f.team.createTask(rootInput);const child=await f.team.delegate(assignment(root.id));
  await expect.poll(async()=>(await f.runtime.snapshot(child.executingSessionId)).status).toBe('completed');
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:`text(await tools.team_ask_user({question:"Release today?",recommendation:"Tomorrow",blockedTaskIds:[]}));text(await tools.team_message({toSessionId:"${root.executingSessionId}",text:"Peer evidence"}));text(await tools.team_report({state:"completed",outcome:{summary:"Checked",tests:["green"]}}));`}),{stopReason:'toolUse'}),...Array.from({length:10},()=>fauxAssistantMessage('Done'))]);
  await f.runtime.submit({sessionId:child.executingSessionId,requestId:'tools',text:'Use all team tools'});
  await expect.poll(async()=>(await f.team.getTask(child.id)).state).toBe('completed');
  expect((await f.a.ctx.store.list<{question:string}>('team-decision')).map(d=>d.question)).toEqual(['Release today?']);
  await expect.poll(async()=>JSON.stringify((await f.runtime.snapshot(root.executingSessionId)).messages)).toContain('Peer evidence');
  expect((await f.team.getTask(child.id)).outcome).toEqual({summary:'Checked',tests:['green']});
  await expect.poll(async()=>(await openVault(f.a.ctx).list()).filter(c=>c.metadata.type==='Lesson').length).toBe(1);
  const lesson=(await openVault(f.a.ctx).list()).find(c=>c.metadata.type==='Lesson')!;
  expect(lesson.body).toContain('No executed test receipts');expect(lesson.metadata.evidenceState).toBe('tentative');
  expect(await f.a.ctx.store.list('learning-completion')).toHaveLength(1);
});
it('captures completion independently after an actual shell receipt, retries failures, and keeps late provenance',async()=>{
 const f=await fixture([],true);const root=await f.team.createTask(rootInput);await expect.poll(async()=>(await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
 const vault=openVault(f.a.ctx);let failing=true;
 await vault.propose({id:'compatibility',path:'compatibility.md',expectedRevision:null,actor:'agent:ada',content:'---\n{"type":"Lesson","title":"Compatibility workaround","claims":["remedy"],"applicability":{"version":"2"}}\n---\nPin the dependency.\n'});const subject=await vault.read('compatibility.md');
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:`const loaded=JSON.parse(await tools.knowledge_load({path:"compatibility.md",revision:"${subject.revision}"}));const receipt=await tools.bash({command:"echo 3 compatibility checks passed"});text(await tools.knowledge_record_evidence({subjectId:loaded.path,subjectHash:loaded.subjectHash,claimIds:["remedy"],context:{version:"2"},kind:"reuse",receiptIds:[receipt.receiptId],rationale:"Adapted the dependency pin for version 2"}));text(await tools.team_report({state:"completed",outcome:{summary:"Compatibility checked",remedy:"Pinned dependency"}}));`}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
 // Inject publication failure below the worker, leaving Team.report and Pi real.
 const original=f.a.ctx.store.transact;f.a.ctx.store.transact=fn=>original(tx=>fn({...tx,insert(kind,id,value){if(failing&&kind==='learning-capture')throw new Error('capture unavailable');tx.insert(kind,id,value);}}));
 await f.runtime.submit({sessionId:root.executingSessionId,requestId:'check-and-report',text:'Check and report'});
 await expect.poll(async()=>(await f.team.getTask(root.id)).state,{timeout:2000}).toBe('completed');
 await expect.poll(async()=>(await f.a.ctx.store.list('learning-error')).length).toBe(1);
 expect((await f.team.getTask(root.id)).state).toBe('completed');expect(await f.a.ctx.store.list('learning-execution')).toEqual([expect.objectContaining({command:"echo 3 compatibility checks passed",exitCode:0,output:'3 compatibility checks passed\n'})]);
 expect(await f.a.ctx.store.list('learning-completion')).toEqual([expect.objectContaining({event:expect.objectContaining({testReceipts:[expect.any(String)]})})]);
 failing=false;await f.runtime.learning.drain();await f.runtime.learning.drain();
 expect((await vault.list()).filter(c=>c.metadata.type==='Lesson')).toHaveLength(2);expect(await f.a.ctx.store.list('learning-error')).toEqual([]);
 expect((await vault.list()).some(c=>c.metadata.type==='ExecutionReceipt'&&c.body.includes('3 compatibility checks passed'))).toBe(true);
 expect((await f.runtime.knowledge.search({query:'Compatibility workaround'})).items.find(c=>c.path===subject.path)?.evidenceState).toBe('validated');
 expect((await vault.list()).find(c=>c.metadata.type==='Evidence')?.body).toContain('Adapted the dependency pin for version 2');expect(await f.a.ctx.store.list('knowledge-load')).toEqual([expect.objectContaining({path:subject.path,revision:subject.revision})]);
 await f.reopen();await f.runtime.learning.drain();expect((await vault.list()).filter(c=>c.metadata.type==='Lesson')).toHaveLength(2);
 await vault.propose({id:'edit-remedy',path:subject.path,expectedRevision:subject.revision,actor:'human',content:{metadata:{},body:'Pin the replacement dependency.'}});const edited=await vault.read(subject.path);
 expect((await f.runtime.knowledge.search({query:'Compatibility workaround'})).items.find(c=>c.path===subject.path)?.evidenceState).toBe('tentative');
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:`const loaded=JSON.parse(await tools.knowledge_load({path:"compatibility.md",revision:"${edited.revision}"}));const receipt=await tools.bash({command:"echo replacement compatibility checks passed"});text(await tools.knowledge_record_evidence({subjectId:loaded.path,subjectHash:loaded.subjectHash,claimIds:["remedy"],context:{version:"2"},kind:"test",receiptIds:[receipt.receiptId]}));text(await tools.team_report({state:"completed",outcome:{summary:"Rechecked edited remedy"}}));`}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
 const second=await f.team.createTask({...rootInput,requestId:'recheck'});await expect.poll(async()=>(await f.team.getTask(second.id)).state).toBe('completed');
 expect((await f.runtime.knowledge.search({query:'Compatibility workaround'})).items.find(c=>c.path===subject.path)?.evidenceState).toBe('validated');
});
it('joins cancellation without holding the admission queue needed by an in-flight delegate tool',async()=>{
  const f=await fixture();const root=await f.team.createTask(rootInput);await expect.poll(async()=>(await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
  const create=f.runtime.createSession;let entered!:()=>void;const active=new Promise<void>(r=>entered=r);let release!:()=>void;const barrier=new Promise<void>(r=>release=r);let escape!:()=>void;
  const cleanupRace=new Promise<never>((_r,reject)=>{escape=()=>reject(new Error('release regression fixture'));});
  f.runtime.createSession=async input=>{if(input.parentSessionId){entered();await barrier;return Promise.race([create(input),cleanupRace]);}return create(input);};
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('team_delegate',{agentId:'helper:queued',objective:'Work',deliverable:'Result',contextPaths:[],dependsOn:[]}),{stopReason:'toolUse'})]);
  await f.runtime.submit({sessionId:root.executingSessionId,requestId:'race',text:'Delegate'});await active;
  const cancel=f.runtime.cancel(root.executingSessionId);await expect.poll(async()=>(await f.a.ctx.store.read<{cancelled?:boolean}>('runtime-session',root.executingSessionId))?.cancelled).toBe(true);release();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {await Promise.race([cancel,new Promise<never>((_r,reject)=>{timer=setTimeout(()=>reject(new Error('cancellation held the runtime admission queue')),750);})]);}
  finally {clearTimeout(timer);escape();await cancel;}
  expect((await f.a.ctx.store.list('runtime-session')).length).toBe(1);
  const tasks=await f.a.ctx.store.list<{id:string;parentTaskId?:string;state:string}>('team-task');const orphan=tasks.find(t=>t.parentTaskId===root.id)!;
  expect(orphan.state).toBe('cancelled');expect(await f.a.ctx.store.list('team-task-outbox')).toHaveLength(0);
  expect((await f.team.getTask(orphan.id)).state).toBe('cancelled');
});
it('cancels one Git writer while another can delegate independently',async()=>{
  const f=await fixture([],true);const first=await f.team.createTask(rootInput);
  const waiting=await f.team.createTask({...rootInput,requestId:'second-root'});expect((await f.team.getTask(waiting.id)).workspaceId).not.toBe(first.workspaceId);expect((await f.a.ctx.store.read<{state:string}>('workspace',first.workspaceId))?.state).toBe('active');
  await f.runtime.cancel(first.executingSessionId);
  const current=await f.team.getTask(waiting.id);expect(current.workspaceId).not.toBe('');expect(current.blockedReason).toBeUndefined();
  expect((await f.a.ctx.store.read<{state:string}>('workspace',current.workspaceId))?.state).toBe('active');
  const child=await f.team.delegate(assignment(waiting.id));expect(child.workspaceId).not.toBe(current.workspaceId);expect((await f.a.ctx.store.list<{state:string}>('workspace')).filter(w=>w.state==='active')).toHaveLength(2);
  expect(await f.a.ctx.store.list('team-task')).toHaveLength(3);
});
it('answers a cancelled requester decision for its still-live affected sibling',async()=>{
  const f=await fixture();const root=await f.team.createTask(rootInput);const requester=await f.team.delegate(assignment(root.id,'requester'));const affected=await f.team.delegate(assignment(root.id,'affected'));
  await f.team.ask({id:'sibling-question',taskId:requester.id,question:'Proceed?',recommendation:'Yes',blockedTaskIds:[affected.id]});
  await f.runtime.cancel(requester.executingSessionId);
  expect((await f.team.getTask(affected.id)).state).toBe('waiting_decision');
  await f.team.answer({id:'sibling-question',requestId:'answer-sibling',text:'Proceed with sibling work'});
  expect((await f.team.getTask(affected.id)).state).toBe('running');
  await expect.poll(async()=>JSON.stringify((await f.runtime.snapshot(affected.executingSessionId)).messages)).toContain('Proceed with sibling work');
  expect((await f.runtime.snapshot(requester.executingSessionId)).status).toBe('cancelled');
  await f.reopen();expect((await f.a.ctx.store.read<{state:string}>('team-decision','sibling-question'))?.state).toBe('answered');
});
it('releases a completed Git writer after proof while retaining its outcome and files',async()=>{
  const f=await fixture([],true);const root=await f.team.createTask(rootInput);
  await expect.poll(async()=>(await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
  const workspace=(await f.a.ctx.store.read<{path:string}>('workspace',root.workspaceId))!;await writeFile(join(workspace.path,'deliverable.txt'),'retained result');
  await f.team.report({taskId:root.id,requestId:'done',state:'completed',outcome:{summary:'Delivered'}});
  await expect(f.runtime.submit({sessionId:root.executingSessionId,requestId:'late',text:'More work'})).rejects.toMatchObject({code:'TASK_TERMINAL'});
  await expect.poll(async()=>(await f.a.ctx.store.read<{state:string}>('workspace',root.workspaceId))?.state).toBe('released');
  expect((await f.team.getTask(root.id)).outcome).toEqual({summary:'Delivered'});expect((await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');expect(await readFile(join(workspace.path,'deliverable.txt'),'utf8')).toBe('retained result');
  const next=await f.team.createTask({...rootInput,requestId:'next-root'});await expect.poll(async()=>(await f.runtime.snapshot(next.executingSessionId)).status).toBe('completed');
});
it('keeps a completed task workspace until active Pi work drains, including across reopen',async()=>{
  const f=await fixture([],true);let entered!:()=>void;const active=new Promise<void>(r=>entered=r);let first=true;
  f.faux.setResponses([async(_request,options)=>{if(first){first=false;entered();await new Promise<void>((_r,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('reopen')),{once:true}));}return fauxAssistantMessage('Final answer');}]);
  const root=await f.team.createTask(rootInput);await active;
  await f.team.report({taskId:root.id,requestId:'done',state:'completed',outcome:{summary:'Reported before model drained'}});
  expect((await f.a.ctx.store.read<{state:string}>('workspace',root.workspaceId))?.state).toBe('active');
  await f.reopen();await expect.poll(async()=>(await f.a.ctx.store.read<{state:string}>('workspace',root.workspaceId))?.state).toBe('released');
  expect((await f.team.getTask(root.id)).state).toBe('completed');expect((await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
});

it('retains a completed worktree until supervised process quiescence can be proven',async()=>{
  const f=await fixture([],true);const root=await f.team.createTask(rootInput);await expect.poll(async()=>(await f.runtime.snapshot(root.executingSessionId)).status).toBe('completed');
  const stop=f.supervisor.stopWorkspace.bind(f.supervisor);let attempts=0;f.supervisor.stopWorkspace=async()=>{attempts++;return {quiescent:false,reason:'incomplete process evidence'};};
  await f.team.report({taskId:root.id,requestId:'done',state:'completed',outcome:{summary:'Done'}});
  await expect.poll(()=>attempts).toBeGreaterThan(0);expect((await f.a.ctx.store.read<{state:string}>('workspace',root.workspaceId))?.state).toBe('active');
  const waiting=await f.team.createTask({...rootInput,requestId:'waiting-for-proof'});expect((await f.team.getTask(waiting.id)).workspaceId).not.toBe(root.workspaceId);expect((await f.a.ctx.store.read<{state:string}>('workspace',root.workspaceId))?.state).toBe('active');
  f.supervisor.stopWorkspace=stop;await expect.poll(async()=>(await f.runtime.snapshot(waiting.executingSessionId)).status).toBe('completed');
  expect((await f.team.getTask(root.id)).state).toBe('completed');
});
it('proves a stopped pending task without admitting its missing session after recovery',async()=>{
 const f=await fixture();const create=f.runtime.createSession;f.runtime.createSession=async()=>{throw new Error('crash before session');};
 await expect(f.team.createTask(rootInput)).rejects.toThrow('crash before session');f.runtime.createSession=create;
 const id=stableId(f.a.ctx.instanceId,'team-task',rootInput.requestId);
 expect(await f.team.stopTaskAndProve(id)).toEqual({quiescent:true});await f.team.recover();
 expect((await f.team.getTask(id)).state).toBe('cancelled');expect(await f.a.ctx.store.list('team-task-outbox')).toEqual([]);expect(await f.a.ctx.store.list('runtime-session')).toEqual([]);
});
