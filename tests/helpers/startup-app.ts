import { resolve } from 'node:path';
import { vi } from 'vitest';
import { temporaryInstance } from './temp.js';
import { startApp } from '../../src/app.js';
export async function startupFixture(){const f=await temporaryInstance();vi.stubEnv('HOME',f.root);let secret='';let app:Awaited<ReturnType<typeof startApp>>;
 try{app=await startApp({stateDir:f.paths.stateDir,port:0,syncRemote:false,webAssetsDir:resolve('dist/web'),onBootstrap:value=>secret=value});}catch(error){await f.cleanup();throw error;}
 const request=(path:string,options:RequestInit={})=>fetch(app.url+'/api/v1'+path,options);
 const login=await request('/auth/login',{method:'POST',headers:{origin:app.url,'content-type':'application/json'},body:JSON.stringify({secret})});const credentials=await login.json() as {id:string;csrfToken:string};const cookie=login.headers.get('set-cookie')!.split(';')[0]!;const headers={origin:app.url,cookie,'x-csrf-token':credentials.csrfToken,'content-type':'application/json'};
 const write=(body:unknown,key='request'):RequestInit=>({method:'POST',headers:{...headers,'idempotency-key':key},body:JSON.stringify(body)});
 return {...f,app,request,headers,credentials,cookie,write,async cleanup(){await app.close();await f.cleanup();vi.unstubAllEnvs();}};
}
