import {gitProject} from '../helpers/git-project.js';
import { afterEach, expect, it } from 'vitest';
import { cp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { bindProject } from '../../src/projects/bindings.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openVault } from '../../src/vault/write.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
import { createApi } from '../../src/api/app.js';
import { openBrowserSessions } from '../../src/auth/sessions.js';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';
import { createSessionSnapshotSource, startEventReconciliation } from '../../src/api/events.js';
import { publicSnapshot } from '../../src/api/routes.js';
import { startApp } from '../../src/app.js';
import { Value } from 'typebox/value';
import { AppError } from '../../src/contracts/base.js';
import { ResetSchema, SseMessageSchema, SessionSnapshotSchema } from '../../src/api/schemas.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const origin='http://localhost';
async function fixture(extensions:Extension[]=[]) {
  const f=await gitFleet();cleanup.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,'origin');
  const ownership=openOwnership(f.a.ctx,f.a.git,'origin');await ownership.claim({id:'project',repositoryKey:'fork:api',title:'API'},'claim');
  await cp('tests/fixtures/vault/agents',join(f.a.ctx.vaultDir,'agents'),{recursive:true});
  const path=join(f.a.ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replaceAll('local-openai','scripted').replaceAll('coding-model','test-model'));
  await bindProject(f.a.ctx,{projectId:'project',path:await gitProject(join(f.root,f.a.ctx.instanceId+'-code'))});
  const provider=scriptedProvider();provider.faux.setResponses(Array.from({length:20},()=>fauxAssistantMessage('API reply')));
  const vault=openVault(f.a.ctx);const workspaces=new WorkspaceManager(f.a.ctx);
  const runtime=await openRuntime({ctx:f.a.ctx,vault,ownership,workspaces,supervisor:new ProcessSupervisor(f.a.ctx),models:provider.models,extensions});cleanup.push(()=>runtime.close());
  const auth=openBrowserSessions(f.a.ctx);const secret=await auth.issueBootstrap();
  const app=createApi({ctx:f.a.ctx,runtime,team:runtime.team,vault,ownership,workspaces,auth,publicOrigin:origin});
  const login=await app.request('/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({secret})});
  expect(login.status).toBe(200);
  const credentials=await login.json() as {csrfToken:string;id:string};
  const cookie=login.headers.get('set-cookie')?.split(';')[0]??'';
  const headers={cookie,origin,'x-csrf-token':credentials.csrfToken,'content-type':'application/json'};
  const write=(body:unknown,key='request')=>({method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});
  return {...f,...provider,ctx:f.a.ctx,runtime,app,auth,secret,headers,write,cookie,credentials,workspaces};
}
const task={projectId:'project',leadAgentId:'agent-ada',objective:'Review API'};

it('stops a local task subtree through the authenticated idempotent API',async()=>{
  const f=await fixture();
  expect((await f.app.request('/api/v1/tasks/missing/cancel',f.write({},'missing-stop'))).status).toBe(404);
  const root=await f.runtime.team.createTask({...task,requestId:'stop-root'});
  const child=await f.runtime.team.delegate({requestId:'stop-child',parentTaskId:root.id,agentId:'agent-ada',objective:'Inspect locally',deliverable:'Report',contextPaths:[],dependsOn:[]});
  const path=`/api/v1/tasks/${root.id}/cancel`;
  const response=await f.app.request(path,f.write({},'stop-tree'));expect(response.status).toBe(200);expect(await response.json()).toEqual({quiescent:true});
  expect((await f.runtime.team.getTask(root.id)).state).toBe('cancelled');expect((await f.runtime.team.getTask(child.id)).state).toBe('cancelled');
  expect(await (await f.app.request(path,f.write({},'stop-tree'))).json()).toEqual({quiescent:true});
  expect((await f.app.request(path,{method:'POST',headers:{...f.headers,origin:'https://other.test'},body:'{}'})).status).toBe(403);
});

it('preserves an uncertain task-stop proof instead of manufacturing success',async()=>{
  const f=await fixture();const created=await f.runtime.team.createTask({...task,requestId:'uncertain-stop'});
  f.runtime.team.stopTaskAndProve=async()=>({quiescent:false,reason:'Process identity remains uncertain'});
  const response=await f.app.request(`/api/v1/tasks/${created.id}/cancel`,f.write({},'uncertain'));
  expect(response.status).toBe(200);expect(await response.json()).toEqual({quiescent:false,reason:'Process identity remains uncertain'});
});
const session={agentId:'agent-ada'};
async function firstEvent(response:Response) {
  const reader=response.body!.getReader();let text='';
  try{while(!text.includes('\n\n')){const result=await reader.read();if(result.done)break;text+=new TextDecoder().decode(result.value);}}finally{await reader.cancel();}
  const lines=text.split('\n');return {event:lines.find(l=>l.startsWith('event:'))?.slice(6).trim(),id:Number(lines.find(l=>l.startsWith('id:'))?.slice(3).trim()),data:JSON.parse(lines.find(l=>l.startsWith('data:'))?.slice(5).trim()??'null')};
}
it('requires authentication, same-origin browser writes and matching CSRF',async()=>{
  const f=await fixture();expect((await f.app.request('/api/v1/instance')).status).toBe(401);
  expect((await f.app.request('/api/v1/instance',{headers:{cookie:f.cookie}})).status).toBe(200);
  expect((await f.app.request('/api/v1/tasks',{...f.write(task),headers:{...f.headers,origin:'https://evil.test','idempotency-key':'foreign'}})).status).toBe(403);
  expect((await f.app.request('/api/v1/tasks',{...f.write(task),headers:{...f.headers,'x-csrf-token':'wrong','idempotency-key':'csrf'}})).status).toBe(403);
  expect((await f.app.request('/api/v1/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({secret:f.secret})})).status).toBe(401);
  const saved=JSON.stringify([...await f.ctx.store.list('auth-bootstrap'),...await f.ctx.store.list('auth-session')]);expect(saved).not.toContain(f.secret);expect(saved).not.toContain(f.cookie.split('=')[1]);expect(saved).not.toContain(f.credentials.csrfToken);
});
it('issues scoped revocable tokens without privilege escalation and revokes browser sessions',async()=>{
  const f=await fixture();const response=await f.app.request('/api/v1/auth/tokens',f.write({name:'Reader',scopes:['read']},'reader'));expect(response.status).toBe(201);
  const token=await response.json() as {id:string;token:string};const bearer={authorization:`Bearer ${token.token}`,'content-type':'application/json','idempotency-key':'bearer'};
  expect((await f.app.request('/api/v1/instance',{headers:bearer})).status).toBe(200);
  expect((await f.app.request('/api/v1/tasks',{method:'POST',headers:bearer,body:JSON.stringify(task)})).status).toBe(403);
  expect((await f.app.request('/api/v1/auth/tokens',{method:'POST',headers:bearer,body:JSON.stringify({name:'Escalate',scopes:['write']})})).status).toBe(403);
  expect(JSON.stringify(await f.ctx.store.list('auth-token'))).not.toContain(token.token);
  expect((await f.app.request(`/api/v1/auth/tokens/${token.id}`,{method:'DELETE',headers:f.headers})).status).toBe(200);
  expect((await f.app.request('/api/v1/instance',{headers:bearer})).status).toBe(401);
  expect((await f.app.request('/api/v1/auth/logout',{method:'POST',headers:f.headers})).status).toBe(200);
  expect((await f.app.request('/api/v1/instance',{headers:{cookie:f.cookie}})).status).toBe(401);
});
it('deduplicates concurrent mutations durably and rejects key/body or route conflicts',async()=>{
  const f=await fixture();const [a,b]=await Promise.all([f.app.request('/api/v1/tasks',f.write(task)),f.app.request('/api/v1/tasks',f.write(task))]);
  expect(a.status).toBe(201);expect(b.status).toBe(201);const created=await a.json();expect(await b.json()).toEqual(created);
  expect((await f.app.request('/api/v1/tasks',f.write({...task,objective:'Different'}))).status).toBe(409);
  expect((await f.app.request('/api/v1/sessions',f.write(session))).status).toBe(409);
  expect(await f.ctx.store.list('team-task')).toHaveLength(1);
});
it('validates schemas, requires idempotency and reports unknown configured models',async()=>{
  const f=await fixture();expect((await f.app.request('/api/v1/tasks',f.write({...task,extra:true},'extra'))).status).toBe(400);
  expect((await f.app.request('/api/v1/tasks',f.write({projectId:5},'malformed'))).status).toBe(400);
  expect((await f.app.request('/api/v1/tasks',{method:'POST',headers:f.headers,body:JSON.stringify(task)})).status).toBe(400);
  const path=join(f.ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replaceAll('test-model','unknown-model'));
  const response=await f.app.request('/api/v1/sessions',f.write(session,'unknown'));expect(response.status).toBe(422);expect(await response.json()).toMatchObject({error:{code:'UNKNOWN_MODEL'}});
});
it('rejects remote ids and exposes local tasks, decisions, models, agents and diffs',async()=>{
  const f=await fixture();expect((await f.app.request('/api/v1/sessions/remote-id/cancel',f.write({},'remote'))).status).toBe(404);
  expect((await f.app.request('/api/v1/tasks/remote-id/steer',f.write({text:'remote'},'remote-steer'))).status).toBe(404);
  const response=await f.app.request('/api/v1/tasks',f.write(task));const created=await response.json() as {id:string;leadSessionId:string;workspaceId:string};expect(response.status).toBe(201);
  await f.runtime.team.ask({id:'choice',taskId:created.id,question:'How?',recommendation:'Small',blockedTaskIds:[]});
  expect((await f.app.request('/api/v1/decisions/choice/answer',f.write({text:'Small'},'answer'))).status).toBe(200);
  for(const route of ['/instance','/models','/agents','/projects','/tasks','/sessions',`/tasks/${created.id}`,`/workspaces/${created.workspaceId}/diff`,'/snapshot'])expect((await f.app.request('/api/v1'+route,{headers:f.headers})).status,route).toBe(200);
  expect((await f.app.request(`/api/v1/tasks/${created.id}/steer`,f.write({text:'Focus'},'steer'))).status).toBe(200);
});
it('exposes schema-valid output/tool state without provider-private payloads',async()=>{
  const f=await fixture();f.faux.setResponses([fauxAssistantMessage(fauxToolCall('read',{path:'README.md'}),{stopReason:'toolUse',responseId:'provider-private'}),fauxAssistantMessage('Output visible')]);
  const response=await f.app.request('/api/v1/sessions',f.write({...session,projectId:'project'},'conversation'));const created=await response.json() as {id:string};expect(response.status).toBe(201);
  expect((await f.app.request(`/api/v1/sessions/${created.id}/messages`,f.write({text:'Read README.md'},'message'))).status).toBe(202);
  await expect.poll(async()=>JSON.stringify((await f.runtime.snapshot(created.id)).messages)).toContain('Output visible');
  const result=await (await f.app.request(`/api/v1/sessions/${created.id}`,{headers:f.headers})).json();expect(Value.Check(SessionSnapshotSchema,result)).toBe(true);
  expect(JSON.stringify(result)).toContain('Output visible');expect(JSON.stringify(result)).toContain('Fixture');expect(result.tools.length).toBeGreaterThan(0);expect(result.usage.models['scripted/test-model'].input).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain('apiKey');expect(JSON.stringify(result)).not.toContain('responseId');expect(JSON.stringify(result)).not.toContain('pi.assistant');
});
it('replays durable SSE exactly after cursor and resets expired or future cursors',async()=>{
  const f=await fixture();await f.ctx.store.transact(tx=>{tx.emit('test.one',{n:1});tx.emit('test.two',{n:2});});
  const events=await f.ctx.store.events(0);const first=events.at(-2)!;const last=events.at(-1)!;
  const replay=await firstEvent(await f.app.request('/api/v1/events',{headers:{...f.headers,'last-event-id':String(first.seq)}}));expect(replay).toMatchObject({id:last.seq,event:last.kind,data:last});expect(Value.Check(SseMessageSchema,{...replay,id:String(replay.id)})).toBe(true);
  await f.ctx.store.transact(tx=>{for(let i=0;i<10_005;i++)tx.emit('test.retention',{n:i});});
  const reset=await firstEvent(await f.app.request('/api/v1/events?after='+first.seq,{headers:f.headers}));expect(reset.event).toBe('reset');expect(Value.Check(ResetSchema,reset.data)).toBe(true);expect(Value.Check(SseMessageSchema,{event:reset.event,data:reset.data})).toBe(true);
  expect((await firstEvent(await f.app.request('/api/v1/events?after=99999999',{headers:f.headers}))).event).toBe('reset');
  expect((await f.ctx.store.events(0)).length).toBeLessThanOrEqual(10_000);
});
it('uses configured HTTPS origin for Secure cookies and ignores forwarded headers',async()=>{
  const f=await fixture();const secret=await f.auth.issueBootstrap();
  const app=createApi({ctx:f.ctx,runtime:f.runtime,team:f.runtime.team,vault:openVault(f.ctx),ownership:openOwnership(f.ctx,f.a.git,'origin'),workspaces:f.workspaces,auth:f.auth,publicOrigin:'https://crew.example'});
  const body=JSON.stringify({secret});
  expect((await app.request('/api/v1/auth/login',{method:'POST',headers:{origin:'https://evil.test','x-forwarded-host':'crew.example','content-type':'application/json'},body})).status).toBe(403);
  const response=await app.request('/api/v1/auth/login',{method:'POST',headers:{origin:'https://crew.example','content-type':'application/json'},body});expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);expect(response.headers.get('set-cookie')).toMatch(/Secure/);expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
});
it('starts a loopback ephemeral server and prints bootstrap only to the local callback',async()=>{
  const f=await fixture();let printed='';const app=await startApp({stateDir:join(f.root,'served-state'),vaultDir:f.ctx.vaultDir,port:0,onBootstrap:secret=>{printed=secret;}});cleanup.push(app.close);
  expect(app.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);expect(printed.length).toBeGreaterThan(30);
  expect((await fetch(app.url+'/api/v1/instance')).status).toBe(401);
});

it('generates OpenAPI from the same request and response schemas and restores CSRF after reload',async()=>{
  const f=await fixture();const response=await f.app.request('/api/v1/openapi.json',{headers:f.headers});expect(response.status).toBe(200);
  const document=JSON.parse(await response.text());expect(document.openapi).toBe('3.1.0');
  expect(document.paths['/api/v1/tasks'].post.requestBody.content['application/json'].schema.additionalProperties).toBe(false);
  expect(document.paths['/api/v1/sessions/{id}'].get.responses['200'].content['application/json'].schema).toEqual(SessionSnapshotSchema);
  const stream=document.paths['/api/v1/events'].get.responses['200'].content['text/event-stream'];expect(stream.schema).toEqual(SseMessageSchema);
  const headers=document.paths['/api/v1/tasks'].post.parameters;expect(headers).toContainEqual(expect.objectContaining({name:'Origin',in:'header',required:false}));expect(headers).toContainEqual(expect.objectContaining({name:'X-CSRF-Token',in:'header',required:false}));
  expect(document.paths['/api/v1/tasks'].post.description).toContain('cookie-authenticated');
  expect(document.paths['/api/v1/auth/login'].post.parameters).toContainEqual(expect.objectContaining({name:'Origin',in:'header',required:true}));
  expect(document.paths['/api/v1/auth/logout'].post.parameters).toContainEqual(expect.objectContaining({name:'X-CSRF-Token',in:'header',required:true}));
  expect(document.components.schemas.EventReset).toEqual(ResetSchema);
  const inspected=await (await f.app.request('/api/v1/auth/session',{headers:f.headers})).json();expect(inspected.csrfToken).toBe(f.credentials.csrfToken);
});
it('recovers an API receipt loss with the same durable request id and keeps principals separate',async()=>{
  const f=await fixture();const original=f.ctx.store.transact;let fail=true;
  f.ctx.store.transact=fn=>original(tx=>fn({...tx,put(kind,id,value){if(fail&&kind==='api-request'){fail=false;throw new Error('lost API receipt');}tx.put(kind,id,value);}}));
  expect((await f.app.request('/api/v1/tasks',f.write(task,'lost-receipt'))).status).toBe(500);
  const replacement=createApi({ctx:f.ctx,runtime:f.runtime,team:f.runtime.team,vault:openVault(f.ctx),ownership:openOwnership(f.ctx,f.a.git,'origin'),workspaces:f.workspaces,auth:f.auth,publicOrigin:origin});
  const agentPath=join(f.ctx.vaultDir,'agents/ada.md');const definition=await readFile(agentPath,'utf8');await writeFile(agentPath,definition.replaceAll('test-model','removed-model'));
  const retry=await replacement.request('/api/v1/tasks',f.write(task,'lost-receipt'));expect(retry.status).toBe(201);expect(await f.ctx.store.list('team-task')).toHaveLength(1);
  expect((await replacement.request('/api/v1/tasks',f.write(task,'new-admission'))).status).toBe(422);
  await writeFile(agentPath,definition);fail=true;
  expect((await replacement.request('/api/v1/sessions',f.write(session,'session-receipt'))).status).toBe(500);await unlink(agentPath);
  expect((await replacement.request('/api/v1/sessions',f.write(session,'session-receipt'))).status).toBe(201);
  await writeFile(agentPath,definition);
  const token=await (await f.app.request('/api/v1/auth/tokens',f.write({name:'Writer',scopes:['read','write']},'writer'))).json();
  const headers={authorization:`Bearer ${token.token}`,'content-type':'application/json','idempotency-key':'lost-receipt'};
  expect((await replacement.request('/api/v1/sessions',{method:'POST',headers,body:JSON.stringify(session)})).status).toBe(201);
});
it('streams persisted output/status invalidation once per public change and reconciles after restart',async()=>{
  const f=await fixture();const created=await (await f.app.request('/api/v1/sessions',f.write(session,'live'))).json();
  const snapshots=async()=>[publicSnapshot(await f.runtime.snapshot(created.id))];
  const monitor=startEventReconciliation(f.ctx,snapshots);cleanup.push(monitor.close);
  await monitor.reconcile();const cursor=(await f.ctx.store.events(0)).at(-1)!.seq;
  await f.app.request(`/api/v1/sessions/${created.id}/messages`,f.write({text:'Live output'},'live-message'));
  await expect.poll(async()=>(await f.runtime.snapshot(created.id)).status).toBe('completed');
  await monitor.reconcile();const changes=(await f.ctx.store.events(cursor)).filter(event=>event.kind==='session.updated');expect(changes).toHaveLength(1);expect(changes[0]!.data).toMatchObject({sessionId:created.id,status:'completed'});
  const before=(await f.ctx.store.events(0)).length;await monitor.reconcile();expect((await f.ctx.store.events(0)).length).toBe(before);
  const streamed=await firstEvent(await f.app.request('/api/v1/events?after='+(changes[0]!.seq-1),{headers:f.headers}));expect(streamed).toMatchObject({event:'session.updated',id:changes[0]!.seq});
  await monitor.close();const restarted=startEventReconciliation(f.ctx,snapshots);cleanup.push(restarted.close);await restarted.reconcile();expect((await f.ctx.store.events(0)).length).toBe(before);
  expect(JSON.stringify(await f.ctx.store.list('api-session-snapshot'))).toContain('API reply');
});

it('supports an explicitly configured LAN HTTP origin and rejects unspecified nonloopback origins',async()=>{
  const f=await fixture();const lan='http://192.168.1.20:4317';const secret=await f.auth.issueBootstrap();
  const app=createApi({ctx:f.ctx,runtime:f.runtime,team:f.runtime.team,vault:openVault(f.ctx),ownership:openOwnership(f.ctx,f.a.git,'origin'),workspaces:f.workspaces,auth:f.auth,publicOrigin:lan,name:'Desktop'});
  const response=await app.request('/api/v1/auth/login',{method:'POST',headers:{origin:lan,'content-type':'application/json'},body:JSON.stringify({secret})});expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).not.toMatch(/; Secure/);
  await expect(startApp({stateDir:join(f.root,'unconfigured-state'),vaultDir:f.ctx.vaultDir,host:'0.0.0.0',port:0})).rejects.toMatchObject({code:'INVALID_ORIGIN'});
  const cookie=response.headers.get('set-cookie')!.split(';')[0]!;expect(await (await app.request('/api/v1/instance',{headers:{cookie}})).json()).toMatchObject({name:'Desktop',instanceId:f.ctx.instanceId});
});
it('returns generic 500 for a public response contract failure',async()=>{
  const f=await fixture();f.runtime.listModels=async()=>{throw new AppError('INTERNAL_CONTRACT','provider-private failure');};
  const response=await f.app.request('/api/v1/models',{headers:f.headers});expect(response.status).toBe(500);expect(await response.text()).not.toContain('provider-private');
});

it('reconciles final cancellation output after an interim cancelled projection and after restart',async()=>{
  let started!:()=>void;let aborted!:()=>void;let release!:()=>void;
  const active=new Promise<void>(resolve=>{started=resolve;});const aborting=new Promise<void>(resolve=>{aborted=resolve;});const barrier=new Promise<void>(resolve=>{release=resolve;});
  const extension=defineExtension({name:'cancel-output',tools:[defineTool({name:'cleanup',description:'Wait for cancellation cleanup',parameters:Type.Object({}),replay:'safe',async execute(_args,_api,context){
    started();await new Promise<void>(resolve=>{context.abortSignal?.addEventListener('abort',()=>{aborted();resolve();},{once:true});});await barrier;return {output:[{type:'text',text:'Final cleanup output'}]};
  }})]});
  const f=await fixture([extension]);f.faux.setResponses([fauxAssistantMessage(fauxToolCall('cleanup',{}),{stopReason:'toolUse'})]);
  const created=await (await f.app.request('/api/v1/sessions',f.write({...session,projectId:'project'},'cancel-session'))).json();
  await f.app.request(`/api/v1/sessions/${created.id}/messages`,f.write({text:'Wait for cleanup'},'cancel-run'));await active;
  const source=createSessionSnapshotSource(f.ctx,f.runtime,publicSnapshot);const monitor=startEventReconciliation(f.ctx,source);cleanup.push(monitor.close);
  const cancellation=f.runtime.cancel(created.id);await aborting;
  try{
    await monitor.reconcile();expect((await f.ctx.store.list<{snapshot:{status:string}}>('api-session-snapshot'))[0]!.snapshot.status).toBe('cancelled');
    expect(await (await f.app.request(`/api/v1/sessions/${created.id}`,{headers:f.headers})).json()).toMatchObject({stopState:'requested'});
    const cursor=(await f.ctx.store.events(0)).at(-1)!.seq;await monitor.close();
    const resumed=startEventReconciliation(f.ctx,createSessionSnapshotSource(f.ctx,f.runtime,publicSnapshot));cleanup.push(resumed.close);release();await cancellation;
    await resumed.reconcile();const changes=(await f.ctx.store.events(cursor)).filter(event=>event.kind==='session.updated');expect(changes).toHaveLength(1);
    expect(JSON.stringify(await f.ctx.store.list('api-session-snapshot'))).toContain('Tool cleanup was aborted');
    const exposed=await (await f.app.request(`/api/v1/sessions/${created.id}`,{headers:f.headers})).json();expect(exposed).not.toHaveProperty('settled');expect(exposed).not.toHaveProperty('cancellationSettled');expect(exposed.stopState).toBe('confirmed');
    await resumed.close();const restarted=startEventReconciliation(f.ctx,createSessionSnapshotSource(f.ctx,f.runtime,publicSnapshot));cleanup.push(restarted.close);await restarted.reconcile();
    expect((await f.ctx.store.events(cursor)).filter(event=>event.kind==='session.updated')).toHaveLength(1);
  }finally{release();await cancellation.catch(()=>{});}
});
it('does no transcript work for unchanged idle sessions and observes only a changed session',async()=>{
 const f=await fixture();const ids:string[]=[];for(let i=0;i<8;i++){const created=await f.runtime.createSession({requestId:`idle-${i}`,agentId:'agent-ada'});ids.push(created.id);}
 const source=createSessionSnapshotSource(f.ctx,f.runtime,publicSnapshot);const monitor=startEventReconciliation(f.ctx,source);cleanup.push(monitor.close);await monitor.reconcile();let calls=0;const original=f.runtime.snapshot.bind(f.runtime);f.runtime.snapshot=async id=>{calls++;return original(id);};await monitor.reconcile();expect(calls).toBe(0);
 f.faux.setResponses([fauxAssistantMessage('Changed only one')]);await f.runtime.submit({sessionId:ids[0]!,requestId:'one-change',text:'Changed'});await expect.poll(async()=>(await original(ids[0]!)).status).toBe('completed');await monitor.reconcile();expect(calls).toBe(1);expect(JSON.stringify(await f.ctx.store.read('api-session-snapshot',ids[0]!))).toContain('Changed only one');
});
it('orders new question and answer cohorts causally without rewriting existing history cursors',async()=>{
 const f=await fixture();const session=await f.runtime.createSession({requestId:'chronology',agentId:'agent-ada'});const at='2026-10-24T10:00:00.000Z';await f.ctx.store.transact(tx=>{for(const [id,state] of [['answer:d','answered'],['decision:d','pending']])tx.put('team-history',`${session.id}:${id}`,{sessionId:session.id,entry:{id:`team:${id}`,kind:'decision',at,data:{id:'d',state}}});});const first=await f.runtime.history(session.id);expect(first.map(e=>e.id)).toEqual(['team:decision:d','team:answer:d']);
 await f.ctx.store.transact(tx=>tx.put('team-history',`${session.id}:decision:late`,{sessionId:session.id,entry:{id:'team:decision:late',kind:'decision',at:'2026-10-23T00:00:00Z',data:{question:'Late recovered question'}}}));expect((await f.runtime.history(session.id,'team:answer:d')).map(e=>e.id)).toEqual(['team:decision:late']);
});
it('exports one changed conversation without rereading other conversations or global control history',async()=>{
 const {openExporter}=await import('../../src/export/outbox.js');const f=await fixture();const sessions:Array<{id:string}>=[];for(let i=0;i<8;i++)sessions.push(await f.runtime.createSession({requestId:`export-idle-${i}`,agentId:'agent-ada'}));const exporter=openExporter({ctx:f.ctx,vault:openVault(f.ctx),runtime:f.runtime,baseRevision:async()=>null});for(const batch of await exporter.flush())await exporter.acknowledge(batch.id);
 const history=f.runtime.history.bind(f.runtime);const calls:string[]=[];f.runtime.history=async(id,after)=>{calls.push(id);return history(id,after);};const list=f.ctx.store.list.bind(f.ctx.store);const full:string[]=[];f.ctx.store.list=async <T>(kind:string)=>{if(['team-history','team-task','team-decision','team-message','team-report','team-envelope','export-file','export-batch','api-session-snapshot'].includes(kind))full.push(kind);return list<T>(kind);};await exporter.flush();expect(calls).toEqual([]);f.faux.setResponses([fauxAssistantMessage('Only this conversation changed')]);await f.runtime.submit({sessionId:sessions[0]!.id,requestId:'export-one',text:'One change'});await expect.poll(async()=>(await f.runtime.snapshot(sessions[0]!.id)).status).toBe('completed');full.length=0;await exporter.flush();expect(calls).toEqual([sessions[0]!.id]);expect(full).toEqual([]);
});
it('accepts a mode-free ordinary conversation and rejects obsolete capability input',async()=>{
 const f=await fixture();const current=await f.app.request('/api/v1/sessions',f.write({agentId:'agent-ada'},'unified-current'));expect(current.status).toBe(201);
 const obsolete=await f.app.request('/api/v1/sessions',f.write({agentId:'agent-ada',mode:'read'},'unified-obsolete'));expect(obsolete.status).toBe(400);expect(await obsolete.json()).toMatchObject({error:{code:'INVALID_REQUEST'}});
});
