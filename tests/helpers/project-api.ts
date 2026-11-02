import {afterEach} from 'vitest';
import {setupFixture} from './setup.js';
import {createApi,closeApi} from '../../src/api/app.js';
import {openBrowserSessions} from '../../src/auth/sessions.js';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
export async function projectApiFixture(){const f=await setupFixture();closes.push(f.close);const auth=openBrowserSessions(f.ctx),app=createApi({...f,team:f.runtime.team,auth,publicOrigin:'http://localhost'});closes.push(async()=>closeApi(app));const login=await auth.login(await auth.issueBootstrap()),headers={cookie:'lorecrew_session='+login.cookie,origin:'http://localhost','x-csrf-token':login.csrfToken,'content-type':'application/json'};return {...f,app,auth,headers,get:(path:string)=>app.request('/api/v1'+path,{headers}),post:(path:string,body:unknown,key='entry',h=headers)=>app.request('/api/v1'+path,{method:'POST',headers:{...h,'idempotency-key':key},body:JSON.stringify(body)})};}
