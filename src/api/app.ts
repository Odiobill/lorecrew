import { openVaultInitialization } from '../setup/vault.js';
import { StartupSchema } from './schemas.js';
import { ProviderLogins } from '../runtime/provider-login.js';
import type { Hono } from 'hono';
import { openBrowserSessions } from '../auth/sessions.js';
import { routes, type ApiOptions } from './routes.js';
import { createTransport } from './transport.js';
const providerServices=new WeakMap<Hono,ProviderLogins>();
export function closeApi(app:Hono):void{providerServices.get(app)?.close();providerServices.delete(app);}
export function createApi(options:ApiOptions):Hono {
 const {ctx}=options,auth=options.auth??openBrowserSessions(ctx);
 const providerLogins=options.providerLogins??new ProviderLogins({stateDir:ctx.stateDir,...(options.providerOptions?{providerOptions:options.providerOptions}:{}),onSaved:()=>options.runtime.reloadProviders(),ownerActive:async id=>(await auth.list()).some(s=>s.id===id)});
 try{const app=createTransport({state:ctx,auth,origin:options.publicOrigin??'http://localhost',...(options.webAssetsDir?{webAssetsDir:options.webAssetsDir}:{}),describe:security=>[...routes({...options,providerLogins},auth,options.publicOrigin??'http://localhost',security.principal,security.authorize),...(options.additionalRoutes?.(security)??[{method:'GET' as const,path:'/startup',response:StartupSchema,handle:()=>openVaultInitialization(ctx).view()}])]});providerServices.set(app,providerLogins);return app;}catch(error){providerLogins.close();throw error;}
}
