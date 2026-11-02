import { afterEach, expect, it, vi } from 'vitest';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startupFixture } from '../helpers/startup-app.js';
const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();vi.unstubAllEnvs();});
it('pairs before vault selection without opening runtime and denies unauthenticated host access',async()=>{
 const f=await startupFixture();cleanup.push(f.cleanup);expect((await fetch(f.app.url+'/')).status).toBe(200);expect((await fetch(f.app.url+'/manifest.webmanifest')).status).toBe(200);
 for(const path of ['/startup','/snapshot'])expect((await f.request(path)).status).toBe(401);expect((await f.request('/startup/directories',{method:'POST',headers:{origin:f.app.url,'content-type':'application/json'},body:'{}'})).status).toBe(401);
 expect(await (await f.request('/startup',{headers:{cookie:f.cookie}})).json()).toMatchObject({phase:'vault_required',defaultVaultDir:''});expect(f.app.sync).toBeUndefined();expect(f.app.schedules).toBeUndefined();
 expect(await (await f.request('/snapshot',{headers:{cookie:f.cookie}})).json()).toMatchObject({error:{code:'INSTANCE_NOT_READY'}});expect((await f.request('/snapshot',{headers:{cookie:f.cookie}})).status).toBe(409);
 for(const name of ['pi.sqlite','config.json'])await expect(access(join(f.paths.stateDir,name))).rejects.toMatchObject({code:'ENOENT'});
 expect((await f.request('/no-such-route',{headers:{cookie:f.cookie}})).status).toBe(404);expect((await f.request('/startup/directories',f.write({path:f.root}))).status).toBe(200);
});
it('preserves Origin, CSRF, browser-only filesystem authority and token scopes before activation',async()=>{
 const f=await startupFixture();cleanup.push(f.cleanup);const preview={choice:{kind:'default'}};
 for(const headers of [{...f.headers,origin:'https://other.test'},{...f.headers,'x-csrf-token':'wrong'}])expect((await f.request('/startup/vault-preview',{method:'POST',headers,body:JSON.stringify(preview)})).status).toBe(403);
 const created=await f.request('/auth/tokens',f.write({name:'read-fixture',scopes:['read']}));expect(created.status).toBe(201);const {token}=await created.json() as {token:string};expect((await f.request('/startup',{headers:{authorization:'Bearer '+token}})).status).toBe(200);
 expect((await f.request('/startup/vault-preview',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(preview)})).status).toBe(403);
 expect((await f.request('/startup/vault',f.write({choice:{kind:'default'},previewToken:'wrong',expectedRevision:'wrong'}))).status).toBe(409);
 await expect(access(join(f.root,'Lorecrew vault'))).rejects.toMatchObject({code:'ENOENT'});
});
it('retries the frozen initialization without reconstructing a lost confirmation body',async()=>{
 const f=await startupFixture();cleanup.push(f.cleanup);const {writeFile,rm}=await import('node:fs/promises');await writeFile(join(f.paths.stateDir,'providers.json'),'invalid');const p=await(await f.request('/startup/vault-preview',f.write({choice:{kind:'new',parentPath:f.root,folderName:'Lorecrew vault'}}))).json() as any;await f.request('/startup/vault',f.write({choice:{kind:'new',parentPath:f.root,folderName:'Lorecrew vault'},previewToken:p.token,expectedRevision:p.revision},'retry-intent'));
 await rm(join(f.paths.stateDir,'providers.json'));const retry=await f.request('/startup/retry',f.write({},'retry-activation'));expect(retry.status).toBe(200);expect(await retry.json()).toMatchObject({phase:'ready'});
});
