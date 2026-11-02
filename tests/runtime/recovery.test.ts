import { afterEach, expect, it } from 'vitest';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension } from '@earendil-works/pi-durable';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { openInstance } from '../../src/instance/open.js';
import { openVault } from '../../src/vault/write.js';
import { openOwnership } from '../../src/projects/ownership.js';
import { GitClient } from '../../src/git/client.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { temporaryInstance } from '../helpers/temp.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
const cleanup: Array<()=>Promise<void>>=[];
afterEach(async()=>{ for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(extensions: Extension[] = []) {
  const tmp = await temporaryInstance(); cleanup.push(tmp.cleanup);
  await cp('tests/fixtures/vault', tmp.paths.vaultDir, {recursive:true});
  const path=join(tmp.paths.vaultDir,'agents/ada.md');
  await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
  const ctx=await openInstance(tmp.paths); cleanup.push(()=>ctx.close());
  const provider=scriptedProvider();
  const options={ctx,vault:openVault(ctx),ownership:openOwnership(ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,extensions};
  let runtime=await openRuntime(options); cleanup.push(()=>runtime.close());
  return {...tmp,ctx,...provider,get runtime(){return runtime;},path,async reopen(resume=true){await runtime.close();runtime=await openRuntime({...options,resume});}};
}
async function settled(runtime: Awaited<ReturnType<typeof openRuntime>>, id:string) {
  await expect.poll(async()=> (await runtime.snapshot(id)).status).not.toBe('running');
  return runtime.snapshot(id);
}
it('keeps conversation dates durable without treating reads or retries as activity',async()=>{
  const f=await fixture();
  const before=Date.now();const input={requestId:'dated-chat',agentId:'agent-ada'};
  const session=await f.runtime.createSession(input);const created=await f.runtime.snapshot(session.id);
  expect(Date.parse(created.createdAt!)).toBeGreaterThanOrEqual(before);
  expect(created.updatedAt).toBe(created.createdAt);
  f.faux.setResponses([fauxAssistantMessage('A dated response')]);
  const message={sessionId:session.id,requestId:'dated-message',text:'A dated question'};
  await f.runtime.submit(message);const completed=await settled(f.runtime,session.id);
  expect(Date.parse(completed.updatedAt!)).toBeGreaterThan(Date.parse(created.createdAt!));
  await f.runtime.createSession(input);await f.runtime.submit(message);
  expect((await f.runtime.snapshot(session.id)).updatedAt).toBe(completed.updatedAt);
  await f.reopen();const restored=await f.runtime.snapshot(session.id);
  expect(restored.createdAt).toBe(created.createdAt);expect(restored.updatedAt).toBe(completed.updatedAt);
});
it('leaves legacy start dates unknown and recovers last activity from durable transcript timestamps',async()=>{
  const f=await fixture();f.faux.setResponses([fauxAssistantMessage('Historical response')]);
  const session=await f.runtime.createSession({requestId:'legacy-dates',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:session.id,requestId:'legacy-question',text:'Historical question'});const completed=await settled(f.runtime,session.id);
  await f.runtime.close();
  await f.ctx.store.transact(tx=>{const record=tx.get<import('../../src/runtime/types.js').SessionRecord>('runtime-session',session.id)!;delete record.createdAt;tx.put('runtime-session',session.id,record);tx.delete('runtime-session-activity',session.id);});
  await f.reopen();const restored=await f.runtime.snapshot(session.id);
  expect(restored.createdAt).toBeUndefined();expect(Date.parse(restored.updatedAt!)).toBeGreaterThan(0);
  expect(Date.parse(restored.updatedAt!)).toBeLessThanOrEqual(Date.parse(completed.updatedAt!));
  const empty=await f.runtime.createSession({requestId:'legacy-empty',agentId:'agent-ada'});
  await f.runtime.close();await f.ctx.store.transact(tx=>{const record=tx.get<import('../../src/runtime/types.js').SessionRecord>('runtime-session',empty.id)!;delete record.createdAt;tx.put('runtime-session',empty.id,record);tx.delete('runtime-session-activity',empty.id);});
  await f.reopen();expect(await f.runtime.snapshot(empty.id)).toMatchObject({session:{id:empty.id}});
  expect((await f.runtime.snapshot(empty.id)).updatedAt).toBeUndefined();
});
it('deduplicates logical submissions and executes a real CodeMode nested tool once',async()=>{
  let calls=0;
  const extension=defineExtension({name:'fixture',tools:[defineTool({name:'count',description:'Count a durable nested effect',parameters:Type.Object({}),replay:'unsafe',async execute(){calls++;return {output:[{type:'text',text:'counted'}]};}})]});
  const f=await fixture([extension]);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.count({}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  const input={sessionId:s.id,requestId:'submit',text:'Count'};
  const one=await f.runtime.submit(input); const two=await f.runtime.submit(input);
  expect(two).toEqual(one);
  const snap=await settled(f.runtime,s.id);
  expect(snap.status).toBe('completed'); expect(calls).toBe(1);
  expect(snap.messages.filter((m: {kind:string})=>m.kind==='user')).toHaveLength(1);
  await f.reopen(); expect(await f.runtime.submit(input)).toEqual(one); expect(calls).toBe(1);
});
it('pins the effective agent revision and model when its portable definition changes',async()=>{
  const f=await fixture();
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await writeFile(f.path,(await readFile(f.path,'utf8')).replace('test-model','different-model'));
  await f.reopen(); const snap=await f.runtime.snapshot(s.id);
  expect(snap.session).toEqual(s); expect(snap.session.model.modelId).toBe('test-model');
  expect(await f.runtime.createSession({requestId:'create',agentId:'agent-ada'})).toEqual(s);
});
it('preserves a missing-credential submission as blocked and dispatches it after credentials return',async()=>{
  const f=await fixture();
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  f.models.deleteProvider('scripted');
  const input={sessionId:s.id,requestId:'submit',text:'Hello'};
  const pending=await f.runtime.submit(input);
  expect((await f.runtime.snapshot(s.id)).blockedReason).toBe('missing_provider');
  f.models.setProvider(f.faux.provider); f.faux.setResponses([fauxAssistantMessage('Hello')]);
  await f.reopen(); expect(await f.runtime.submit(input)).toEqual(pending);
  expect((await settled(f.runtime,s.id)).status).toBe('completed');
});
it('records an absent project binding as blocked without running the model',async()=>{
  const f=await fixture();
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada',projectId:'unbound'});
  expect((await f.runtime.snapshot(s.id)).blockedReason).toBe('missing_workspace');
  expect(f.faux.state.callCount).toBe(0);
});
it('keeps one agent independent across two instances',async()=>{
  const a=await fixture(); const b=await fixture();
  const input={requestId:'same',agentId:'agent-ada'};
  const sa=await a.runtime.createSession(input); const sb=await b.runtime.createSession(input);
  expect(sa.id).not.toBe(sb.id); expect(sa.instanceId).not.toBe(sb.instanceId);
});
it('recovers a lost Pi admission receipt without duplicating the user entry',async()=>{
  const f=await fixture(); f.faux.setResponses([fauxAssistantMessage('Receipt durable')]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  const original=f.ctx.store.transact; let fail=true;
  f.ctx.store.transact=fn=>original(tx=>fn({...tx,put(kind,id,value){
    if(fail && kind==='runtime-submission' && (value as {piId?:number}).piId){fail=false;throw new Error('after-pi-admission-before-local-receipt');}
    tx.put(kind,id,value);
  }}));
  const input={sessionId:s.id,requestId:'durable',text:'One input'};
  await expect(f.runtime.submit(input)).rejects.toThrow('after-pi-admission-before-local-receipt');
  expect(await f.ctx.store.list('runtime-outbox')).toHaveLength(1);
  await f.reopen(); const receipt=await f.runtime.submit(input);
  expect(await f.runtime.submit(input)).toEqual(receipt);
  const snap=await settled(f.runtime,s.id);
  expect(snap.messages.filter(m=>m.kind==='user')).toHaveLength(1);
  expect(await f.ctx.store.list('runtime-outbox')).toHaveLength(0);
});
it('recovers the atomic Pi conversation registry when its local mapping receipt is lost',async()=>{
  const f=await fixture();const original=f.ctx.store.transact;let fail=true;
  f.ctx.store.transact=fn=>original(tx=>fn({...tx,put(kind,id,value){
    if(fail && kind==='runtime-session' && (value as {conversationId?:number}).conversationId){fail=false;throw new Error('lost registry receipt');}
    tx.put(kind,id,value);
  }}));
  const input={requestId:'create',agentId:'agent-ada'};
  await expect(f.runtime.createSession(input)).rejects.toThrow('lost registry receipt');
  await f.reopen(); const s=await f.runtime.createSession(input);
  expect((await f.runtime.snapshot(s.id)).session.id).toBe(s.id);
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(f.ctx.stateDir,'pi.sqlite'),{readOnly:true});
  try {expect(db.prepare('SELECT count(*) AS n FROM conversations').get()?.n).toBe(1);}finally{db.close();}
});
it('blocks uncertain non-idempotent nested effects after reopening',async()=>{
  let calls=0;let started!:()=>void;const active=new Promise<void>(r=>started=r);
  const effect=defineTool({name:'uncertain',description:'An external effect',parameters:Type.Object({}),replay:'unsafe',async execute(_args,_api,c){
    calls++;started();await new Promise<void>((resolve,reject)=>{c.abortSignal?.addEventListener('abort',()=>reject(new Error('interrupted')),{once:true});});return {output:[]};
  }});
  const f=await fixture([defineExtension({name:'uncertain-fixture',tools:[effect]})]);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.uncertain({}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Must not run')]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});await active;
  await f.reopen();
  expect((await f.runtime.snapshot(s.id)).blockedReason).toBe('uncertain_tool_outcome');
  expect(calls).toBe(1);expect(f.faux.state.callCount).toBe(1);
});
it('continues a real CodeMode journal after close without rerunning its completed nested call',async()=>{
  let completed=0;let waiting!:()=>void;const active=new Promise<void>(r=>waiting=r);let first=true;
  const done=defineTool({name:'once',description:'Complete once',parameters:Type.Object({}),replay:'unsafe',async execute(){completed++;return {output:[{type:'text',text:'done'}]};}});
  const wait=defineTool({name:'pause',description:'Wait safely',parameters:Type.Object({}),replay:'safe',async execute(_a,_api,c){
    if(first){first=false;waiting();await new Promise<void>((_resolve,reject)=>c.abortSignal?.addEventListener('abort',()=>reject(new Error('closing')),{once:true}));}
    return {output:[{type:'text',text:'resumed'}]};
  }});
  const f=await fixture([defineExtension({name:'continuation',tools:[done,wait]})]);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.once({})); text(await tools.pause({}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Continued')]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});await active;await f.reopen();
  const snap=await settled(f.runtime,s.id);expect(snap.status).toBe('completed');expect(completed).toBe(1);
  expect(JSON.stringify(snap.tools)).toContain('resumed');
});
it('reports model failures instead of presenting an error response as completed',async()=>{
  const f=await fixture();f.faux.setResponses([fauxAssistantMessage('No answer',{stopReason:'error',errorMessage:'scripted failure'})]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});
  expect((await settled(f.runtime,s.id)).status).toBe('failed');
});
it('preserves an active Pi request while its provider is absent and cancels its gate cleanly',async()=>{
  let started!:()=>void;const active=new Promise<void>(r=>started=r);
  const f=await fixture();f.faux.setResponses([async(_request,options)=>{
    started();await new Promise<void>((_r,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('closing')),{once:true}));
    return fauxAssistantMessage('unused');
  }]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});await active;
  f.models.deleteProvider('scripted');await f.reopen();
  expect((await f.runtime.snapshot(s.id)).blockedReason).toBe('missing_provider');
  await f.runtime.cancel(s.id);expect((await f.runtime.snapshot(s.id)).status).toBe('cancelled');
});
it('offers a local session CLI with stable creation and status',async()=>{
  const f=await fixture();const {openProviders}=await import('../../src/runtime/providers.js');const model=(await openProviders(f.ctx.stateDir)).getModels().find(m=>m.provider==='openai')!;const c=await openVault(f.ctx).read('agents/ada.md');await openVault(f.ctx).propose({id:'cli-known-model',path:c.path,expectedRevision:c.revision,actor:'fixture',content:{metadata:{lorecrew:{...c.metadata.lorecrew as object,model:{provider:model.provider,modelId:model.id}}}}});await f.runtime.close();await f.ctx.close();
  const {runCli}=await import('../../src/cli.js');
  const created=await runCli(['session','create','--state-dir',f.ctx.stateDir,'--agent','agent-ada','--request-id','cli']);
  expect(created.agentId).toBe('agent-ada');
  const status=await runCli(['session','status','--state-dir',f.ctx.stateDir,'--id',String(created.id)]);
  // Read-only status must not rearm the context stopped by the create command.
  expect(status.blockedReason).toBe('context_stopped');
  expect((status.session as {id:string}).id).toBe(created.id);expect(f.faux.state.callCount).toBe(0);
});
it('blocks an unconfigured provider credential without calling the model',async()=>{
  const f=await fixture();f.models.setProvider({...f.faux.provider,auth:{apiKey:{name:'missing',resolve:async()=>undefined}}});
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});
  expect((await f.runtime.snapshot(s.id)).blockedReason).toBe('missing_credential');expect(f.faux.state.callCount).toBe(0);
});
it('treats equivalent session requests as the same request regardless of object field order',async()=>{
  const f=await fixture();const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  expect(await f.runtime.createSession({agentId:'agent-ada',requestId:'create'})).toEqual(s);
});
it('parks a pending safe tool when its extension is missing and resumes it when restored',async()=>{
  let first=true;let started!:()=>void;const active=new Promise<void>(r=>started=r);
  const extension=defineExtension({name:'optional-plugin',tools:[defineTool({name:'optional',description:'Plugin tool',parameters:Type.Object({}),replay:'safe',async execute(_a,_api,c){
    if(first){first=false;started();await new Promise<void>((_r,reject)=>c.abortSignal?.addEventListener('abort',()=>reject(new Error('closed')),{once:true}));}
    return {output:[{type:'text',text:'restored plugin'}]};
  }})]});
  const extensions=[extension];const f=await fixture(extensions);
  f.faux.setResponses([fauxAssistantMessage(fauxToolCall('optional',{}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
  const s=await f.runtime.createSession({requestId:'create',agentId:'agent-ada'});
  await f.runtime.submit({sessionId:s.id,requestId:'run',text:'Run'});await active;
  extensions.splice(0);await f.reopen();
  expect((await f.runtime.snapshot(s.id)).blockedReason).toBe('missing_extension');
  expect(f.faux.state.callCount).toBe(1);
  extensions.push(extension);await f.reopen();
  const snap=await settled(f.runtime,s.id);expect(snap.status).toBe('completed');expect(JSON.stringify(snap.tools)).toContain('restored plugin');
});
it('provides stable public history cursors without provider reasoning or envelopes',async()=>{
  const f=await fixture();f.faux.setResponses([fauxAssistantMessage([{type:'thinking',thinking:'PROVIDER_PRIVATE_REASONING',thinkingSignature:'PRIVATE_SIGNATURE'},{type:'text',text:'Visible answer'}])]);
  const session=await f.runtime.createSession({requestId:'public-history',agentId:'agent-ada'});await f.runtime.submit({sessionId:session.id,requestId:'question',text:'Visible question'});await settled(f.runtime,session.id);
  const history=await f.runtime.history(session.id);expect(history).toHaveLength(2);expect(JSON.stringify(history)).toContain('Visible answer');expect(JSON.stringify(history)).not.toContain('PROVIDER_PRIVATE_REASONING');expect(JSON.stringify(history)).not.toContain('PRIVATE_SIGNATURE');expect(JSON.stringify(history)).not.toContain('stopReason');
  await f.reopen();expect(await f.runtime.history(session.id,history[0]!.id)).toEqual([history[1]]);await expect(f.runtime.history(session.id,'unknown')).rejects.toMatchObject({code:'INVALID_CURSOR'});
});
it('repairs a missed cross-store observation marker at restart without losing late history',async()=>{
 const {createSessionSnapshotSource,startEventReconciliation}=await import('../../src/api/events.js');const {publicSnapshot}=await import('../../src/runtime/public-history.js');const f=await fixture();const session=await f.runtime.createSession({requestId:'lost-observation',agentId:'agent-ada'});let monitor=startEventReconciliation(f.ctx,createSessionSnapshotSource(f.ctx,f.runtime,publicSnapshot));await monitor.reconcile();const old=await f.ctx.store.read('session-source',session.id);f.faux.setResponses([fauxAssistantMessage('Durable late arrival')]);await f.runtime.submit({sessionId:session.id,requestId:'late-observation',text:'Late arrival'});await settled(f.runtime,session.id);await monitor.close();await f.ctx.store.transact(tx=>tx.put('session-source',session.id,old));await f.reopen();monitor=startEventReconciliation(f.ctx,createSessionSnapshotSource(f.ctx,f.runtime,publicSnapshot));cleanup.push(monitor.close);await monitor.reconcile();expect(JSON.stringify(await f.ctx.store.read('api-session-snapshot',session.id))).toContain('Durable late arrival');expect((await f.runtime.history(session.id)).filter(entry=>entry.kind==='assistant')).toHaveLength(1);
});
it('recovers a legacy report for its return session without rescanning unrelated tasks',async()=>{
 const {controlHistory}=await import('../../src/runtime/public-history.js');const f=await fixture();const session=await f.runtime.createSession({requestId:'legacy-return',agentId:'agent-ada'});await f.ctx.store.transact(tx=>{tx.put('team-task','legacy-child',{id:'legacy-child',executingSessionId:'old-child-session',returnSessionId:session.id,state:'completed'});tx.put('team-report','legacy-report',{taskId:'legacy-child',requestId:'legacy-report',summary:'Recovered return report'});});const history=await controlHistory(f.ctx,session.id);expect(history.entries.some(entry=>entry.id==='team:report:legacy-child:legacy-report')).toBe(true);expect(JSON.stringify(history.entries)).toContain('recovered; original record time unavailable');
});

it('reads a completed ordinary command exactly after a stopped offline reopen without reviving its context',async()=>{
 const f=await fixture();f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.bash({command:"pwd"}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Actual command completed')]);
 const session=await f.runtime.createSession({requestId:'cold-command-history',agentId:'agent-ada'}),input={sessionId:session.id,requestId:'cold-command-message',text:'Run the actual local command'};await f.runtime.submit(input);const completed=await settled(f.runtime,session.id);expect(completed.status).toBe('completed');expect(f.faux.state.callCount).toBe(2);
 await f.runtime.close();const record=(await f.ctx.store.read<import('../../src/runtime/types.js').SessionRecord>('runtime-session',session.id))!,context=await f.ctx.store.read('execution-context',record.executionContextId!),fence=await f.ctx.store.read('execution-context-fence',record.executionContextId!),processes=await f.ctx.store.list('host-process');expect(context).toMatchObject({state:'stopped'});expect(processes).toHaveLength(1);
 await f.reopen(false);expect(await f.runtime.snapshot(session.id)).toEqual(completed);await f.runtime.submit(input);expect(await f.runtime.snapshot(session.id)).toEqual(completed);expect(f.faux.state.callCount).toBe(2);expect(await f.ctx.store.read('execution-context',record.executionContextId!)).toEqual(context);expect(await f.ctx.store.read('execution-context-fence',record.executionContextId!)).toEqual(fence);expect(await f.ctx.store.list('host-process')).toEqual(processes);
 f.faux.setResponses([fauxAssistantMessage('Fresh explicit next message')]);await f.runtime.submit({sessionId:session.id,requestId:'fresh-deliberate-message',text:'A new deliberate message'});expect((await settled(f.runtime,session.id)).status).toBe('completed');expect(f.faux.state.callCount).toBe(3);const next=(await f.ctx.store.read<import('../../src/runtime/types.js').SessionRecord>('runtime-session',session.id))!;expect(next.executionContextId).not.toBe(record.executionContextId);expect(await f.ctx.store.read('execution-context',record.executionContextId!)).toEqual(context);expect(await f.ctx.store.read('execution-context-fence',record.executionContextId!)).toEqual(fence);
},20000);
