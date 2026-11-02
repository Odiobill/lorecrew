import { Value } from 'typebox/value';
import { TaskSchema,SessionSnapshotSchema } from '../../src/api/schemas.js';
import { apiError } from '../../src/api/errors.js';
import { openConfiguredOwnership,openConfiguredWorkloadOwnership } from '../../src/projects/configured-ownership.js';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { gitVaultFixture } from './git-vault.js';
import { ensureLocalAuthority } from '../../src/projects/authority-domain.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { bindProject } from '../../src/projects/bindings.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openVault } from '../../src/vault/write.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from './scripted-provider.js';
import { closeApi, createApi } from '../../src/api/app.js';
import { openBrowserSessions } from '../../src/auth/sessions.js';
import { createSessionSnapshotSource, startEventReconciliation } from '../../src/api/events.js';
import { openVaultSync } from '../../src/sync/service.js';
import { openSchedules } from '../../src/schedules/service.js';
import { openWorkloadOwnership } from '../../src/projects/workload-grants.js';
import { publicSnapshot } from '../../src/api/routes.js';
import { openCredentialFile } from '../../src/runtime/provider-credentials.js';
import { scriptedLoginProviders } from './provider-login.js';
import type { Extension } from '@earendil-works/pi-durable';
import { INITIAL_VAULT_INDEX } from '../../src/vault/start.js';

/** Actual Git ownership, worktrees, Pi, Team and HTTP services; only the model is scripted. */
export async function localTeam(options:{historicalThinkingLevel?:string;webAssetsDir?:string;publicHostname?:string;emptyDefinitions?:boolean;noFleet?:boolean;modelIds?:string[];extensions?:Extension[];skillImportTransport?:import('../../src/skills/import/github.js').GitHubReader}={}) {
  const native=await gitVaultFixture();const f={root:native.root,a:{ctx:native.ctx,git:native.git},cleanup:()=>native.close()};
  if(options.emptyDefinitions)await writeFile(join(f.a.ctx.vaultDir,'index.md'),INITIAL_VAULT_INDEX);
  if(!options.noFleet)await ensureLocalAuthority(f.a.ctx,native.identity,'fixture-project-setup');
  const ownership=openConfiguredOwnership(f.a.ctx,f.a.git);
  if(!options.noFleet)await ownership.claim({id:'project',repositoryKey:'fork:demo',title:'Demo project'},'claim');
  if(!options.emptyDefinitions){await cp('tests/fixtures/vault/agents',join(f.a.ctx.vaultDir,'agents'),{recursive:true});
  await cp('tests/fixtures/vault/groups',join(f.a.ctx.vaultDir,'groups'),{recursive:true});
  for(const name of ['ada','lin']) {
    const path=join(f.a.ctx.vaultDir,`agents/${name}.md`);
    await writeFile(path,(await readFile(path,'utf8')).replaceAll('local-openai','scripted').replaceAll('coding-model','test-model').replaceAll('local-anthropic','scripted').replaceAll('review-model','test-model'));
  }
  }
  if(!options.noFleet)await bindProject(f.a.ctx,{projectId:'project',path:join(native.root,'repo')});
  const provider=scriptedProvider(options.modelIds);const providerOptions={credentials:openCredentialFile(join(f.a.ctx.stateDir,'test-auth.json')),factories:scriptedLoginProviders};
  provider.faux.setResponses(Array.from({length:100},()=>context=>{
    const all=JSON.stringify(context.messages.filter(message=>message.role!=='system'));
    const last=context.messages.filter(m=>m.role==='user').at(-1);
    const text=typeof last?.content==='string'?last.content:JSON.stringify(last?.content);
    const tool=(code:string)=>fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'});
    if(all.includes('Improve team greeting')) {
      if(text?.includes('Greeting verified')&&!all.includes('Local team finished'))return tool('text(await tools.team_report({state:"completed",outcome:{summary:"Local team finished",tests:["Greeting verified"]}}));');
      if(!all.includes('team_delegate'))return tool('text(await tools.team_delegate({agentId:"agent-lin",objective:"Inspect greeting",deliverable:"Greeting verified",contextPaths:[],dependsOn:[]}));');
      return fauxAssistantMessage('Delegated the greeting inspection to Lin.');
    }
    if(all.includes('Inspect greeting')) {
      if(text?.includes('"answer"')&&!all.includes('summary:'))return tool('text(await tools.team_report({state:"completed",outcome:{summary:"Greeting verified"}}));');
      if(!all.includes('team_ask_user')) {
        const input=JSON.parse(text!);
        return tool(`text(await tools.write({path:"base.md",content:"Hello from the local team!\\n"}));text(await tools.team_ask_user({question:"Use the friendly greeting?",recommendation:"Use the friendly greeting",blockedTaskIds:[${JSON.stringify(input.taskId)}]}));`);
      }
      return fauxAssistantMessage('The greeting is ready for your decision.');
    }
    return fauxAssistantMessage('Direct reply from Ada.');
  }));
  const vault=openVault(f.a.ctx);const workspaces=new WorkspaceManager(f.a.ctx);const supervisor=new ProcessSupervisor(f.a.ctx);
  let runtime=await openRuntime({ctx:f.a.ctx,vault,ownership,workspaces,supervisor,models:provider.models,providerOptions,...(options.extensions?{extensions:options.extensions}:{})});
  // Reopen an actual session using a raw pre-validation historical control pin.
  let historicalSession:Awaited<ReturnType<typeof runtime.createSession>>|undefined;
  if(options.historicalThinkingLevel){historicalSession=await runtime.createSession({requestId:'historical-browser',agentId:'agent-ada'});await runtime.close();await f.a.ctx.store.transact(tx=>{const record=tx.get<any>('runtime-session',historicalSession!.id)!;tx.put('runtime-session',historicalSession!.id,{...record,agent:{...record.agent,model:{...record.agent.model,thinkingLevel:options.historicalThinkingLevel}}});});runtime=await openRuntime({ctx:f.a.ctx,vault,ownership,workspaces,supervisor,models:provider.models,providerOptions});}
  const auth=openBrowserSessions(f.a.ctx);const secret=await auth.issueBootstrap();
  let api:ReturnType<typeof createApi>|undefined;
  let closing=false;let closeWork:Promise<void>|undefined;
  const requests=new Set<Promise<Response>>();
  const server=serve({hostname:'127.0.0.1',port:0,fetch:request=>{
    if(closing)return new Response('Closing',{status:503});
    const response=Promise.resolve(api?api.fetch(request):new Response('Starting',{status:503}));
    requests.add(response);void response.then(()=>requests.delete(response),()=>requests.delete(response));
    return response;
  }});
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('Missing server address');
  const url=`http://${options.publicHostname??'127.0.0.1'}:${address.port}`;
  const sync=await openVaultSync({ctx:f.a.ctx,vault,runtime,git:f.a.git,remote:false});
  const schedules=openSchedules({ctx:f.a.ctx,vault,runtime,ownership,workloads:openConfiguredWorkloadOwnership(f.a.ctx,f.a.git)});
  api=createApi({...options.skillImportTransport?{skillImportTransport:options.skillImportTransport}:{},providerOptions,sync,schedules,ctx:f.a.ctx,runtime,team:runtime.team,vault,ownership,workspaces,auth,webAssetsDir:options.webAssetsDir??resolve('dist/web'),publicOrigin:url,name:'Desktop'});
  api.onError(async(error,c)=>{
    const code=(error as {code?:string}).code;if(code&&code!=='INTERNAL_CONTRACT'){const result=apiError(error);return c.json(result.body,result.status);}
    const taskErrors=(await f.a.ctx.store.list('team-task')).flatMap(value=>[...Value.Errors(TaskSchema,value)].map(e=>({path:e.instancePath,message:e.message})));
    const sessionErrors=[];for(const record of await f.a.ctx.store.list<{session:{id:string}}>('runtime-session'))try{const value=publicSnapshot(await runtime.snapshot(record.session.id));sessionErrors.push(...[...Value.Errors(SessionSnapshotSchema,value)].map(e=>({path:e.instancePath,message:e.message})));}catch(e){sessionErrors.push({path:record.session.id,message:e instanceof Error?e.message:'snapshot error'});}
    console.error(JSON.stringify({fixtureApiFailure:{stateDir:f.a.ctx.stateDir,path:c.req.path,message:error.message,cause:error.cause instanceof Error?{message:error.cause.message,stack:error.cause.stack}:String(error.cause),details:(error as {details?:unknown}).details,stack:error.stack,taskErrors,sessionErrors}}));const result=apiError(error);return c.json(result.body,result.status);
  });
  const monitor=startEventReconciliation(f.a.ctx,createSessionSnapshotSource(f.a.ctx,runtime,publicSnapshot));
  return {historicalSession,url,secret,schedules,sync,projectPath:join(native.root,'repo'),ctx:f.a.ctx,runtime,vault,git:f.a.git,faux:provider.faux,supervisor,close:()=>closeWork??=(async()=>{
    closing=true;if(api)closeApi(api);await monitor.close();await schedules.close();
    if('closeAllConnections' in server)server.closeAllConnections();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    // Closing sockets does not join Hono handlers. Provider reads also hold filesystem locks.
    await Promise.allSettled([...requests]);
    await sync.close();await runtime.close();await f.cleanup();
  })()};
}
