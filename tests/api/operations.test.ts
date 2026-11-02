import {gitVaultFixture} from '../helpers/git-vault.js';
import {ensureLocalAuthority} from '../../src/projects/authority-domain.js';
import {gitProject} from '../helpers/git-project.js';
import { afterEach, expect, it } from 'vitest';
import { cp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openVault } from '../../src/vault/write.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { scriptedProvider, fauxAssistantMessage } from '../helpers/scripted-provider.js';
import { openVaultSync } from '../../src/sync/service.js';
import { closeApi, createApi } from '../../src/api/app.js';
import { openBrowserSessions } from '../../src/auth/sessions.js';
import { subjectHash } from '../../src/learning/hash.js';
import { openWorkloadOwnership } from '../../src/projects/workload-grants.js';
import { Value } from 'typebox/value';
import { SessionSnapshotSchema } from '../../src/api/schemas.js';
import { publicSnapshot } from '../../src/api/routes.js';
import { scriptedLoginProviders } from '../helpers/provider-login.js';
import { openCredentialFile } from '../../src/runtime/provider-credentials.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const origin='http://localhost';
const doc=(metadata:object,body:string)=>`---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
async function fixture(resume=false,syncRemote:false|'origin'=false,empty=false){
 const native=await gitVaultFixture();await ensureLocalAuthority(native.ctx,native.identity,'operations-fixture');const remote=(await native.ctx.store.read<{remote:string}>('fleet','assignments'))!.remote;await native.git.run(native.ctx.vaultDir,['remote','add','origin',remote]);const f={a:{ctx:native.ctx,git:native.git},remote,cleanup:()=>native.close()};cleanup.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,'origin');
 if(!empty){await cp('tests/fixtures/vault/agents',join(f.a.ctx.vaultDir,'agents'),{recursive:true});
 await cp('tests/fixtures/vault/groups',join(f.a.ctx.vaultDir,'groups'),{recursive:true});
 for(const name of ['ada','lin']){const agentPath=join(f.a.ctx.vaultDir,'agents/'+name+'.md');await writeFile(agentPath,(await readFile(agentPath,'utf8')).replaceAll('local-openai','scripted').replaceAll('coding-model','test-model').replaceAll('local-anthropic','scripted').replaceAll('review-model','test-model'));}}
 const ctx=f.a.ctx,vault=openVault(ctx),ownership=openOwnership(ctx,f.a.git,'origin'),workspaces=new WorkspaceManager(ctx);
 const provider=scriptedProvider();const providerOptions={credentials:openCredentialFile(join(f.a.ctx.stateDir,'test-auth.json')),factories:scriptedLoginProviders};const runtimeOptions={ctx,vault,ownership,workspaces,supervisor:new ProcessSupervisor(ctx),models:provider.models,providerOptions,resume};let runtime=await openRuntime(runtimeOptions);cleanup.push(()=>runtime.close());
 const sync=await openVaultSync({ctx,vault,runtime,git:f.a.git,remote:syncRemote,publicationMs:600000,retryMs:600000});cleanup.push(()=>sync.close());
 const auth=openBrowserSessions(ctx),secret=await auth.issueBootstrap();const app=createApi({sync,ctx,vault,runtime,team:runtime.team,ownership,workspaces,auth,providerOptions,publicOrigin:origin});cleanup.push(async()=>closeApi(app));
 const login=await app.request('/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({secret})});
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;const csrf=(await login.json() as {csrfToken:string;id:string});
 const headers={cookie,origin,'x-csrf-token':csrf.csrfToken,'content-type':'application/json'};
 const get=(path:string)=>app.request('/api/v1'+path,{headers:{cookie}});
 const post=(path:string,body:unknown,key:string)=>app.request('/api/v1'+path,{method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});
 const put=(path:string,body:unknown,key:string)=>app.request('/api/v1'+path,{method:'PUT',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)}); return {ctx,vault,sync,remote:f.remote,get runtime(){return runtime;},provider,app,get,post,put,headers,cookie,csrf,git:f.a.git,async reopen(){await runtime.close();runtime=await openRuntime(runtimeOptions);}};
}

it('edits portable definitions with revision checks, pins sessions until explicit reload, and rejects stale edits',async()=>{
 const f=await fixture(); const agent=(await (await f.get('/agents')).json() as any[])[0];
 const session=await f.runtime.createSession({requestId:'before',agentId:'agent-ada'});
 const input={...agent,name:'Ada updated',personality:'New deliberate instructions',expectedRevision:agent.revision};delete input.revision;
 expect((await f.put('/agents/agent-ada',input,'edit')).status).toBe(200);
 expect((await f.runtime.snapshot(session.id)).session.agentRevision).toBe(agent.revision);
 expect((await f.put('/agents/agent-ada',input,'edit')).status).toBe(200);
 expect((await f.put('/agents/agent-ada',input,'stale')).status).toBe(409);
 expect((await f.post('/sessions/'+session.id+'/reload',{expectedRevision:agent.revision},'reload')).status).toBe(200);
 expect((await f.runtime.snapshot(session.id)).session.agentRevision).not.toBe(agent.revision);
 const group=(await (await f.get('/groups')).json() as any[])[0];
 expect((await f.put('/groups/'+group.id,{id:group.id,name:'Platform',description:'Shared engineering',expectedRevision:group.revision},'group')).status).toBe(200);
 expect((await f.vault.read('agents/ada.md')).metadata.custom).toEqual({retain:true});
});
it('persists only credential references and rejects key values and unknown models',async()=>{
 const f=await fixture();process.env.LORECREW_TEST_PROVIDER_SECRET='secret-value-must-not-leak';
 try {
 const provider=await (await f.get('/providers/openai')).json() as any;
 expect((await f.put('/providers/openai',{credentialEnv:'LORECREW_TEST_PROVIDER_SECRET',expectedRevision:provider.revision},'provider')).status).toBe(200);
 expect(await (await f.get('/providers/openai')).text()).not.toContain('secret-value-must-not-leak');
 expect(await readFile(join(f.ctx.stateDir,'providers.json'),'utf8')).not.toContain('secret-value-must-not-leak');
 expect((await f.put('/providers/openai',{apiKey:'secret-value-must-not-leak'},'secret')).status).toBe(400);
 }finally{delete process.env.LORECREW_TEST_PROVIDER_SECRET;}
 const a=(await (await f.get('/agents')).json() as any[])[0];delete a.revision;
 expect((await f.put('/agents/'+a.id,{...a,model:{provider:'missing',modelId:'missing'},expectedRevision:'stale'},'badmodel')).status).toBe(422);
});
it('shows imported reported running state without reachability or remote commands and lists public contracts',async()=>{
 const f=await fixture();await f.vault.propose({id:'remote',path:'status/offline/task.md',expectedRevision:null,actor:'test',content:doc({type:'TaskStatus',lorecrew:{originId:'offline-device',taskId:'remote-task',sessionId:'remote-session',sequence:7,reportedAt:'2026-10-20T10:00:00Z',state:'running',summary:'Old report'}},'Device is now off')});
 const r=await f.get('/remote/tasks');expect(r.status).toBe(200);const data=await r.json() as any;expect(data.items[0]).toMatchObject({originId:'offline-device',state:'running',sequence:7});expect(JSON.stringify(data)).not.toMatch(/reachable|online/);
 expect((await f.post('/remote/tasks/remote-task/cancel',{},'forbidden')).status).toBe(404);
 const api=await (await f.get('/openapi.json')).json() as any;
 for(const path of ['/agents/{id}','/groups/{id}','/projects/{id}/binding','/providers/{id}','/learning/assignment','/schedules','/schedules/{id}','/sync','/sync/pause','/sync/resume','/sync/run','/remote/tasks','/history','/recovery/{id}/restore','/projects/claim','/projects/{id}/handoff'])expect(api.paths['/api/v1'+path]).toBeTruthy();
});
it('creates schedules with explicit policies, rejects stale updates and remote ownership mutations',async()=>{
 const f=await fixture();const body={id:'daily',agentId:'agent-ada',cron:'0 9 * * *',timeZone:'Europe/Rome',instructions:'Review notes',enabled:true};
 const created=await f.post('/schedules',body,'schedule');expect(created.status).toBe(200);const first=await created.json() as any;
 expect(first).toMatchObject({overlap:'skip',missed:'coalesce',ownerId:f.ctx.instanceId});
 expect((await f.post('/schedules',body,'schedule')).status).toBe(200);
 expect((await f.put('/schedules/daily',{...body,expectedRevision:'stale'},'stale-schedule')).status).toBe(409);
 expect((await f.post('/schedules/daily/disable',{expectedRevision:first.revision},'disable')).status).toBe(200);
 const remote={...first,id:'remote',ownerId:'other'};await f.vault.propose({id:'remote-schedule',path:'schedules/remote.md',expectedRevision:null,actor:'test',content:doc({type:'Schedule',schedule:remote},'Remote')});
 expect((await f.put('/schedules/remote',{...body,id:'remote',expectedRevision:remote.revision},'remote-edit')).status).toBe(409);
 expect((await f.post('/schedules/remote/disable',{expectedRevision:remote.revision},'remote-disable')).status).toBe(409);
});
it('reassigns the curator on this owner after quiescence and preserves old session identity',async()=>{
 const f=await fixture();const first=await f.put('/learning/assignment',{agentId:'agent-ada',expectedRevision:null},'assign');expect(first.status).toBe(200);
 const assigned=await first.json() as any;
 const old=await f.runtime.createSession({requestId:'old-curator',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});
 const changed=await f.put('/learning/assignment',{agentId:'agent-lin',expectedRevision:assigned.revision},'reassign');expect(changed.status).toBe(200);
 expect((await changed.json() as any).assignment).toMatchObject({agentId:'agent-lin',generation:1,ownerId:f.ctx.instanceId});
 expect((await f.runtime.snapshot(old.id)).session.agentId).toBe('agent-ada');expect((await f.runtime.snapshot(old.id)).status).toBe('cancelled');
 const fresh=await f.runtime.createSession({requestId:'new-curator',agentId:'agent-lin',background:true,workload:{workloadId:'curator',generation:1}});expect(fresh.agentId).toBe('agent-lin');
});
it('binds a local project optimistically and restores observed revisions without overriding later edits',async()=>{
 const f=await fixture();expect((await f.put('/projects/demo/binding',{path:await gitProject(join(f.ctx.stateDir,'..','code')),expectedRevision:null},'bind')).status).toBe(200);
 expect((await f.put('/projects/demo/binding',{path:await gitProject(join(f.ctx.stateDir,'..','code')),expectedRevision:null},'stale-bind')).status).toBe(409);
 await f.vault.propose({id:'note',path:'notes/test.md',expectedRevision:null,actor:'test',content:doc({type:'Note'},'Current')});
 const {observeRevision,liveBytes,contentHash}=await import('../../src/sync/recovery.js');const current=await liveBytes(f.ctx,'notes/test.md');const backup=await observeRevision(f.ctx,'notes/test.md',doc({type:'Note'},'Earlier'),contentHash(current));
 expect((await f.post('/recovery/'+backup.id+'/restore',{},'restore')).status).toBe(200);
 expect((await f.vault.read('notes/test.md')).body).toContain('Earlier');
 expect((await f.post('/recovery/'+backup.id+'/restore',{},'restore')).status).toBe(200);
 expect((await f.get('/history')).status).toBe(200);
});
it('replays binding, schedule disable and restore after a lost API receipt',async()=>{
 const f=await fixture();const bind={path:await gitProject(join(f.ctx.stateDir,'..','code')),expectedRevision:null};expect((await f.put('/projects/replay/binding',bind,'lost-binding')).status).toBe(200);
 const forget=async()=>{const receipts=await f.ctx.store.list<any>('api-request');await f.ctx.store.transact(tx=>{for(const r of receipts)tx.put('api-request',r.requestId.slice(5),{fingerprint:r.fingerprint,requestId:r.requestId});});};
 await forget();expect((await f.put('/projects/replay/binding',bind,'lost-binding')).status).toBe(200);
 const s=await (await f.post('/schedules',{id:'replay',agentId:'agent-ada',cron:'0 9 * * *',timeZone:'UTC',instructions:'Review',enabled:true},'lost-schedule')).json() as any;
 expect((await f.post('/schedules/replay/disable',{expectedRevision:s.revision},'lost-disable')).status).toBe(200);await forget();expect((await f.post('/schedules/replay/disable',{expectedRevision:s.revision},'lost-disable')).status).toBe(200);
 const {observeRevision,liveBytes,contentHash}=await import('../../src/sync/recovery.js');await f.vault.propose({id:'restore-note',path:'notes/replay.md',expectedRevision:null,actor:'test',content:doc({type:'Note'},'Current')});const backup=await observeRevision(f.ctx,'notes/replay.md',doc({type:'Note'},'Older'),contentHash(await liveBytes(f.ctx,'notes/replay.md')));
 expect((await f.post('/recovery/'+backup.id+'/restore',{},'lost-restore')).status).toBe(200);await forget();expect((await f.post('/recovery/'+backup.id+'/restore',{},'lost-restore')).status).toBe(200);
});
it('reassignment rejects a reused intent identity with different selection and resumes an interrupted same-owner change',async()=>{
 const f=await fixture();const o=openWorkloadOwnership(f.ctx,f.git,'origin');const grant=await o.claim('curator','interrupted');await f.runtime.curator.assign({agentId:'agent-ada',ownerId:f.ctx.instanceId,generation:1});
 const previous={agentId:'agent-ada',ownerId:f.ctx.instanceId,generation:1};const {stableId}=await import('../../src/runtime/admission.js');const expectedRevision=stableId(JSON.stringify(previous));
 const local=await f.ctx.store.read('workload-grants','curator');await f.ctx.store.transact(tx=>tx.put('curator-reassignment','pending',{requestId:'interrupted',agentId:'agent-lin',expectedRevision,previous,grant:local}));
 await expect(f.runtime.createSession({requestId:'during-change',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}})).rejects.toMatchObject({code:'ADMISSION_CLOSED'});
 await expect(f.runtime.curator.reassign({agentId:'agent-ada',expectedRevision,requestId:'interrupted',claim:()=>Promise.resolve(grant)})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
 await f.runtime.curator.reassign({agentId:'agent-lin',expectedRevision,requestId:'interrupted',claim:()=>Promise.resolve(grant)});expect(await f.ctx.store.read('learning-assignment','curator')).toMatchObject({agentId:'agent-lin',generation:1});await o.assertOwner('curator',1);
});
it('refuses a concurrent ownership handoff when resuming curator reassignment',async()=>{
 const f=await fixture();const o=openWorkloadOwnership(f.ctx,f.git,'origin');const grant=await o.claim('curator','handoff');const previous={agentId:'agent-ada',ownerId:f.ctx.instanceId,generation:1};await f.runtime.curator.assign(previous);const local=await f.ctx.store.read('workload-grants','curator');const {stableId}=await import('../../src/runtime/admission.js');const expectedRevision=stableId(JSON.stringify(previous));
 await f.ctx.store.transact(tx=>{tx.put('curator-reassignment','pending',{requestId:'race',agentId:'agent-lin',expectedRevision,previous,grant:local});tx.put('workload-admission','curator',{generation:1,closed:true});});
 await expect(f.runtime.curator.reassign({agentId:'agent-lin',expectedRevision,requestId:'race',claim:()=>Promise.resolve(grant)})).rejects.toMatchObject({code:'ADMISSION_CLOSED'});expect(await f.ctx.store.read('learning-assignment','curator')).toEqual(previous);expect(await f.ctx.store.read('curator-reassignment','pending')).toBeTruthy();
});
it('records an idle reload in Pi instructions, refuses a busy reload, and recovers a pending reload before dispatch',async()=>{
 const f=await fixture(true);const session=await f.runtime.createSession({requestId:'reload-boundary',agentId:'agent-ada'});const agent=(await (await f.get('/agents')).json() as any[])[0];const {revision,...fields}=agent;
 expect((await f.put('/agents/agent-ada',{...fields,personality:'Explicit newly configured instruction',expectedRevision:revision},'configure-reload')).status).toBe(200);
 let release!:()=>void;const waiting=new Promise<void>(resolve=>release=resolve);const prompts:string[]=[];
 f.provider.faux.setResponses([async context=>{prompts.push(JSON.stringify(context));await waiting;return fauxAssistantMessage('First settled');},context=>{prompts.push(JSON.stringify(context));return fauxAssistantMessage('After reload');}]);
 await f.runtime.submit({sessionId:session.id,requestId:'before-reload',text:'First'});await expect.poll(()=>prompts.length).toBe(1);
 expect((await f.post('/sessions/'+session.id+'/reload',{expectedRevision:revision},'busy-reload')).status).toBe(409);
 release();await expect.poll(async()=>(await f.runtime.snapshot(session.id)).status).toBe('completed');
 expect((await f.post('/sessions/'+session.id+'/reload',{expectedRevision:revision},'idle-reload')).status).toBe(200);
 await f.runtime.submit({sessionId:session.id,requestId:'after-reload',text:'Second'});await expect.poll(()=>prompts.length).toBe(2);expect(prompts[1]).toContain('Explicit newly configured instruction');expect(prompts[0]).not.toContain('Explicit newly configured instruction');
 await expect.poll(async()=>(await f.runtime.snapshot(session.id)).status).toBe('completed');
 const record=await f.ctx.store.read<any>('runtime-session',session.id);const next={...record.agent,revision:'recovery-revision',personality:'Recovered idle reload'};
 await f.ctx.store.transact(tx=>tx.put('runtime-reload','recovery-reload',{id:'recovery-reload',sessionId:session.id,expectedRevision:record.agent.revision,agent:next,state:'pending'}));await f.reopen();expect((await f.runtime.snapshot(session.id)).session.agentRevision).toBe('recovery-revision');expect(await f.ctx.store.read('runtime-reload','recovery-reload')).toMatchObject({state:'completed'});
});
it('settles old curator jobs, preserves their pins and admits fresh work with a new agent in the same generation',async()=>{
 const f=await fixture();const first=await (await f.put('/learning/assignment',{agentId:'agent-ada',expectedRevision:null},'select-ada')).json() as any;
 const old=await f.runtime.createSession({requestId:'old-running',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});
 await f.ctx.store.transact(tx=>tx.put('curator-work','captured',{id:'captured',sourcePaths:['lessons/input.md'],sessionId:old.id,generation:1,state:'running',prompt:'Captured work'}));
 expect((await f.put('/learning/assignment',{agentId:'agent-lin',expectedRevision:first.revision},'select-lin')).status).toBe(200);
 const jobs=await f.ctx.store.list<any>('curator-work');expect(jobs.find(j=>j.id==='captured')).toMatchObject({state:'failed',sessionId:old.id,generation:1});const fresh=jobs.find(j=>j.id!=='captured');expect(fresh).toMatchObject({state:'pending',sourcePaths:['lessons/input.md']});expect(fresh.sessionId).toBeUndefined();
 await f.runtime.curator.tick();const next=await f.ctx.store.read<any>('curator-work',fresh.id);expect(next.sessionId).not.toBe(old.id);expect((await f.runtime.snapshot(next.sessionId)).session).toMatchObject({agentId:'agent-lin'});expect((await f.runtime.snapshot(old.id)).session.agentId).toBe('agent-ada');
});
it('assigns an already-confirmed local curator grant without a second ownership claim',async()=>{
 const f=await fixture();await openWorkloadOwnership(f.ctx,f.git,'origin').claim('curator','earlier-local-claim');expect((await f.put('/learning/assignment',{agentId:'agent-ada',expectedRevision:null},'select-existing-grant')).status).toBe(200);
});
it('resumes an exact pending curator intent from a fresh authenticated request after browser reload',async()=>{
 const f=await fixture();await openWorkloadOwnership(f.ctx,f.git,'origin').claim('curator','pending-ui');const previous={agentId:'agent-ada',ownerId:f.ctx.instanceId,generation:1};await f.runtime.curator.assign(previous);const {stableId}=await import('../../src/runtime/admission.js');const expectedRevision=stableId(JSON.stringify(previous));const grant=await f.ctx.store.read('workload-grants','curator');
 await f.ctx.store.transact(tx=>tx.put('curator-reassignment','pending',{requestId:'old-browser-request',agentId:'agent-lin',expectedRevision,previous,grant}));
 const view=await (await f.get('/learning/assignment')).json() as any;expect(view.pending).toMatchObject({agentId:'agent-lin',expectedRevision});
 expect((await f.put('/learning/assignment',{agentId:'agent-lin',expectedRevision},'new-browser-request')).status).toBe(200);expect(await f.ctx.store.read('curator-reassignment','pending')).toBeUndefined();
});
it('derives current schedule state from settled local execution while retaining historical blockers separately',async()=>{
 const f=await fixture();const s=await (await f.post('/schedules',{id:'state',agentId:'agent-ada',cron:'0 9 * * *',timeZone:'UTC',instructions:'Review',enabled:true},'state-schedule')).json() as any;
 const session=await f.runtime.createSession({requestId:'scheduled-state',agentId:'agent-ada',background:true,workload:{workloadId:'schedule:state',generation:1}});await f.runtime.cancel(session.id);
 await f.ctx.store.transact(tx=>{tx.put('schedule-occurrence','run',{id:'run',scheduleId:'state',revision:s.revision,utc:'2026-10-23T09:00:00Z',localKey:'key',generation:1,state:'running',requestId:'scheduled-state',schedule:s,sessionId:session.id});tx.put('schedule-status','state',{state:'blocked',reason:'OLD_ERROR'});});
 const view=await (await f.get('/schedules')).json() as any;expect(view.items[0]).toMatchObject({currentState:'ready',lastDiagnostic:{reason:'OLD_ERROR'},occurrences:[{state:'cancelled'}]});
});
it('exposes sync pause, pending reconciliation and recovery through authenticated APIs',async()=>{
 const f=await fixture();await f.ctx.store.transact(tx=>tx.put('sync-apply-diagnostic','notes/local.md',{path:'notes/local.md',code:'LIVE_CHANGED'}));
 expect((await f.app.request('/api/v1/sync')).status).toBe(401);const pause=await f.post('/sync/pause',{},'pause');expect(await pause.json()).toMatchObject({status:{watch:{paused:true}},pending:[{code:'LIVE_CHANGED'}]});
 expect((await f.post('/sync/resume',{},'resume')).status).toBe(200);expect(await (await f.get('/sync')).json()).toMatchObject({status:{watch:{paused:false}}});expect((await f.post('/sync/run',{},'run')).status).toBe(200);
});

it('publishes authenticated agent and group edits with their exact user attribution',async()=>{
 const f=await fixture(false,'origin');await f.sync.flush();
 const agent=(await (await f.get('/agents')).json() as any[]).find(a=>a.id==='agent-ada');
 const {revision,...definition}=agent;
 expect((await f.put('/agents/agent-ada',{...definition,name:'Ada synchronized',expectedRevision:revision},'publish-agent')).status).toBe(200);
 const group=(await (await f.get('/groups')).json() as any[])[0];
 expect((await f.put('/groups/'+group.id,{id:group.id,name:'Synchronized group',description:'Attributed edit',expectedRevision:group.revision},'publish-group')).status).toBe(200);
 const actor=`user:${f.csrf.id}`;
 const writes=await f.ctx.store.list<{path:string;actor:string}>('vault-writes');
 const edited=writes.filter(w=>w.actor===actor);expect(edited).toHaveLength(2);
 await f.sync.flush();const status=await f.sync.status();expect(status.error).toBeUndefined();expect(status.exportError).toBeUndefined();
 const {parseConcept}=await import('../../src/vault/parse.js');
 for(const write of edited){
  const remote=await f.git.run(f.remote,['show',`main:${write.path}`]);expect(remote.exitCode).toBe(0);
  const concept=parseConcept(write.path,remote.stdout);
  expect((concept.metadata.lorecrew as {name:string}).name).toBe(write.path==='agents/ada.md'?'Ada synchronized':'Synchronized group');
 }
 const log=await f.git.run(f.remote,['log','main','--format=%B']);expect(log.exitCode).toBe(0);expect(log.stdout).toContain('Actor: '+actor);
 const captures=await f.ctx.store.list<{batch:{id:string;actor:string;files:Array<{path:string;content:string|null}>}}>('sync-captured');for(const write of edited){const captured=captures.find(c=>c.batch.actor===actor&&c.batch.files.some(file=>file.path===write.path));expect(captured).toBeDefined();const saved=await f.ctx.store.read<{checkpoint:{commit:string}}>('sync-local-commit',captured!.batch.id);expect(saved).toBeDefined();expect((await f.git.run(f.remote,['merge-base','--is-ancestor',saved!.checkpoint.commit,'main'])).exitCode).toBe(0);}
},15000);

it('lists the complete provider catalog and accepts browser-owned transient API-key login without durable secret receipts',async()=>{
 const f=await fixture();const catalog=await f.get('/providers');expect(catalog.status).toBe(200);const entries=await catalog.json() as any[];expect(entries.length).toBeGreaterThan(40);
 const start=await f.post('/providers/openai/login',{type:'api_key'},'provider-login-start');expect(start.status).toBe(200);let view=await start.json() as any;
 for(let i=0;i<100&&!view.prompt;i++){await new Promise(r=>setTimeout(r,2));view=await(await f.get('/provider-logins/'+view.id)).json();}
 expect(view.prompt.type).toBe('secret');
 expect((await f.app.request('/api/v1/provider-logins/'+view.id+'/answer',{method:'POST',headers:{...f.headers,'x-csrf-token':'wrong','idempotency-key':'csrf'},body:JSON.stringify({promptId:view.prompt.id,value:'fake-private-key'})})).status).toBe(403);
 const answered=await f.post('/provider-logins/'+view.id+'/answer',{promptId:view.prompt.id,value:'fake-private-key'},'provider-login-answer');expect(answered.status).toBe(200);expect(await answered.text()).not.toContain('fake-private-key');
 const repeat=await f.post('/provider-logins/'+view.id+'/answer',{promptId:view.prompt.id,value:'fake-private-key'},'provider-login-answer');expect(repeat.status).toBe(200);
 for(let i=0;i<100&&!['success','error'].includes(view.state);i++){await new Promise(r=>setTimeout(r,2));view=await(await f.get('/provider-logins/'+view.id)).json();}
 expect(view.state).toBe('success');expect(await(await f.get('/providers/openai')).json()).toMatchObject({available:true});
 expect(JSON.stringify(await f.ctx.store.list('api-request'))).not.toContain('fake-private-key');expect(await f.ctx.store.list('api-request')).toHaveLength(0);expect(JSON.stringify(await f.ctx.store.events(0))).not.toContain('fake-private-key');
});

it('completes scripted provider OAuth through authenticated HTTP while rejecting foreign principals and durable auth payloads',async()=>{
 const f=await fixture();const start=await(await f.post('/providers/openai/login',{type:'oauth'},'oauth-start')).json() as any;
 const status=async()=>(await(await f.get('/provider-logins/'+start.id)).json()) as any;
 const next=async()=>{let v=await status();for(let i=0;i<100&&!v.prompt&&v.state!=='success';i++){await new Promise(r=>setTimeout(r,2));v=await status();}return v;};
 let view=await next();expect(JSON.stringify(view)).toContain('example.test/authorize');
 const auth=openBrowserSessions(f.ctx),second=await auth.login(await auth.issueBootstrap());const foreignCookie='lorecrew_session='+second.cookie;
 expect((await f.app.request('/api/v1/provider-logins/'+start.id,{headers:{cookie:foreignCookie}})).status).toBe(404);
 expect((await f.app.request('/api/v1/provider-logins/'+start.id+'/answer',{method:'POST',headers:{cookie:foreignCookie,origin,'x-csrf-token':second.csrfToken,'content-type':'application/json','idempotency-key':'foreign'},body:JSON.stringify({promptId:view.prompt.id,value:'foreign'})})).status).toBe(404);
 for(const value of ['https://localhost/callback?code=fake-private-callback','personal','fake-private-confirmation']){view=await next();expect(view.prompt).toBeTruthy();const promptId=view.prompt.id;expect((await f.post('/provider-logins/'+start.id+'/answer',{promptId,value},'answer-'+promptId)).status).toBe(200);expect((await f.post('/provider-logins/'+start.id+'/answer',{promptId,value},'replay-'+promptId)).status).toBe(409);}
 view=await next();expect(view.state).toBe('success');expect(await(await f.get('/providers/openai')).json()).toMatchObject({available:true});expect((await f.runtime.listModels()).some(m=>m.provider==='openai'&&m.available)).toBe(true);
 const durable=JSON.stringify({receipts:await f.ctx.store.list('api-request'),events:await f.ctx.store.events(0)});expect(durable).not.toMatch(/fake-private|scripted-private|example.test\/authorize/);expect(await f.ctx.store.list('api-request')).toHaveLength(0);expect(JSON.stringify(view)).not.toMatch(/private|callback/);
});

it('cancels provider login when its browser session logs out and enforces bearer/browser isolation',async()=>{
 const f=await fixture();const start=await(await f.post('/providers/openai/login',{type:'oauth'},'oauth-logout')).json() as any;
 expect((await f.post('/auth/logout',{},'logout')).status).toBe(200);
 expect((await f.get('/provider-logins/'+start.id)).status).toBe(401);
 const {openTokens}=await import('../../src/auth/tokens.js');const token=await openTokens(f.ctx).create('test',['read','write']);
 expect((await f.app.request('/api/v1/providers/openai/login',{method:'POST',headers:{authorization:'Bearer '+token.token,'content-type':'application/json','idempotency-key':'bearer'},body:JSON.stringify({type:'api_key'})})).status).toBe(403);
});

const newAgent={id:'agent-new',name:'New agent',personality:'Careful helper',responsibilities:['Review work'],groups:['group-new'],model:{provider:'scripted',modelId:'test-model'}};
const newGroup={id:'group-new',name:'Engineering',description:'Shared engineering context'};
it('creates definitions in an empty vault and recovers the same publication after a lost receipt and API restart',async()=>{
 const f=await fixture(false,false,true);
 expect(await (await f.get('/agents')).json()).toEqual([]);expect(await (await f.get('/groups')).json()).toEqual([]);
 const group=await f.post('/groups',newGroup,'create-group');expect(group.status).toBe(200);const groupReceipt=await group.json();
 const agent=await f.post('/agents',newAgent,'create-agent');expect(agent.status).toBe(200);const agentReceipt=await agent.json();
 expect((await f.vault.read('agents/agent-new.md')).metadata).toMatchObject({type:'Agent',lorecrew:newAgent});
 expect((await f.vault.read('groups/group-new.md')).metadata).toMatchObject({type:'Group',lorecrew:newGroup});
 expect(await f.ctx.store.list('runtime-session')).toEqual([]);expect(await f.ctx.store.read('learning-assignment','curator')).toBeUndefined();
 // Remove the API acknowledgement, retain durable intent, and reopen both API and vault.
 const receipts=await f.ctx.store.list<any>('api-request');await f.ctx.store.transact(tx=>{for(const r of receipts)tx.put('api-request',r.requestId.slice(5),{fingerprint:r.fingerprint,requestId:r.requestId});});
 // Simulate a crash after group intent was journaled but before its file was published.
 const publication=(await f.ctx.store.list<any>('vault.proposals')).find(p=>p.path==='groups/group-new.md');await f.ctx.store.transact(tx=>tx.put('vault.proposals',publication.id,{...publication,state:'pending'}));await unlink(join(f.ctx.vaultDir,'groups/group-new.md'));
 const restarted=createApi({ctx:f.ctx,vault:openVault(f.ctx),runtime:f.runtime,team:f.runtime.team,ownership:openOwnership(f.ctx,f.git,'origin'),workspaces:new WorkspaceManager(f.ctx),providerOptions:{credentials:openCredentialFile(join(f.ctx.stateDir,'test-auth.json')),factories:scriptedLoginProviders},publicOrigin:origin});cleanup.push(async()=>closeApi(restarted));
 for(const [path,body,key,receipt] of [['/agents',newAgent,'create-agent',agentReceipt],['/groups',newGroup,'create-group',groupReceipt]] as const){const retry=await restarted.request('/api/v1'+path,{method:'POST',headers:{...f.headers,'idempotency-key':key},body:JSON.stringify(body)});expect(retry.status).toBe(200);expect(await retry.json()).toEqual(receipt);}
 expect((await f.post('/agents',{...newAgent,name:'Overwrite'},'duplicate-agent')).status).toBe(409);
 expect((await f.post('/groups',{...newGroup,name:'Overwrite'},'duplicate-group')).status).toBe(409);
 expect((await f.post('/agents',{...newAgent,name:'Changed intent'},'create-agent')).status).toBe(409);
 const session=await f.runtime.createSession({requestId:'created-agent-session',agentId:newAgent.id});expect(session.agentId).toBe(newAgent.id);
});
it('definition creation rejects unsafe identifiers, invalid fields, unknown models and overwrites of imported concepts',async()=>{
 const f=await fixture(false,false,true);
 for(const id of ['../escape','a/b','a\\b','.hidden','a%2fb','CON','aux','x'.repeat(81)]){expect((await f.post('/groups',{...newGroup,id},'unsafe-'+id)).status).toBe(400);expect((await f.post('/agents',{...newAgent,id},'unsafe-agent-'+id)).status).toBe(400);}
 for(const body of [{...newGroup,name:'  '},{...newGroup,description:''},{...newGroup,apiKey:'secret'},{...newGroup,revision:'injected'}])expect((await f.post('/groups',body,JSON.stringify(body))).status).toBe(400);
 expect((await f.post('/agents',{...newAgent,name:'  '},'blank-agent')).status).toBe(400);
 expect((await f.post('/agents',{...newAgent,model:{provider:'unknown',modelId:'unknown'}},'unknown-model')).status).toBe(422);
 expect((await f.post('/agents',{...newAgent,personality:'Bearer private-secret'},'credential-agent')).status).toBe(409);
 await f.vault.propose({id:'imported',path:'imported/team.md',expectedRevision:null,actor:'fixture',content:doc({type:'Group',custom:{retain:true},lorecrew:newGroup},'Preserved body')});
 expect((await f.post('/groups',newGroup,'imported-id')).status).toBe(409);
 await f.vault.propose({id:'occupied',path:'groups/occupied.md',expectedRevision:null,actor:'fixture',content:doc({type:'Note'},'Keep this note')});
 expect((await f.post('/groups',{...newGroup,id:'occupied'},'occupied-path')).status).toBe(409);
 expect((await f.vault.read('groups/occupied.md')).body).toContain('Keep this note');expect((await f.vault.read('imported/team.md')).metadata.custom).toEqual({retain:true});
 expect((await f.vault.list()).filter(c=>c.metadata.type==='Agent')).toHaveLength(0);
});
it('definition creation requires write authentication, CSRF and an idempotency key',async()=>{
 const f=await fixture(false,false,true);
 expect((await f.app.request('/api/v1/groups',{method:'POST',body:JSON.stringify(newGroup)})).status).toBe(401);
 expect((await f.app.request('/api/v1/groups',{method:'POST',headers:{cookie:f.cookie,origin,'content-type':'application/json','idempotency-key':'no-csrf'},body:JSON.stringify(newGroup)})).status).toBe(403);
 expect((await f.app.request('/api/v1/groups',{method:'POST',headers:f.headers,body:JSON.stringify(newGroup)})).status).toBe(400);
 const token=await f.post('/auth/tokens',{name:'Read only',scopes:['read']},'read-token');const auth=await token.json() as {token:string};
 expect((await f.app.request('/api/v1/agents',{method:'POST',headers:{authorization:'Bearer '+auth.token,'content-type':'application/json','idempotency-key':'read-create'},body:JSON.stringify(newAgent)})).status).toBe(403);
});

it('creates portable definitions with unavailable credentials and preserves imported IDs and content when editing',async()=>{
 const f=await fixture(false,false,true);f.provider.models.setProvider({...f.provider.faux.provider,auth:{apiKey:{name:'Unconfigured scripted provider',check:async()=>undefined,resolve:async()=>undefined}}});const models=await f.runtime.listModels();const unavailable=models.find(m=>!m.available)!;expect(unavailable).toBeTruthy();
 const created=await f.post('/agents',{...newAgent,model:{provider:unavailable.provider,modelId:unavailable.modelId}},'portable-unavailable');expect(created.status).toBe(200);
 const imported={id:'Imported group / unique',name:'Imported',description:'Imported context'};
 await f.vault.propose({id:'import-arbitrary',path:'custom/imported.md',expectedRevision:null,actor:'fixture',content:doc({type:'Group',custom:{keep:true},lorecrew:{...imported,extra:'Retained'}},'Keep this body')});
 const revision=(await f.vault.read('custom/imported.md')).revision;const edit={...imported,name:'Edited imported',expectedRevision:revision};
 expect((await f.put('/groups/'+encodeURIComponent(imported.id),edit,'edit-imported')).status).toBe(200);expect((await f.put('/groups/'+encodeURIComponent(imported.id),edit,'stale-imported')).status).toBe(409);
 const concept=await f.vault.read('custom/imported.md');expect(concept.body).toContain('Keep this body');expect(concept.metadata).toMatchObject({custom:{keep:true},lorecrew:{extra:'Retained',name:'Edited imported'}});
});
