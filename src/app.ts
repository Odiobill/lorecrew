import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { ServerType } from '@hono/node-server';
import { openState } from './instance/state.js';
import { attachVault } from './instance/open.js';
import { validateStatePlacement } from './instance/placement.js';
import { openVault } from './vault/write.js';
import { openConfiguredOwnership,openConfiguredWorkloadOwnership } from './projects/configured-ownership.js';
import { GitClient } from './git/client.js';
import { WorkspaceManager } from './workspaces/manager.js';
import { ProcessSupervisor } from './workspaces/processes.js';
import { openRuntime } from './runtime/pi-host.js';
import { assertCurrentExecutionState } from './runtime/compatibility.js';
import { openBrowserSessions } from './auth/sessions.js';
import { closeApi, createApi } from './api/app.js';
import { createTransport, closeTransport } from './api/transport.js';
import { authRoutes } from './api/auth-routes.js';
import { startupRoutes } from './api/startup-routes.js';
import { openVaultInitialization } from './setup/vault.js';
import type { StartupView } from './setup/types.js';
import { publicSnapshot } from './api/routes.js';
import { createSessionSnapshotSource, startEventReconciliation } from './api/events.js';
import { openVaultSync } from './sync/service.js';
import { openSchedules, startSchedulePolling } from './schedules/service.js';
import { AppError } from './contracts/base.js';
export interface AppOptions {stateDir:string;vaultDir?:string;host?:string;port?:number;publicOrigin?:string;name?:string;syncRemote?:string|false;webAssetsDir?:string;onBootstrap?:(secret:string)=>void}
export async function startApp(options:AppOptions){
 const host=options.host??'127.0.0.1',port=options.port??4317;
 if(!Number.isInteger(port)||port<0||port>65535)throw new AppError('INVALID_PORT','Port must be an integer from 0 through 65535');
 if(!['127.0.0.1','localhost','::1'].includes(host)&&!options.publicOrigin)throw new AppError('INVALID_ORIGIN','An explicit public origin is required when binding beyond loopback');
 if(options.vaultDir)await validateStatePlacement({stateDir:options.stateDir,vaultDir:options.vaultDir});
 const state=await openState({stateDir:options.stateDir}),auth=openBrowserSessions(state),initialization=openVaultInitialization(state);
 let server:ServerType|undefined,api:Hono|undefined,runtime:Awaited<ReturnType<typeof openRuntime>>|undefined,sync:Awaited<ReturnType<typeof openVaultSync>>|undefined,schedules:ReturnType<typeof openSchedules>|undefined,polling:ReturnType<typeof startSchedulePolling>|undefined,monitor:ReturnType<typeof startEventReconciliation>|undefined;
 let url='',origin='',closing=false,normalReady=false,activation:Promise<void>|undefined,activationError:string|undefined,closePromise:Promise<void>|undefined;const apis=new Set<Hono>();
 async function startup():Promise<StartupView>{const view=await initialization.view();return view.phase==='ready'&&!normalReady?{...view,phase:'initializing',diagnostic:activationError??'Starting vault services. Retry initialization if startup was interrupted.'}:view;}
 const additionalRoutes=()=>startupRoutes({state,initialization,view:startup,activate});
 async function activate():Promise<void>{
  if(closing)throw new AppError('APP_CLOSED','The application is stopping; restart to resume the selected binding');if(normalReady)return;if(activation)return activation;
  const work=(async()=>{
   const view=await initialization.reconcile();if(view.phase!=='ready'||!view.vaultDir)throw new AppError('INSTANCE_NOT_READY',view.diagnostic??'Select a vault before starting services');
   await assertCurrentExecutionState(state);const ctx=await attachVault(state,view.vaultDir);const vault=openVault(ctx),ownership=openConfiguredOwnership(ctx,new GitClient()),workspaces=new WorkspaceManager(ctx);
   let nextRuntime:typeof runtime,nextSync:typeof sync,nextPolling:typeof polling,nextMonitor:typeof monitor,nextApi:Hono|undefined;
   try{
    nextRuntime=await openRuntime({ctx,vault,ownership,workspaces,supervisor:new ProcessSupervisor(ctx)});
    const nextSchedules=openSchedules({ctx,vault,runtime:nextRuntime,ownership,workloads:openConfiguredWorkloadOwnership(ctx,new GitClient())});
    nextSync=await openVaultSync({ctx,vault,runtime:nextRuntime,git:new GitClient(),...(options.syncRemote!==undefined?{remote:options.syncRemote}:{})});
    nextApi=createApi({ctx,vault,ownership,workspaces,runtime:nextRuntime,team:nextRuntime.team,sync:nextSync,schedules:nextSchedules,auth,publicOrigin:origin,additionalRoutes,...(options.name?{name:options.name}:{}),...(options.webAssetsDir?{webAssetsDir:options.webAssetsDir}:{})});
    nextPolling=startSchedulePolling(ctx,nextSchedules);nextMonitor=startEventReconciliation(ctx,createSessionSnapshotSource(ctx,nextRuntime,publicSnapshot));
    if(closing)throw new AppError('APP_CLOSED','The application stopped during activation; restart to resume');
    runtime=nextRuntime;sync=nextSync;schedules=nextSchedules;polling=nextPolling;monitor=nextMonitor;api=nextApi;apis.add(nextApi);normalReady=true;activationError=undefined;
   }catch(error){
    if(nextApi){closeApi(nextApi);await closeTransport(nextApi);}await nextPolling?.close();await nextMonitor?.close();await nextSync?.close();
    try{await nextRuntime?.close();}catch(cleanupError){runtime=nextRuntime;activationError='Vault startup has unresolved execution evidence. Keep state and inspect stopped-process proof.';throw cleanupError;}
    activationError=error instanceof AppError?error.message:'Vault services could not start. The selected binding is retained; repair configuration and retry initialization.';throw error;
   }
  })();activation=work;try{await work;}finally{if(activation===work)activation=undefined;}
 }
 async function dispose(){
  closing=true;for(const current of apis)closeApi(current);await Promise.all([...apis].map(closeTransport));await activation?.catch(()=>{});
  await polling?.close();await monitor?.close();if(server){if('closeAllConnections' in server)server.closeAllConnections();if(server.listening)await new Promise<void>((resolve,reject)=>server!.close(error=>error?reject(error):resolve()));server=undefined;}
  await sync?.close();await runtime?.close();await state.close();
 }
 try{
  try{await assertCurrentExecutionState(state);}catch(error){if(!(error instanceof AppError)||error.code!=='MIGRATION_REQUIRED')throw error;}if(options.vaultDir)await attachVault(state,options.vaultDir);
  server=serve({hostname:host,port,fetch:request=>api?api.fetch(request):new Response('Starting',{status:503})});
  await new Promise<void>((resolve,reject)=>{if(server!.listening)resolve();else server!.once('listening',resolve);server!.once('error',reject);});
  const address=server.address();if(!address||typeof address==='string')throw new AppError('SERVER_FAILED','Cannot inspect listening address');url=`http://${host.includes(':')?`[${host}]`:host}:${address.port}`;origin=options.publicOrigin??url;
  api=createTransport({state,auth,origin,notReady:true,...(options.webAssetsDir?{webAssetsDir:options.webAssetsDir}:{}),describe:security=>[...authRoutes(state,auth,origin,security.principal),...additionalRoutes()]});apis.add(api);
  const view=await initialization.reconcile();if(view.phase==='ready')try{await activate();}catch{/* Authenticated startup remains available for a retry of this binding. */}
  const secret=await auth.issueBootstrap();(options.onBootstrap??(value=>console.error(`Lorecrew login secret (valid 15 minutes, one use): ${value}`)))(secret);
  return {url:origin,startup,get sync(){return sync;},get schedules(){return schedules;},close:()=>closePromise??=dispose()};
 }catch(error){await dispose();throw error;}
}
