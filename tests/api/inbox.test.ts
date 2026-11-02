import {afterEach,expect,it} from 'vitest';
import {localTeam} from '../helpers/local-team.js';
const clean:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of clean.splice(0))await close();});
it('acknowledgment_does_not_answer_decision and durable old retries cannot hide a new revision',async()=>{
 const f=await localTeam({noFleet:true});clean.push(f.close);
 const login=await fetch(f.url+'/api/v1/auth/login',{method:'POST',headers:{origin:f.url,'content-type':'application/json'},body:JSON.stringify({secret:f.secret})});const auth=await login.json() as any;const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 const headers={cookie,origin:f.url,'content-type':'application/json','x-csrf-token':auth.csrfToken};
 const put=(revision:string,key:string)=>fetch(f.url+'/api/v1/inbox/seen',{method:'PUT',headers:{...headers,'idempotency-key':key},body:JSON.stringify({id:'decision:choice',revision})});
 const get=()=>fetch(f.url+'/api/v1/inbox/seen',{headers:{cookie}});
 await f.ctx.store.transact(tx=>tx.put('team-decision','choice',{id:'choice',taskId:'task',question:'Proceed?',recommendation:'Wait',blockedTaskIds:['task'],state:'pending'}));
 expect((await get()).status).toBe(200);expect(await (await get()).json()).toEqual({items:[]});
 expect((await put('r1','first')).status).toBe(200);expect((await put('r2','second')).status).toBe(200);
 // Lose the generic HTTP receipt: the marker endpoint itself must remain idempotent.
 const receipts=await f.ctx.store.list<any>('api-request');await f.ctx.store.transact(tx=>{for(const r of receipts)tx.put('api-request',r.requestId.slice(5),{fingerprint:r.fingerprint,requestId:r.requestId});});
 expect((await put('r1','first')).status).toBe(200);
 expect(await (await get()).json()).toEqual({items:expect.arrayContaining([{id:'decision:choice',revision:'r1'},{id:'decision:choice',revision:'r2'}])});
 expect(await f.ctx.store.read('team-decision','choice')).toMatchObject({state:'pending'});
 expect(await f.ctx.store.list('ui-inbox-seen')).toHaveLength(2);
 expect((await f.ctx.store.events(0)).filter(e=>e.kind==='inbox.updated')).toHaveLength(2);
 const inbox=await fetch(f.url+'/api/v1/inbox',{headers:{cookie}});expect((await inbox.json()).items).toMatchObject([{id:'decision:choice',class:'action'}]);
 expect((await fetch(f.url+'/api/v1/inbox/seen')).status).toBe(401);
 expect((await fetch(f.url+'/api/v1/inbox/seen',{method:'PUT',headers:{...headers,'x-csrf-token':'wrong','idempotency-key':'wrong'},body:JSON.stringify({id:'a',revision:'b'})})).status).toBe(403);
});
