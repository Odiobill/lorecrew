import {afterEach,expect,it} from 'vitest';
import {join,dirname} from 'node:path';
import {localTeam} from '../helpers/local-team.js';
import {fauxAssistantMessage,fauxToolCall} from '../helpers/scripted-provider.js';
import {openSharing} from '../../src/projects/sharing.js';
import {openConfiguredOwnership,openConfiguredWorkloadOwnership} from '../../src/projects/configured-ownership.js';
import type {Occurrence,Schedule} from '../../src/schedules/types.js';
import type {AuthorityBinding} from '../../src/repositories/types.js';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
const at='2026-10-24T00:00:00.000Z';
const definition=(ownerId:string,project=false):Schedule=>({id:'native-schedule',revision:'native-v1',ownerId,agentId:'agent-ada',...(project?{projectId:'project'}:{}),cron:'0 0 * * *',timeZone:'UTC',instructions:'Run a native authority occurrence',enabled:true,overlap:'skip',missed:'coalesce',effectiveFrom:at});

async function promoteNative(f:Awaited<ReturnType<typeof localTeam>>){const remote=join(dirname(f.ctx.stateDir),'schedule-shared.git');expect((await f.git.run(f.ctx.vaultDir,['init','--bare','--template=','--initial-branch=main',remote])).exitCode).toBe(0);for(const key of ['receive.denyNonFastForwards','receive.denyDeletes'])expect((await f.git.run(remote,['config',key,'true'])).exitCode).toBe(0);expect((await f.git.run(f.ctx.vaultDir,['remote','add','origin',remote])).exitCode).toBe(0);await f.sync.flush();const before=(await f.ctx.store.read<AuthorityBinding>('authority-binding','current'))!,repositories=(await import('../../src/repositories/service.js')).openRepositories({state:f.ctx,git:f.git}),target=(await repositories.inspect(f.ctx.vaultDir)).target!;await openSharing({ctx:f.ctx,vault:f.vault,repositories,ownership:openConfiguredOwnership(f.ctx,f.git),workloads:openConfiguredWorkloadOwnership(f.ctx,f.git),proof:f.runtime}).enable({expectedDomain:before.domainId,expectedEpoch:before.epoch,target,protectionAcknowledged:true},'native-schedule-promotion');return before;}
it.each([false,true])('admits and runs an actual native scheduled occurrence with its confirmed domain (project: %s)',async project=>{
 const f=await localTeam();closes.push(f.close);f.ctx.clock.now=()=>Date.parse(at);const binding=(await f.ctx.store.read<AuthorityBinding>('authority-binding','current'))!,authority={domainId:binding.domainId,epoch:binding.epoch};
 f.faux.setResponses(project?[fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.team_report({state:"completed",outcome:{summary:"Native scheduled root completed"}}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Native schedule completed')]:[fauxAssistantMessage('Native schedule completed')]);
 await f.schedules.save(definition(f.ctx.instanceId,project),null);await f.schedules.tick(at);const occurrences=await f.ctx.store.list<Occurrence&{authority?:unknown}>('schedule-occurrence');expect(occurrences).toHaveLength(1);const occurrence=occurrences[0]!;expect(occurrence.authority).toEqual(authority);expect(occurrence.sessionId).toBeTruthy();await expect.poll(async()=>(await f.runtime.snapshot(occurrence.sessionId!)).status).toBe('completed');expect(await f.ctx.store.read('runtime-session',occurrence.sessionId!)).toMatchObject({authority});if(project)expect(await f.ctx.store.read('team-task',occurrence.taskId!)).toMatchObject({authority});expect(f.faux.state.callCount).toBeGreaterThan(0);
},20000);
it('retains but never dispatches an actual pre-promotion schedule outbox under rebound grants',async()=>{
 const f=await localTeam();closes.push(f.close);f.ctx.clock.now=()=>Date.parse(at);await f.schedules.save(definition(f.ctx.instanceId),null);const create=f.runtime.createSession;f.runtime.createSession=async()=>{throw Error('Controlled unavailable dispatch before any session effect');};try{await expect(f.schedules.tick(at)).rejects.toThrow('Controlled unavailable dispatch');}finally{f.runtime.createSession=create;}
 const old=(await f.ctx.store.list<Occurrence>('schedule-occurrence'))[0]!;expect(old.state).toBe('pending');expect(await f.ctx.store.read('schedule-outbox',old.id)).toBeDefined();expect(f.faux.state.callCount).toBe(0);
 const before=await promoteNative(f);
 expect(await f.ctx.store.read('authority-binding','current')).toMatchObject({epoch:before.epoch+1,mode:'shared'});await expect(f.schedules.tick(at)).rejects.toMatchObject({code:'AUTHORITY_RETIRED'});expect(await f.ctx.store.read('schedule-occurrence',old.id)).toEqual(old);expect(await f.ctx.store.read('schedule-outbox',old.id)).toBeDefined();expect(await f.ctx.store.list('runtime-session')).toEqual([]);expect(f.faux.state.callCount).toBe(0);
},30000);

it.each([false,true])('does not borrow a promoted epoch while an admitted schedule is entering actual dispatch (project: %s)',async project=>{
 const f=await localTeam();closes.push(f.close);f.ctx.clock.now=()=>Date.parse(at);await f.schedules.save(definition(f.ctx.instanceId,project),null);let promoted=false;
 const createSession=f.runtime.createSession,createTask=f.runtime.team.createTask;
 if(project)f.runtime.team.createTask=async(input,expected)=>{await promoteNative(f);promoted=true;return createTask(input,expected);};
 else f.runtime.createSession=async(input,expected)=>{await promoteNative(f);promoted=true;return createSession(input,expected);};
 try{await expect(f.schedules.tick(at)).rejects.toMatchObject({code:'AUTHORITY_RETIRED'});}finally{f.runtime.createSession=createSession;f.runtime.team.createTask=createTask;}
 expect(promoted).toBe(true);expect(await f.ctx.store.read('authority-binding','current')).toMatchObject({mode:'shared',epoch:2});expect(await f.ctx.store.list('runtime-session')).toEqual([]);expect(await f.ctx.store.list('team-task')).toEqual([]);expect(f.faux.state.callCount).toBe(0);expect((await f.ctx.store.list<Occurrence>('schedule-occurrence'))[0]).toMatchObject({state:'pending'});
},30000);
it.each(['low','alien'])('uses or rejects the actual scheduled agent thinking choice %s',async level=>{
 const f=await localTeam();closes.push(f.close);f.ctx.clock.now=()=>Date.parse(at);const c=await f.vault.read('agents/ada.md'),agent=c.metadata.lorecrew as any;await f.vault.propose({id:'thinking-schedule',path:c.path,expectedRevision:c.revision,actor:'fixture',content:{metadata:{lorecrew:{...agent,model:{...agent.model,thinkingLevel:level}}}}});
 const seen:unknown[]=[];f.faux.setResponses([(_c,options)=>{seen.push(options?.reasoning);return fauxAssistantMessage('Scheduled thinking');}]);await f.schedules.save(definition(f.ctx.instanceId),null);
 if(level==='alien'){await expect(f.schedules.tick(at)).rejects.toMatchObject({code:'UNSUPPORTED_THINKING_LEVEL'});expect(seen).toEqual([]);expect(await f.ctx.store.list('runtime-session')).toEqual([]);}else{await f.schedules.tick(at);await expect.poll(()=>seen).toEqual(['low']);}
},20000);
