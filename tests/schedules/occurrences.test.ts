import {gitProject} from '../helpers/git-project.js';
import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { openWorkloadOwnership } from '../../src/projects/workload-grants.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { openVault } from '../../src/vault/write.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { bindProject } from '../../src/projects/bindings.js';
import { scriptedProvider, fauxAssistantMessage } from '../helpers/scripted-provider.js';
import { nextOccurrence } from '../../src/schedules/recurrence.js';
import { openSchedules } from '../../src/schedules/service.js';
import type { Schedule, Occurrence } from '../../src/schedules/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const definition=(ownerId:string,patch:Partial<Schedule>={}):Schedule=>({id:'daily',revision:'v1',ownerId,agentId:'agent-ada',cron:'30 2 * * *',timeZone:'Europe/Rome',instructions:'Review the shared knowledge.',enabled:true,overlap:'skip',missed:'coalesce',effectiveFrom:'2026-10-24T00:00:00.000Z',...patch});
async function fixture(){
 const fleet=await gitFleet();cleanup.push(fleet.cleanup);await initFleet(fleet.a.ctx,fleet.a.git,fleet.remote);
 async function device(d:typeof fleet.a){
  const {ctx,git}=d;await cp('tests/fixtures/vault',ctx.vaultDir,{recursive:true});
  const path=join(ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
  let now=Date.parse('2026-10-24T00:00:00Z');ctx.clock.now=()=>now;
  const provider=scriptedProvider();const vault=openVault(ctx);const ownership=openOwnership(ctx,git,fleet.remote),workloads=openWorkloadOwnership(ctx,git,fleet.remote);
  const options={ctx,vault,ownership,workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,workloadOwnership:workloads};
  let runtime=await openRuntime(options);let schedules=openSchedules({ctx,vault,runtime,ownership,workloads});
  cleanup.push(async()=>{await schedules.close();await runtime.close();});
  return {ctx,vault,ownership,workloads,...provider,get runtime(){return runtime;},get schedules(){return schedules;},setNow(value:string){now=Date.parse(value);},async tick(value:string){now=Date.parse(value);await schedules.tick(value);},occurrences:()=>ctx.store.list<Occurrence>('schedule-occurrence'),async reopen(){await schedules.close();await runtime.close();runtime=await openRuntime(options);schedules=openSchedules({ctx,vault,runtime,ownership,workloads});},async save(patch:Partial<Schedule>={}){await schedules.save(definition(ctx.instanceId,patch));}};
 }
 return {...fleet,one:await device(fleet.a),two:await device(fleet.b)};
}
async function done(f:Awaited<ReturnType<typeof fixture>>['one']){const o=(await f.occurrences()).at(-1)!;await expect.poll(async()=>(await f.runtime.snapshot(o.sessionId!)).status).toBe('completed');}
it('skips the missing Rome 02:30 and runs the fall-back wall time once, even starting inside its second hour',()=>{
 const s=definition('owner');
 expect(nextOccurrence(s,'2026-03-28T02:00:00Z')?.utc).toBe('2026-03-30T00:30:00Z');
 const first=nextOccurrence(s,'2026-10-24T01:00:00Z')!;expect(first.utc).toBe('2026-10-25T00:30:00Z');
 expect(nextOccurrence(s,first.utc)?.utc).toBe('2026-10-26T01:30:00Z');
 expect(nextOccurrence(s,'2026-10-25T01:00:00Z')?.utc).toBe('2026-10-26T01:30:00Z');
});
it('rejects invalid zones, invalid expressions, seconds, and aliases',()=>{
 for(const patch of [{timeZone:'Mars/Olympus'},{timeZone:'+01:00'},{timeZone:undefined as unknown as string},{cron:'99 2 * * *'},{cron:'0 30 2 * * *'},{cron:'@daily'}])expect(()=>nextOccurrence(definition('owner',patch),'2026-01-01T00:00:00Z')).toThrow();
});
it('stores readable definitions and admits a repeated local time only once across edit, restart, and backward clocks',async()=>{
 const {one:f}=await fixture();f.faux.setResponses([fauxAssistantMessage('Done')]);await f.save();
 expect((await f.vault.read('schedules/daily.md')).metadata.type).toBe('Schedule');
 await f.tick('2026-10-25T00:30:00Z');await done(f);await f.reopen();
 await f.save({revision:'v2',instructions:'Changed instructions'});
 await f.tick('2026-10-24T00:30:00Z');await f.tick('2026-10-25T01:30:00Z');
 expect(await f.occurrences()).toHaveLength(1);expect(f.faux.state.callCount).toBe(1);
});
it('replays a lost dispatch receipt through the same Pi request and resumes running before considering catch-up',async()=>{
 const {one:f}=await fixture();let release!:()=>void;const paused=new Promise<void>(r=>release=r);
 f.faux.setResponses([async(_request,options)=>{await Promise.race([paused,new Promise<void>((_,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('restart')),{once:true}))]);return fauxAssistantMessage('Done');},fauxAssistantMessage('Resumed'),fauxAssistantMessage('Catch-up')]);
 await f.save();const transact=f.ctx.store.transact;let fail=true;
 f.ctx.store.transact=fn=>transact(tx=>fn({...tx,put(kind,id,value){if(fail&&kind==='schedule-occurrence'&&(value as Occurrence).state==='running'){fail=false;throw new Error('lost schedule receipt');}tx.put(kind,id,value);}}));
 await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toThrow('lost schedule receipt');
 expect(await f.ctx.store.list('schedule-outbox')).toHaveLength(1);
 await f.tick('2026-10-27T12:00:00Z');expect(await f.occurrences()).toHaveLength(1);
 await f.reopen();release();await f.tick('2026-10-27T12:00:00Z');
 const first=(await f.occurrences())[0]!;await expect.poll(async()=>(await f.runtime.snapshot(first.sessionId!)).status).toBe('completed');
 expect((await f.runtime.history(first.sessionId!)).filter(e=>e.kind==='user')).toHaveLength(1);
 await f.tick('2026-10-27T12:00:00Z');expect(await f.occurrences()).toHaveLength(2);
 const catchup=(await f.occurrences()).find(o=>o.id!==first.id)!;expect(catchup.skipped?.count).toBe(2);expect(catchup.skipped?.fromUtc).toBe('2026-10-25T00:30:00Z');
});
it('coalesces downtime into one run with skipped range and disabling preserves admitted work',async()=>{
 const {one:f}=await fixture();f.faux.setResponses([fauxAssistantMessage('Done')]);await f.save();
 await f.tick('2026-10-27T12:00:00Z');const [o]=await f.occurrences();expect(o?.utc).toBe('2026-10-27T01:30:00Z');expect(o?.skipped?.count).toBe(3);
 await f.schedules.disable('daily');await done(f);await f.tick('2026-10-30T12:00:00Z');expect(await f.occurrences()).toHaveLength(1);
 await f.save({revision:'v3',enabled:true});await f.tick('2026-10-30T12:00:00Z');expect(await f.occurrences()).toHaveLength(1);
});
it('keeps imported definitions read-only and requires an online grant for creation but runs existing grants offline',async()=>{
 const f=await fixture();await f.one.save();await cp(join(f.one.ctx.vaultDir,'schedules'),join(f.two.ctx.vaultDir,'schedules'),{recursive:true});
 await expect(f.two.schedules.save(definition(f.two.ctx.instanceId,{revision:'stolen'}))).rejects.toMatchObject({code:'NOT_OWNER'});
 await expect(f.two.schedules.disable('daily')).rejects.toMatchObject({code:'NOT_OWNER'});await expect(f.two.schedules.transfer('daily',f.two.ctx.instanceId)).rejects.toMatchObject({code:'NOT_OWNER'});
 await f.two.tick('2026-10-25T00:30:00Z');expect(await f.two.occurrences()).toHaveLength(0);
 await f.disconnect();await expect(f.one.save({id:'new'})).rejects.toMatchObject({code:'ASSIGNMENT_UNCONFIRMED'});
 f.one.faux.setResponses([fauxAssistantMessage('Offline')]);await f.one.tick('2026-10-25T00:30:00Z');await done(f.one);
});
it('fences a failed move, requires explicit quiescence, retries receipt loss, and prevents new-owner replay',async()=>{
 const f=await fixture();await f.one.save();f.one.faux.setResponses([fauxAssistantMessage('Done')]);await f.one.tick('2026-10-25T00:30:00Z');await done(f.one);
 const stop=f.one.runtime.stopWorkloadAndProve;f.one.runtime.stopWorkloadAndProve=async()=>({quiescent:false,reason:'uncertain process'});
 await expect(f.one.schedules.transfer('daily',f.two.ctx.instanceId)).rejects.toMatchObject({code:'NOT_QUIESCENT'});
 await f.one.tick('2026-10-26T01:30:00Z');expect(await f.one.occurrences()).toHaveLength(1);
 f.one.runtime.stopWorkloadAndProve=stop;f.a.loseNextPushAck();await f.one.schedules.transfer('daily',f.two.ctx.instanceId);
 await cp(join(f.one.ctx.vaultDir,'schedules'),join(f.two.ctx.vaultDir,'schedules'),{recursive:true});
 await f.two.tick('2026-10-25T01:30:00Z');expect(await f.two.occurrences()).toHaveLength(0);
 f.two.faux.setResponses([fauxAssistantMessage('New owner')]);await f.two.tick('2026-10-27T01:30:00Z');await done(f.two);expect(await f.two.occurrences()).toHaveLength(1);
 await expect(f.one.save({revision:'old owner'})).rejects.toMatchObject({code:'NOT_OWNER'});
});
it('demonstrates two local instances with separate project schedules and drains a project task tree before moving its schedule',async()=>{
 const f=await fixture();
 for(const [d,id] of [[f.one,'project-a'],[f.two,'project-b']] as const){
  const directory=join(f.root,id);await gitProject(directory);await bindProject(d.ctx,{projectId:id,path:directory});await d.ownership.claim({id,repositoryKey:`fork:${id}`,title:id},`claim:${id}`);
  d.faux.setResponses([fauxAssistantMessage('Working')]);await d.save({id,projectId:id});await d.tick('2026-10-24T00:30:00Z');
  const [o]=await d.occurrences();expect(o?.taskId).toBeDefined();expect((await d.runtime.snapshot(o!.sessionId!)).session.projectId).toBe(id);
 }
 const [o]=await f.one.occurrences();const child=await f.one.runtime.team.delegate({requestId:'helper',parentTaskId:o!.taskId!,agentId:'agent-ada',objective:'Inspect',deliverable:'Report',contextPaths:[],dependsOn:[]});
 await f.one.schedules.transfer('project-a',f.two.ctx.instanceId);
 expect((await f.one.runtime.team.getTask(child.id)).state).toBe('cancelled');expect((await f.one.runtime.snapshot(o!.sessionId!)).status).toBe('cancelled');
 await cp(join(f.one.ctx.vaultDir,'schedules','project-a.md'),join(f.two.ctx.vaultDir,'schedules','project-a.md'));
 await f.two.tick('2026-10-25T00:30:00Z');expect((await f.two.occurrences()).filter(o=>o.scheduleId==='project-a')).toHaveLength(0);
 expect(await f.two.ctx.store.read('schedule-status','project-a')).toMatchObject({state:'blocked',reason:'NOT_OWNER'});
});
it('drains a project task whose session-creation receipt was never produced',async()=>{
 const f=await fixture();const d=f.one;const directory=join(f.root,'pending-project');await gitProject(directory);await bindProject(d.ctx,{projectId:'pending-project',path:directory});await d.ownership.claim({id:'pending-project',repositoryKey:'fork:pending',title:'Pending'},'claim');
 await d.save({projectId:'pending-project'});const create=d.runtime.createSession;d.runtime.createSession=async()=>{throw new Error('before session');};
 await expect(d.tick('2026-10-24T00:30:00Z')).rejects.toThrow('before session');expect(await d.ctx.store.list('team-task-outbox')).toHaveLength(1);
 d.runtime.createSession=create;await d.schedules.transfer('daily',f.two.ctx.instanceId);await d.runtime.team.recover();
 expect(await d.ctx.store.list('team-task-outbox')).toHaveLength(0);expect((await d.ctx.store.list<{state:string}>('team-task'))[0]?.state).toBe('cancelled');expect(await d.ctx.store.list('runtime-session')).toHaveLength(0);
});
it('finishes a move after its readable definition was published but its receipt was lost',async()=>{
 const f=await fixture();await f.one.save();const propose=f.one.vault.propose;let fail=true;
 f.one.vault.propose=async(...args)=>{const result=await propose(...args);if(fail){fail=false;throw new Error('lost definition receipt');}return result;};
 await expect(f.one.schedules.transfer('daily',f.two.ctx.instanceId)).rejects.toThrow('lost definition receipt');
 await f.one.schedules.transfer('daily',f.two.ctx.instanceId);expect((await f.one.schedules.list())[0]?.ownerId).toBe(f.two.ctx.instanceId);
 expect(await f.one.ctx.store.read('schedule-move','daily')).toMatchObject({state:'completed'});
});
it('keeps an admitted identity and instructions after an edit and disable, without overlapping ticks',async()=>{
 const {one:f}=await fixture();await f.save();const create=f.runtime.createSession;f.runtime.createSession=async()=>{throw new Error('dispatch offline');};
 await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toThrow('dispatch offline');
 await f.save({revision:'v2',agentId:'agent-lin',instructions:'New instructions',cron:'* * * * *'});await f.schedules.disable('daily');f.runtime.createSession=create;
 f.faux.setResponses([fauxAssistantMessage('Original run')]);await Promise.all([f.tick('2026-10-25T12:00:00Z'),f.tick('2026-10-25T12:00:00Z')]);await done(f);
 const [o]=await f.occurrences();expect(o?.schedule.agentId).toBe('agent-ada');expect(o?.schedule.instructions).toBe('Review the shared knowledge.');expect(o?.schedule.revision).toBe('v1');expect(await f.occurrences()).toHaveLength(1);
 expect((await f.runtime.snapshot(o!.sessionId!)).session.agentId).toBe('agent-ada');
});
it('accepts a confirmed later generation when a schedule returns to a former owner',async()=>{
 const f=await fixture();await f.one.save();await f.one.schedules.transfer('daily',f.two.ctx.instanceId);await cp(join(f.one.ctx.vaultDir,'schedules'),join(f.two.ctx.vaultDir,'schedules'),{recursive:true});
 await f.two.tick('2026-10-24T00:00:00Z');await f.two.schedules.transfer('daily',f.one.ctx.instanceId);await cp(join(f.two.ctx.vaultDir,'schedules'),join(f.one.ctx.vaultDir,'schedules'),{recursive:true});
 await f.disconnect();await f.one.tick('2026-10-25T00:30:00Z');expect(await f.one.occurrences()).toHaveLength(0);
 expect(await f.one.ctx.store.read('schedule-status','daily')).toMatchObject({state:'blocked',reason:'ASSIGNMENT_UNCONFIRMED'});
 await f.reconnect();f.one.faux.setResponses([fauxAssistantMessage('Returned')]);await f.one.tick('2026-10-25T00:30:00Z');expect(await f.one.occurrences()).toHaveLength(1);
});
it('recovers admitted work against its saved scope when an edited project scope becomes fenced',async()=>{
 const {one:f,two}=await fixture();await f.ownership.claim({id:'edited-project',repositoryKey:'fork:edited',title:'Edited project'},'claim');await f.save();
 const create=f.runtime.createSession;f.runtime.createSession=async()=>{throw new Error('before dispatch');};await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toThrow('before dispatch');f.runtime.createSession=create;
 await f.save({revision:'edited',projectId:'edited-project'});await f.ownership.closeAdmission({projectId:'edited-project',expectedGeneration:1,targetInstanceId:two.ctx.instanceId,transitionId:'fence'});
 f.faux.setResponses([fauxAssistantMessage('Recovered original scope')]);await f.tick('2026-10-25T12:00:00Z');
 const [o]=await f.occurrences();expect(o?.sessionId).toBeDefined();await done(f);expect((await f.runtime.snapshot(o!.sessionId!)).session.projectId).toBeUndefined();expect(await f.occurrences()).toHaveLength(1);
});
it('isolates a fenced pending project outbox while a later standalone schedule still dispatches',async()=>{
 const {one:f,two}=await fixture();
 await f.ownership.claim({id:'fenced-project',repositoryKey:'fork:fenced',title:'Fenced project'},'claim');
 await f.save({id:'a-project',projectId:'fenced-project'});
 const create=f.runtime.createSession;f.runtime.createSession=async()=>{throw new Error('before project session');};
 await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toThrow('before project session');f.runtime.createSession=create;
 const [pending]=await f.occurrences();const outbox=await f.ctx.store.list('schedule-outbox');
 expect(pending?.state).toBe('pending');expect(outbox).toEqual([{id:pending!.id,failure:'before project session'}]);
 await f.save({id:'z-independent'});await f.ownership.closeAdmission({projectId:'fenced-project',expectedGeneration:1,targetInstanceId:two.ctx.instanceId,transitionId:'fence'});
 f.faux.setResponses([fauxAssistantMessage('Independent scheduled work')]);
 await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toMatchObject({code:'ADMISSION_CLOSED'});
 const independent=(await f.occurrences()).find(o=>o.scheduleId==='z-independent');expect(independent?.sessionId).toBeDefined();
 await expect.poll(async()=>(await f.runtime.snapshot(independent!.sessionId!)).status).toBe('completed');
 expect((await f.occurrences()).find(o=>o.id===pending!.id)).toEqual(pending);expect(await f.ctx.store.list('schedule-outbox')).toEqual(outbox);
 expect(await f.ctx.store.read('schedule-status','a-project')).toEqual({state:'blocked',reason:'ADMISSION_CLOSED'});
 await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toMatchObject({code:'ADMISSION_CLOSED'});
 expect(await f.occurrences()).toHaveLength(2);expect(f.faux.state.callCount).toBe(1);
});
it('isolates a fresh dispatch failure and replays its original request after independent work completes',async()=>{
 const {one:f}=await fixture();await f.save({id:'a-failing'});await f.save({id:'z-independent'});
 const create=f.runtime.createSession;let fail=true;f.runtime.createSession=async input=>{if(fail&&input.workload?.workloadId==='schedule:a-failing')throw new Error('dispatch unavailable');return create(input);};
 f.faux.setResponses([fauxAssistantMessage('Independent'),fauxAssistantMessage('Recovered')]);
 await expect(f.tick('2026-10-24T00:30:00Z')).rejects.toThrow('dispatch unavailable');
 const admitted=await f.occurrences();const pending=admitted.find(o=>o.scheduleId==='a-failing')!;const independent=admitted.find(o=>o.scheduleId==='z-independent');expect(independent?.sessionId).toBeDefined();
 await expect.poll(async()=>(await f.runtime.snapshot(independent!.sessionId!)).status).toBe('completed');
 expect(await f.ctx.store.read('schedule-status','a-failing')).toEqual({state:'blocked',reason:'dispatch unavailable'});expect(await f.ctx.store.list('schedule-outbox')).toEqual([{id:pending.id,failure:'dispatch unavailable'}]);
 fail=false;await f.tick('2026-10-24T00:30:00Z');const recovered=(await f.occurrences()).find(o=>o.id===pending.id)!;
 expect(recovered.requestId).toBe(pending.requestId);expect(recovered.schedule).toEqual(pending.schedule);await expect.poll(async()=>(await f.runtime.snapshot(recovered.sessionId!)).status).toBe('completed');expect(await f.ctx.store.list('schedule-outbox')).toEqual([]);expect(await f.occurrences()).toHaveLength(2);
});
it('checkpoints long catch-up so other schedules, disable, and restart remain responsive',async()=>{
 const {one:f}=await fixture();f.faux.setResponses([fauxAssistantMessage('Ready')]);await f.save({id:'backlog',cron:'* * * * *',timeZone:'UTC'});await f.save({id:'other',cron:'0 0 * * *',timeZone:'UTC',effectiveFrom:'2026-10-26T00:00:00Z'});
 await f.tick('2026-10-26T00:00:00Z');expect((await f.occurrences()).map(o=>o.scheduleId)).toEqual(['other']);expect(await f.ctx.store.read('schedule-catchup','backlog')).toBeDefined();await f.schedules.disable('other');await f.reopen();
 for(let i=0;i<40&&!(await f.occurrences()).some(o=>o.scheduleId==='backlog');i++)await f.tick('2026-10-26T00:00:00Z');const occurrence=(await f.occurrences()).find(o=>o.scheduleId==='backlog')!;expect(occurrence.skipped).toEqual({fromUtc:'2026-10-24T00:00:00Z',toUtc:'2026-10-25T23:59:00Z',count:2880});expect(occurrence.utc).toBe('2026-10-26T00:00:00Z');
},20000);
it('publishes saved disabled and transferred schedule definitions through the watcher to another clone',async()=>{
 const {openVaultSync}=await import('../../src/sync/service.js');const {realGit}=await import('../helpers/git-fleet.js');const f=await fixture();const sync=await openVaultSync({...f.a,vault:f.one.vault,runtime:f.one.runtime,remote:f.remote,publicationMs:100000});cleanup.push(()=>sync.close());await sync.flush();await f.one.save();await sync.flush();expect((await realGit(f.remote,['show','main:schedules/daily.md'])).stdout).toContain('"enabled": true');await f.one.schedules.disable('daily');await sync.flush();expect((await realGit(f.remote,['show','main:schedules/daily.md'])).stdout).toContain('"enabled": false');await f.one.schedules.transfer('daily',f.two.ctx.instanceId);await sync.flush();expect((await realGit(f.remote,['log','main','--format=%B'])).stdout).toContain(`schedule-owner:${f.one.ctx.instanceId}`);const receiving=await openVaultSync({...f.b,vault:f.two.vault,runtime:f.two.runtime,remote:f.remote,publicationMs:100000});cleanup.push(()=>receiving.close());await receiving.flush();expect((await f.two.schedules.list()).find(s=>s.id==='daily')).toMatchObject({ownerId:f.two.ctx.instanceId,enabled:false});
},20000);
