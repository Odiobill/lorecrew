import {serve} from '@hono/node-server';
import {resolve} from 'node:path';
import {createApi,closeApi} from '../../src/api/app.js';
import {openBrowserSessions} from '../../src/auth/sessions.js';
import {openVault} from '../../src/vault/write.js';
import type {ApiOptions} from '../../src/api/routes.js';
export async function serveProjectBrowser(options:Pick<ApiOptions,'ctx'|'runtime'|'ownership'|'workspaces'>){let app:ReturnType<typeof createApi>|undefined;const active=new Set<Promise<Response>>(),server=serve({hostname:'127.0.0.1',port:0,fetch(request){if(!app)return new Response('Starting',{status:503});const p=Promise.resolve(app.fetch(request));active.add(p);void p.finally(()=>active.delete(p));return p;}});await new Promise<void>(r=>server.listening?r():server.once('listening',r));const address=server.address();if(!address||typeof address==='string')throw Error('No local test address');const url='http://127.0.0.1:'+address.port,auth=openBrowserSessions(options.ctx),secret=await auth.issueBootstrap();app=createApi({...options,team:options.runtime.team,vault:openVault(options.ctx),auth,publicOrigin:url,webAssetsDir:resolve('dist/web'),name:'Desktop'});return {url,secret,async close(){closeApi(app!);if('closeAllConnections' in server)server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await Promise.allSettled([...active]);}};}
