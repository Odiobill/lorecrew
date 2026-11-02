import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Models } from '@earendil-works/pi-ai/models';
import { gitFleet, realGit } from '../../helpers/git-fleet.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../../helpers/scripted-provider.js';
import { initFleet, openOwnership } from '../../../src/projects/ownership.js';
import { bindProject } from '../../../src/projects/bindings.js';
import { openVault } from '../../../src/vault/write.js';
import { openRuntime } from '../../../src/runtime/pi-host.js';
import { WorkspaceManager } from '../../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../../src/workspaces/processes.js';
import { openVaultSync } from '../../../src/sync/service.js';
import { subjectHash } from '../../../src/learning/hash.js';
import { vaultEvidence } from '../../../src/learning/evidence.js';
import { createApi } from '../../../src/api/app.js';
import { openBrowserSessions } from '../../../src/auth/sessions.js';
import { openTokens } from '../../../src/auth/tokens.js';
import type { TaskRecord } from '../../../src/team/types.js';
import type { SessionRecord, SubmissionRecord } from '../../../src/runtime/types.js';
import type { Concept } from '../../../src/vault/types.js';

// Expected patches exist only in the scripted-provider harness, never the B prompt.
const fixes = {
  a: "import { render } from './framework.mjs';\nexport const greeting = name => render({ template: 'Hello {name}', values: { name } });\n",
  b: "import { compile } from './engine.mjs';\nexport const receipt = customer => compile({ source: 'Thanks {{customer}}', bindings: { customer } });\n",
};
const prompts = {
  a: 'Repair the failing greeting project. Inspect its files, run node --test, consult related knowledge and skills, and report the actual remedy and test result with team_report.',
  b: 'Repair the failing mail receipt project. Inspect its files, run node --test, search related lessons and skills, load applicable exact revisions, adapt what applies, and record reuse evidence with the executed receipt before team_report. Do not edit tests or dependency files.',
};
async function waitFor<T>(read:()=>Promise<T|undefined>, timeoutMs:number):Promise<T> {
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){const value=await read();if(value!==undefined)return value;await delay(25);}
  throw new Error('Acceptance scenario timed out');
}
function scripted(side:'a'|'b') {
  const provider=scriptedProvider();
  const tool=(code:string)=>fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'});
  const search='text(await tools.skill_search({})); text(await tools.knowledge_search({query:"dependency API positional options"}));';
  const repair=`text(await tools.write({path:${JSON.stringify(side==='a'?'app.mjs':'mail.mjs')},content:${JSON.stringify(fixes[side])}}));`;
  const outcome={summary:'Dependency API positional options mismatch repaired',symptoms:'TypeError when using positional arguments',versions:{framework:'2'},remedy:'Inspect the installed dependency signature and replace positional arguments with a named options object. Adapt option names to the local API; run the project tests.'};
  provider.faux.setResponses(side==='a'?[
    tool(search+'text(await tools.read({path:"framework.mjs"})); text(await tools.bash({command:"node --test"}));'),
    tool(repair+'text(await tools.bash({command:"node --test"}));'),
    tool(`text(await tools.team_report({state:"completed",outcome:${JSON.stringify(outcome)}}));`),fauxAssistantMessage('Done'),
  ]:[
    tool(search+'text(await tools.read({path:"engine.mjs"})); text(await tools.bash({command:"node --test"}));'),
    tool('const page=JSON.parse(await tools.knowledge_search({query:"dependency API positional options"})); const hit=page.items.find(h=>h.path.startsWith("lessons/")); if(!hit)throw new Error("No transferred lesson"); text(await tools.knowledge_load({path:hit.path,revision:hit.revision}));'),
    tool(`const page=JSON.parse(await tools.knowledge_search({query:"dependency API positional options"})); const hit=page.items.find(h=>h.path.startsWith("lessons/")); const lesson=JSON.parse(await tools.knowledge_load({path:hit.path,revision:hit.revision})); ${repair} const run=await tools.bash({command:"node --test"}); text(run); text(await tools.knowledge_record_evidence({subjectId:lesson.path,subjectHash:lesson.subjectHash,claimIds:["reported-remedy"],context:{},kind:"reuse",receiptIds:[run.receiptId],rationale:"Adapted greeting options to the mail engine source and bindings API; actual mail tests executed."}));`),
    tool('text(await tools.team_report({state:"completed",outcome:{summary:"Mail receipt repaired and reuse tested"}}));'),fauxAssistantMessage('Done'),
  ]);
  return provider.models;
}
export interface AdmissionObservation {
  first:{taskId:string;sessionId:string}; replay:{taskId:string;sessionId:string};
  taskIds:string[]; sessionIds:string[];
  submissions:Array<{id:string;sessionId:string;requestId:string;piId:number|undefined}>;
  assignmentMessages:Array<{id:string;sessionId:string;taskId:string}>;
}
export function assertSingleAdmission(observation:AdmissionObservation){
  const {first,replay,taskIds,sessionIds,submissions,assignmentMessages}=observation;
  const sameIdentity=first.taskId===replay.taskId&&first.sessionId===replay.sessionId;
  const uniqueRecords=taskIds.length===1&&taskIds[0]===first.taskId&&sessionIds.length===1&&sessionIds[0]===first.sessionId;
  const dispatch=submissions[0];
  const singleDispatch=submissions.length===1&&dispatch?.sessionId===first.sessionId&&dispatch.requestId===`team:assignment:${first.taskId}`&&Number.isInteger(dispatch.piId);
  const message=assignmentMessages[0];
  const singleMessage=assignmentMessages.length===1&&message?.sessionId===first.sessionId&&message.taskId===first.taskId;
  if(!sameIdentity||!uniqueRecords||!singleDispatch||!singleMessage)throw new Error('Admission invariant: replay identity, root records, dispatch receipt and actual assignment message must describe one execution');
  return {duplicateAdmissions:0,admissionEvidence:observation};
}
export async function runLearningTransfer(options:{models?:Models;modelA?:string;modelB?:string;timeoutMs?:number;retain?:boolean;artifactDir?:string}={}) {
  const f=await gitFleet();const closes:Array<()=>Promise<void>>=[];
  const timeout=options.timeoutMs??20_000;
  try {
    await initFleet(f.a.ctx,f.a.git,f.remote);
    async function device(side:'a'|'b') {
      const d=f[side],ctx=d.ctx,vault=openVault(ctx),ownership=openOwnership(ctx,d.git,f.remote),workspaces=new WorkspaceManager(ctx);
      const projectId=`project-${side}`,projectPath=join(f.root,projectId);
      await mkdir(projectPath);await cp(resolve(`tests/fixtures/learning-transfer/${projectId}`),projectPath,{recursive:true});
      for(const args of [['init','--initial-branch=main'],['config','user.name','Acceptance'],['config','user.email','acceptance@example.test'],['add','.'],['commit','-m','broken local framework fixture']]){const r=await realGit(projectPath,args);if(r.exitCode)throw new Error(r.stderr);}
      await ownership.claim({id:projectId,repositoryKey:`fork:${projectId}`,title:projectId},`claim-${side}`);
      await bindProject(ctx,{projectId,path:projectPath});
      const model=(side==='a'?options.modelA:options.modelB)??'scripted/test-model';const slash=model.indexOf('/');
      await vault.propose({id:`agent-${side}`,path:`agents/${side}.md`,expectedRevision:null,actor:'human:owner',content:`---\n${JSON.stringify({type:'Agent',title:`Agent ${side}`,lorecrew:{id:`agent-${side}`,name:`Agent ${side}`,personality:'Precise',responsibilities:['Repair'],groups:[],model:{provider:model.slice(0,slash),modelId:model.slice(slash+1)}}})}\n---\nRepair only application code. Inspect local APIs, use knowledge and executed tests, and report evidence honestly.\n`});
      const runtime=await openRuntime({ctx,vault,ownership,workspaces,supervisor:new ProcessSupervisor(ctx),models:options.models??scripted(side)});closes.push(()=>runtime.close());
      const before=spawnSync(process.execPath,['--test'],{cwd:projectPath,encoding:'utf8'}).status===0?'pass':'fail';
      return {ctx,vault,ownership,workspaces,runtime,projectId,projectPath,before,git:d.git};
    }
    const a=await device('a');const b=await device('b');
    const taskA=await a.runtime.team.createTask({requestId:'task-a',projectId:a.projectId,leadAgentId:'agent-a',objective:prompts.a});
    await waitFor(async()=>{const task=await a.runtime.team.getTask(taskA.id);if(['failed','cancelled'].includes(task.state))throw new Error('Project A task failed');return task.state==='completed'?task:undefined;},timeout);
    await a.runtime.learning.drain();
    const lesson=await waitFor(async()=>(await a.vault.list()).find(c=>c.metadata.type==='Lesson'),timeout);
    const syncA=await openVaultSync({ctx:a.ctx,vault:a.vault,runtime:a.runtime,git:a.git,publicationMs:600_000,retryMs:600_000});closes.push(()=>syncA.close());
    await syncA.flush();
    const syncB=await openVaultSync({ctx:b.ctx,vault:b.vault,runtime:b.runtime,git:b.git,publicationMs:600_000,retryMs:600_000});closes.push(()=>syncB.close());
    await syncB.flush();
    const input={requestId:'task-b',projectId:b.projectId,leadAgentId:'agent-b',objective:prompts.b};
    const taskB=await b.runtime.team.createTask(input);const replayedB=await b.runtime.team.createTask(input);
    await waitFor(async()=>{const task=await b.runtime.team.getTask(taskB.id);if(['failed','cancelled'].includes(task.state))throw new Error('Project B task failed');return task.state==='completed'?task:undefined;},timeout);
    const workA=await a.ctx.store.read<{path:string}>('workspace',(await a.runtime.team.getTask(taskA.id)).workspaceId);
    const workB=await b.ctx.store.read<{path:string}>('workspace',(await b.runtime.team.getTask(taskB.id)).workspaceId);
    if(!workA||!workB)throw new Error('Missing actual task workspace');
    const projectATests=spawnSync(process.execPath,['--test'],{cwd:workA.path,encoding:'utf8'}).status===0?'pass':'fail';
    const projectBTests=spawnSync(process.execPath,['--test'],{cwd:workB.path,encoding:'utf8'}).status===0?'pass':'fail';
    // Verify fixture integrity independently of agent-reported test success.
    for(const [side,d,files] of [['a',a,['framework.mjs','app.test.mjs']],['b',b,['engine.mjs','mail.test.mjs']]] as const)for(const file of files)if(await readFile(join(side==='a'?workA.path:workB.path,file),'utf8')!==await readFile(resolve(`tests/fixtures/learning-transfer/project-${side}/${file}`),'utf8'))throw new Error('Agent changed acceptance oracle or dependency');
    const loads=await b.ctx.store.list<{sessionId:string;concept:Concept}>('knowledge-load');
    const reuse=vaultEvidence(await b.vault.list()).find(e=>e.record.kind==='reuse'&&e.record.subjectId===lesson.path)?.record;
    if(!reuse){if(options.artifactDir){await mkdir(options.artifactDir,{recursive:true});await writeFile(join(options.artifactDir,'learning-transfer-failure.json'),JSON.stringify({root:f.root,syncA:await syncA.status(),syncB:await syncB.status(),holdsA:await a.ctx.store.list('sync-publication-hold'),holdsB:await b.ctx.store.list('sync-publication-hold'),errors:await b.ctx.store.list('learning-error'),evidenceIntents:await b.ctx.store.list('learning-evidence-intent'),history:await b.runtime.history(taskB.executingSessionId)},null,2));}throw new Error('Missing executed reuse evidence');}
    const api=createApi({ctx:b.ctx,runtime:b.runtime,team:b.runtime.team,vault:b.vault,ownership:b.ownership,workspaces:b.workspaces,auth:openBrowserSessions(b.ctx),publicOrigin:'http://localhost'});
    const token=await openTokens(b.ctx).create('acceptance',['read','write']);
    const response=await api.request(`/api/v1/sessions/${taskA.executingSessionId}/cancel`,{method:'POST',headers:{Authorization:`Bearer ${token.token}`,'Content-Type':'application/json','Idempotency-Key':'remote-cancel'},body:'{}'});
    if(response.status!==404)throw new Error('Remote session mutation did not fail with NOT_FOUND');
    const remoteView=await (await api.request('/api/v1/remote/tasks',{headers:{Authorization:`Bearer ${token.token}`}})).json() as {items:Array<{sessionId:string}>};
    if(!remoteView.items.some(item=>item.sessionId===taskA.executingSessionId))throw new Error('Transferred task status is not visible');
    // Independent observations cover a second task/session ID as well as repeated
    // dispatch into the original session; counting only the first task ID cannot.
    const rootTasks=(await b.ctx.store.list<TaskRecord>('team-task')).filter(t=>t.projectId===b.projectId&&!t.parentTaskId);
    const rootSessions=(await b.ctx.store.list<SessionRecord>('runtime-session')).filter(r=>r.input.projectId===b.projectId&&!r.input.parentSessionId);
    const sessionIds=rootSessions.map(r=>r.session.id);
    const assignmentId=(text:string):string|undefined=>{try{const value=JSON.parse(text);return value.objective===input.objective&&typeof value.taskId==='string'?value.taskId:undefined;}catch{return;}};
    const submissions=(await b.ctx.store.list<SubmissionRecord>('runtime-submission')).filter(r=>sessionIds.includes(r.sessionId)&&assignmentId(r.text)!==undefined).map(({id,sessionId,requestId,piId})=>({id,sessionId,requestId,piId}));
    const assignmentMessages:AdmissionObservation['assignmentMessages']=[];
    for(const sessionId of sessionIds)for(const entry of await b.runtime.history(sessionId))if(entry.kind==='user'){
      const content=(entry.data as {content?:Array<{type:string;text?:string}>}).content;
      const text=content?.filter(part=>part.type==='text').map(part=>part.text??'').join('')??'';
      const taskId=assignmentId(text);if(taskId!==undefined)assignmentMessages.push({id:entry.id,sessionId,taskId});
    }
    const admission=assertSingleAdmission({first:{taskId:taskB.id,sessionId:taskB.executingSessionId},replay:{taskId:replayedB.id,sessionId:replayedB.executingSessionId},taskIds:rootTasks.map(t=>t.id),sessionIds,submissions,assignmentMessages});
    const report={projectABefore:a.before,projectBBefore:b.before,projectATests,projectBTests,lessonRevision:lesson.revision,lessonSubjectHash:subjectHash(lesson),projectBLoadedLessons:loads.filter(l=>l.sessionId===taskB.executingSessionId).map(l=>l.concept.revision),reuseEvidence:reuse,...admission,remoteMutationAvailable:response.status<400,projectBPrompt:prompts.b,root:f.root,models:{a:(await a.runtime.snapshot(taskA.executingSessionId)).session.model,b:(await b.runtime.snapshot(taskB.executingSessionId)).session.model},rssBytes:process.memoryUsage().rss};
    if(options.artifactDir){await mkdir(options.artifactDir,{recursive:true});await writeFile(join(options.artifactDir,'learning-transfer.json'),JSON.stringify(report,null,2));}
    return report;
  }finally{for(const close of closes.reverse())await close();if(!options.retain)await f.cleanup();else{await f.a.ctx.close();await f.b.ctx.close();}}
}
