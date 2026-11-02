// Node's native TS stripping plus a test-only .js→.ts resolver for this source checkout.
import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){
  try{return next(specifier,context);}catch(error){
    if(error.code==='ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js') && specifier.startsWith('.'))return next(specifier.slice(0,-3)+'.ts',context);
    throw error;
  }
}});
const {openInstance}=await import('../../src/instance/open.ts');
const {openVault}=await import('../../src/vault/write.ts');
const {openOwnership}=await import('../../src/projects/ownership.ts');
const {GitClient}=await import('../../src/git/client.ts');
const {WorkspaceManager}=await import('../../src/workspaces/manager.ts');
const {ProcessSupervisor}=await import('../../src/workspaces/processes.ts');
const {openRuntime}=await import('../../src/runtime/pi-host.ts');
const {scriptedProvider,fauxAssistantMessage,fauxToolCall}=await import('./scripted-provider.ts');
const {crashTools}=await import('./crash-tools.ts');
const [root,stage]=process.argv.slice(2);
const ctx=await openInstance({stateDir:root+'/state',vaultDir:root+'/vault'});
const provider=scriptedProvider();
provider.faux.setResponses(stage==='admission'?[fauxAssistantMessage('One message')]:[
  fauxAssistantMessage(fauxToolCall('codemode',{code:stage==='journal'?'text(await tools.effect({})); text(await tools.resume({}));':'text(await tools.effect({}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Done')]);
const runtime=await openRuntime({ctx,vault:openVault(ctx),ownership:openOwnership(ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,extensions:[crashTools(root,stage,true)]});
const session=await runtime.createSession({requestId:'create',agentId:'agent-ada'});
if(stage==='admission'){
  const original=ctx.store.transact;
  ctx.store.transact=fn=>original(tx=>fn({...tx,put(kind,id,value){
    if(kind==='runtime-submission' && value.piId)process.kill(process.pid,'SIGKILL');
    tx.put(kind,id,value);
  }}));
}
await runtime.submit({sessionId:session.id,requestId:'submit',text:'Run once'});
// The real Pi scheduler owns progress; this is only a process lifetime handle.
setInterval(()=>{},1000);
