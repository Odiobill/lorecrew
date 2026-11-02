import {gitProject} from '../helpers/git-project.js';
import { expect, it } from 'vitest';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { gitFleet } from '../helpers/git-fleet.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { handoffProject } from '../../src/projects/handoff.js';
import { bindProject } from '../../src/projects/bindings.js';
import { openInstance } from '../../src/instance/open.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { openVault } from '../../src/vault/write.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { scriptedProvider, fauxAssistantMessage } from '../helpers/scripted-provider.js';
import { createApi } from '../../src/api/app.js';
import { openBrowserSessions } from '../../src/auth/sessions.js';
import { openTokens } from '../../src/auth/tokens.js';
import { openVaultSync } from '../../src/sync/service.js';

it('combines disconnected ownership, admission SIGKILL, unrelated local work, stale snapshots and lost handoff acknowledgment',async()=>{
  const f=await gitFleet();let a=f.a.ctx;const b=f.b.ctx;const closes:Array<()=>Promise<void>>=[];
  try {
    await initFleet(a,f.a.git,f.remote);
    for(const ctx of [a,b]){
      await cp('tests/fixtures/vault/agents',join(ctx.vaultDir,'agents'),{recursive:true});await cp('tests/fixtures/vault/groups',join(ctx.vaultDir,'groups'),{recursive:true});
      const path=join(ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
    }
    let ownerA=openOwnership(a,f.a.git,f.remote);const ownerB=openOwnership(b,f.b.git,f.remote);
    await Promise.all([ownerA.claim({id:'engine',repositoryKey:'fork:engine',title:'Engine'},'claim-a'),ownerB.claim({id:'mail',repositoryKey:'fork:mail',title:'Mail'},'claim-b')]);
    await bindProject(a,{projectId:'engine',path:await gitProject(join(f.root,a.instanceId+'-code'))});await bindProject(b,{projectId:'mail',path:await gitProject(join(f.root,b.instanceId+'-code'))});
    const provider=scriptedProvider();provider.faux.setResponses([fauxAssistantMessage('Mail work continued during outage')]);
    const vaultB=openVault(b),workspacesB=new WorkspaceManager(b);
    const runtimeB=await openRuntime({ctx:b,vault:vaultB,ownership:ownerB,workspaces:workspacesB,supervisor:new ProcessSupervisor(b),models:provider.models});closes.push(()=>runtimeB.close());
    const mail=await runtimeB.createSession({requestId:'mail-session',agentId:'agent-ada',projectId:'mail'});
    const vaultA=openVault(a);
    const initialProvider=scriptedProvider();initialProvider.faux.setResponses([fauxAssistantMessage('Engine started')]);
    const initialRuntime=await openRuntime({ctx:a,vault:vaultA,ownership:ownerA,workspaces:new WorkspaceManager(a),supervisor:new ProcessSupervisor(a),models:initialProvider.models});
    const engineTask=await initialRuntime.team.createTask({requestId:'engine-task',projectId:'engine',leadAgentId:'agent-ada',objective:'Inspect engine'});
    await expect.poll(async()=>(await initialRuntime.snapshot(engineTask.executingSessionId)).status).toBe('completed');
    const syncA=await openVaultSync({ctx:a,vault:vaultA,runtime:initialRuntime,git:f.a.git,publicationMs:600000});await syncA.flush();await syncA.close();await initialRuntime.close();
    const syncB=await openVaultSync({ctx:b,vault:vaultB,runtime:runtimeB,git:f.b.git,publicationMs:600000,retryMs:600000});closes.push(()=>syncB.close());await syncB.flush();
    await f.disconnect();
    await expect(ownerA.claim({id:'offline-new',repositoryKey:'fork:new',title:'New'},'offline')).rejects.toMatchObject({code:'ASSIGNMENT_UNCONFIRMED'});
    await a.close();
    const killed=new Promise<string|null>((done,reject)=>{
      const child=spawn(process.execPath,['--experimental-transform-types',resolve('tests/fixtures/learning-transfer/fleet-crash.mjs'),a.stateDir,a.vaultDir],{stdio:'ignore'});child.once('error',reject);child.once('close',(_code,signal)=>done(signal));
    });
    await runtimeB.submit({sessionId:mail.id,requestId:'mail-submit',text:'Continue mail work'});
    expect(await killed).toBe('SIGKILL');await expect.poll(async()=>(await runtimeB.snapshot(mail.id)).status).toBe('completed');
    a=await openInstance({stateDir:a.stateDir,vaultDir:a.vaultDir});ownerA=openOwnership(a,f.a.git,f.remote);
    const resumed=scriptedProvider();resumed.faux.setResponses([fauxAssistantMessage('Recovered once')]);
    const runtimeA=await openRuntime({ctx:a,vault:openVault(a),ownership:ownerA,workspaces:new WorkspaceManager(a),supervisor:new ProcessSupervisor(a),models:resumed.models});
    const recovered=await runtimeA.createSession({requestId:'crash-session',agentId:'agent-ada',projectId:'engine'});
    const request={sessionId:recovered.id,requestId:'crash-submit',text:'Continue the admitted engine task'};
    expect(await runtimeA.submit(request)).toEqual(await runtimeA.submit(request));await expect.poll(async()=>(await runtimeA.snapshot(recovered.id)).status).toBe('completed');
    expect((await runtimeA.snapshot(recovered.id)).messages.filter(m=>m.kind==='user')).toHaveLength(1);
    await expect(ownerA.assertOwner('engine',1)).resolves.toBeUndefined();
    const api=createApi({ctx:b,runtime:runtimeB,team:runtimeB.team,vault:vaultB,ownership:ownerB,workspaces:workspacesB,auth:openBrowserSessions(b),publicOrigin:'http://localhost'});
    const token=await openTokens(b).create('acceptance',['read','write']);const headers={Authorization:`Bearer ${token.token}`};
    const stale=await (await api.request('/api/v1/remote/tasks',{headers})).json();expect(stale.items).toContainEqual(expect.objectContaining({sessionId:engineTask.executingSessionId,state:'running'}));expect(stale.lastFetchAt).toEqual(expect.any(String));
    const cancel=await api.request(`/api/v1/sessions/${engineTask.executingSessionId}/cancel`,{method:'POST',headers:{...headers,'Content-Type':'application/json','Idempotency-Key':'no-remote'},body:'{}'});expect(cancel.status).toBe(404);
    await f.reconnect();f.a.loseNextPushAck(true);
    await expect(handoffProject({ownership:ownerA,probe:runtimeA,projectId:'engine',expectedGeneration:1,targetInstanceId:b.instanceId,requestId:'move'})).rejects.toBeDefined();
    await runtimeA.close();await a.close();a=await openInstance({stateDir:a.stateDir,vaultDir:a.vaultDir});ownerA=openOwnership(a,f.a.git,f.remote);
    await expect(ownerA.assertOwner('engine',1)).rejects.toMatchObject({code:'OWNER_REVOKED'});
    await f.reconnect();await bindProject(b,{projectId:'engine',path:await gitProject(join(f.root,b.instanceId+'-engine-code'))});expect((await ownerB.acceptGrant('engine')).generation).toBe(2);
    const grant=await handoffProject({ownership:ownerA,probe:{stopAndProve:async()=>({quiescent:false})},projectId:'engine',expectedGeneration:1,targetInstanceId:b.instanceId,requestId:'move'});expect(grant.generation).toBe(2);
    await expect(ownerB.assertOwner('mail',1)).resolves.toBeUndefined();
  }finally{for(const close of closes.reverse())await close();await a.close();await f.cleanup();}
},60_000);
