import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, chmod, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [packageDir,root,scenario='tools',layout='src']=process.argv.slice(2);
const load=path=>import(pathToFileURL(join(packageDir,layout,path+(layout==='src'?'.ts':'.js'))).href);
const pi=async path=>layout==='src'?import(pathToFileURL(join(packageDir,'node_modules/@earendil-works/pi-ai/dist',path+'.js')).href):(await import('../../scripts/platform-smoke.mjs')).loadInstalledModule(packageDir,'@earendil-works/pi-ai/'+path);
const {createModels}=await pi('models');
const {fauxProvider,fauxAssistantMessage,fauxToolCall}=await pi('providers/faux');
const {openInstance}=await load('instance/open');const {openRuntime}=await load('runtime/pi-host');const {openVault}=await load('vault/write');const {openConfiguredOwnership}=await load('projects/configured-ownership');const {ensureLocalAuthority}=await load('projects/authority-domain');const {readVaultIdentity}=await load('repositories/identity');const {runCli}=await load('cli');const {GitClient}=await load('git/client');const {WorkspaceManager}=await load('workspaces/manager');const {ProcessSupervisor}=await load('workspaces/processes');
await runCli(['init','--state-dir',join(root,'state'),'--vault',join(root,'vault')]);await mkdir(join(root,'vault','agents'),{recursive:true});await mkdir(process.env.HOME,{recursive:true});
const agentPath=join(root,'vault','agents','piren.md');const definition=name=>`---\ntype: Agent\ntitle: ${name}\nlorecrew:\n  id: piren\n  name: ${name}\n  personality: Thoughtful and direct\n  responsibilities: [Personal assistance, Implementation]\n  groups: []\n  model: {provider: scripted, modelId: test-model}\n---\n`;
await writeFile(agentPath,definition('Piren'));
const ctx=await openInstance({stateDir:join(root,'state'),vaultDir:join(root,'vault')});
const faux=fauxProvider({provider:'scripted',models:[{id:'test-model'}],tokensPerSecond:Infinity});const models=createModels();models.setProvider(faux.provider);
async function run(){
const supervisor=new ProcessSupervisor(ctx);const options={ctx,vault:openVault(ctx),ownership:openConfiguredOwnership(ctx,new GitClient()),workspaces:new WorkspaceManager(ctx),supervisor,models};let runtime;
if(scenario==='legacy'){await ctx.store.transact(tx=>tx.put('runtime-session','obsolete',{input:{mode:'read'}}));await assert.rejects(openRuntime(options),{code:'PREVIEW_STATE_INCOMPATIBLE'});assert.equal(faux.state.callCount,0);assert.equal((await ctx.store.list('host-process')).length,0);assert.equal((await ctx.store.read('runtime-session','obsolete')).input.mode,'read');await assert.rejects(readFile(join(ctx.stateDir,'pi.sqlite')),{code:'ENOENT'});await ctx.close();console.log(JSON.stringify({ok:true,proof:scenario}));return;}
runtime=await openRuntime(options);
async function finish(id){for(let i=0;i<500;i++){const snapshot=await runtime.snapshot(id);if(['completed','failed','blocked'].includes(snapshot.status))return snapshot;await new Promise(r=>setTimeout(r,10));}throw new Error('No terminal response');}
try{
 const session=await runtime.createSession({requestId:'ordinary',agentId:'piren'});
 const record=await ctx.store.read('runtime-session',session.id);assert.equal(record.cwd,process.env.HOME);assert.ok(record.executionContextId);
 if(scenario==='tools'){
  let input;
  const code=`text(await tools.write({path:'relative.txt',content:'before'}));text(await tools.edit({path:'relative.txt',oldText:'before',newText:'after'}));text(await tools.read({path:'relative.txt'}));text(await tools.write({path:${JSON.stringify(join(root,'absolute.txt'))},content:'outside'}));text(await tools.bash({command:'pwd; cat relative.txt'}));text(await tools.memory_remember({scope:'global',text:'A retained fixture memory',sourcePaths:[]}));`;
  faux.setResponses([context=>{input=JSON.stringify(context.messages);return fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'});},fauxAssistantMessage('Done')]);
  await runtime.submit({sessionId:session.id,requestId:'tools',text:'Use the fixture tools'});const snapshot=await finish(session.id);
  assert.equal(await readFile(join(process.env.HOME,'relative.txt'),'utf8'),'after',JSON.stringify(snapshot));assert.equal(await readFile(join(root,'absolute.txt'),'utf8'),'outside');
  assert.match(input,/Piren/);assert.match(input,/Personal assistance/);assert.ok(input.includes(process.env.HOME));assert.match(input,/no (project|team assignment)/i);
  const processes=await ctx.store.list('host-process');assert.equal(processes.length,1);assert.equal(processes[0].sessionId,session.id);assert.equal(processes[0].contextId,record.executionContextId);assert.ok((await ctx.store.list('learning-execution')).length>0);assert.ok((await options.vault.list()).some(c=>c.body.includes('A retained fixture memory')));
  for(const kind of ['assignment-grants','workload-grants','workspace-write-lock'])assert.deepEqual(await ctx.store.list(kind),[]);
  const original=record.cwd;await runtime.close();const other=join(root,'other-home');await mkdir(other);process.env.HOME=other;runtime=await openRuntime(options);assert.equal((await ctx.store.read('runtime-session',session.id)).cwd,original);
  await writeFile(agentPath,definition('Revised Piren'));assert.equal((await ctx.store.read('runtime-session',session.id)).agent.name,'Piren');await runtime.reloadAgent({sessionId:session.id,expectedRevision:record.session.agentRevision,requestId:'reload'});
  let greeting;faux.setResponses([context=>{greeting=JSON.stringify(context.messages);return fauxAssistantMessage('Hello');}]);await runtime.submit({sessionId:session.id,requestId:'greeting',text:'Hello'});await finish(session.id);assert.match(greeting,/Revised Piren/);assert.equal((await ctx.store.list('host-process')).length,1);
 }else if(scenario==='cancel'){
  const second=await runtime.createSession({requestId:'other',agentId:'piren'});
  faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:`text(await tools.bash({command:'printf first > first-started; sleep 300'}));`}),{stopReason:'toolUse'}),fauxAssistantMessage(fauxToolCall('codemode',{code:`text(await tools.bash({command:'printf second > second-started; sleep 300'}));`}),{stopReason:'toolUse'})]);
  await runtime.submit({sessionId:session.id,requestId:'first',text:'First controlled command'});
  async function started(name){for(let n=0;n<1000;n++){try{await readFile(join(process.env.HOME,name));return;}catch{}await new Promise(r=>setTimeout(r,10));}throw Error('Command did not start '+name);}
  await started('first-started');await runtime.submit({sessionId:second.id,requestId:'second',text:'Second controlled command'});await started('second-started');
  await runtime.cancel(session.id);const records=await ctx.store.list('host-process');const first=records.find(p=>p.sessionId===session.id),other=records.find(p=>p.sessionId===second.id);assert.equal(first.state,'stopped');assert.equal(other.state,'running');assert.notEqual(first.contextId,other.contextId);assert.equal((await ctx.store.read('execution-context',first.contextId)).state,'stopped');
  await runtime.cancel(second.id);assert.ok((await ctx.store.list('host-process')).every(p=>p.settled||p.state==='stopped'));
 }else if(scenario==='project'){
  const {bindProject}=await load('projects/bindings');const git=new GitClient(),remote=join(root,'remote.git'),project=join(root,'project');await mkdir(project);await writeFile(join(project,'README.md'),'# Code\n');const seeded=new GitClient();for(const args of [['init','--template=','--initial-branch=main'],['add','README.md'],['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','base']])assert.equal((await seeded.run(project,args)).exitCode,0);
  await ensureLocalAuthority(ctx,await readVaultIdentity(ctx.vaultDir),'full-host-project');await options.ownership.claim({id:'plain',repositoryKey:'fork:installed-plain',title:'Plain'},'claim');await bindProject(ctx,{projectId:'plain',path:project});
  const shell=role=>`mkdir active || exit 91; sleep .02; printf '${role}\\n' >> order; rmdir active`;
  faux.setResponses(Array.from({length:20},()=>async context=>{const instructions=JSON.stringify(context.messages[0]);const taskId=instructions.match(/Team assignment: ([a-f0-9]+)/)?.[1],assigned=await ctx.store.read('team-task',taskId),sessionRecord=await ctx.store.read('runtime-session',assigned.executingSessionId);assert.ok(sessionRecord.cwd!==project);assert.ok(instructions.includes('Recorded working directory: '+sessionRecord.cwd),'Admitted isolated cwd must reach the actual model');assert.ok(instructions.includes('Configured name: Piren'));if(context.messages.some(m=>m.role==='toolResult')){const current=await ctx.store.read('team-task',taskId);if(current.objective==='root'&&current.state!=='completed'){for(let n=0;n<1000;n++){const tasks=await ctx.store.list('team-task');if(tasks.filter(t=>t.parentTaskId===current.id).every(t=>['completed','failed','cancelled'].includes(t.state)))break;await new Promise(r=>setTimeout(r,10));}return fauxAssistantMessage(fauxToolCall('codemode',{code:`text(await tools.team_report({state:'completed',outcome:{summary:'done'}}));`}),{stopReason:'toolUse'});}return fauxAssistantMessage('Finished');}const id=instructions.match(/Team assignment: ([a-f0-9]+)/)?.[1],task=await ctx.store.read('team-task',id);assert.ok(task,'Actual assignment required');const report=task.objective==='root'?'':`text(await tools.team_report({state:'completed',outcome:{summary:'done'}}));`;
   const code=task.objective==='root'?`text(await tools.bash({command:${JSON.stringify(shell('parent-before'))}}));text(await tools.team_delegate({agentId:'piren',objective:'child',deliverable:'edit',contextPaths:[],dependsOn:[]}));text(await tools.bash({command:${JSON.stringify(shell('parent-after'))}}));${report}`:`text(await tools.write({path:'child.txt',content:'child'}));text(await tools.bash({command:${JSON.stringify(shell('child'))}}));${report}`;
   return fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'});
  }));
  const task=await runtime.team.createTask({requestId:'root-task',projectId:'plain',leadAgentId:'piren',objective:'root'});for(let n=0;n<1500;n++){if((await runtime.team.getTask(task.id)).state==='completed')break;await new Promise(r=>setTimeout(r,10));}assert.equal((await runtime.team.getTask(task.id)).state,'completed',JSON.stringify(await runtime.snapshot(task.executingSessionId)));const tasks=await ctx.store.list('team-task');const rootRecord=await ctx.store.read('runtime-session',task.executingSessionId),childTask=tasks.find(t=>t.parentTaskId===task.id),childRecord=await ctx.store.read('runtime-session',childTask.executingSessionId);assert.notEqual(rootRecord.cwd,childRecord.cwd);assert.equal(await readFile(join(rootRecord.cwd,'order'),'utf8'),'parent-before\nparent-after\n');assert.equal(await readFile(join(childRecord.cwd,'order'),'utf8'),'child\n');assert.equal(await readFile(join(childRecord.cwd,'child.txt'),'utf8'),'child');assert.equal((await ctx.store.list('host-process')).length,3);for(const kind of ['plain-handoff','plain-boundary','plain-execution-slot','workspace-write-lock'])assert.deepEqual(await ctx.store.list(kind),[]);
 }else if(scenario==='missing'){
  await runtime.close();await rename(record.cwd,record.cwd+'-missing');runtime=await openRuntime(options);const snapshot=await runtime.snapshot(session.id);assert.equal(snapshot.blockedReason,'execution_cwd_unavailable');assert.equal((await ctx.store.read('runtime-session',session.id)).cwd,record.cwd);assert.equal(faux.state.callCount,0);
 }else if(scenario==='permissions'){
  assert.notEqual(process.getuid?.(),0,'OS-denial fixture must be nonroot');const denied=join(root,'denied');await mkdir(denied);await chmod(denied,0);
  faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:`text(await tools.write({path:${JSON.stringify(join(denied,'file'))},content:'denied'}));`}),{stopReason:'toolUse'}),fauxAssistantMessage('Permission denied')]);await runtime.submit({sessionId:session.id,requestId:'denied',text:'Try the controlled denied path'});const snapshot=await finish(session.id);assert.match(JSON.stringify(snapshot),/EACCES|permission denied/i);await chmod(denied,0o700);
 }
 console.log(JSON.stringify({ok:true,proof:scenario,scenario,sessionId:session.id,commands:(await ctx.store.list('host-process')).length}));
}finally{await runtime.close();await ctx.close();}

}
await run();
