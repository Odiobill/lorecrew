import { afterEach, expect, it } from 'vitest';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';
import { openBrowserSessions, COOKIE_NAME } from '../../src/auth/sessions.js';
import * as instance from '../../src/instance/open.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.reverse())await close();cleanups.length=0;});
async function fixture(){const f=await temporaryInstance();cleanups.push(f.cleanup);return f;}
async function state(stateDir:string){const mod=await import('../../src/instance/state.js').catch(()=>({openState:undefined}));expect(mod.openState,'private state opens without a vault').toBeTypeOf('function');const ctx=await mod.openState!({stateDir});cleanups.push(()=>ctx.close());return ctx;}
it('opens private state and pairs a browser without creating a vault',async()=>{
 const f=await fixture();const ctx=await state(f.paths.stateDir);const auth=openBrowserSessions(ctx);const login=await auth.login(await auth.issueBootstrap());
 await expect(access(join(ctx.stateDir,'config.json'))).rejects.toMatchObject({code:'ENOENT'});
 expect((await readdir(ctx.stateDir)).some(name=>/pi|runtime/.test(name))).toBe(false);
 await ctx.close();const again=await state(f.paths.stateDir);expect(again.instanceId).toBe(ctx.instanceId);
 expect(await openBrowserSessions(again).authenticate(`${COOKIE_NAME}=${login.cookie}`)).toMatchObject({id:login.session.id});
});
it('attaches a vault using the same lease and refuses another owner',async()=>{
 const f=await fixture();const ctx=await state(f.paths.stateDir);
 await expect(state(f.paths.stateDir)).rejects.toMatchObject({code:'INSTANCE_BUSY'});
 expect(instance).toHaveProperty('attachVault',expect.any(Function));const attached=await instance.attachVault(ctx,f.paths.vaultDir);
 expect(attached.store).toBe(ctx.store);expect(attached.instanceId).toBe(ctx.instanceId);
 await expect(state(f.paths.stateDir)).rejects.toMatchObject({code:'INSTANCE_BUSY'});
 await attached.close();await ctx.close();const again=await state(f.paths.stateDir);expect(again.instanceId).toBe(ctx.instanceId);
});
it.each(['malformed','disagreement'])('refuses %s private identity without replacing bytes',async(kind)=>{
 const f=await fixture();const ctx=await state(f.paths.stateDir);await instance.attachVault(ctx,f.paths.vaultDir);await ctx.close();
 const path=join(ctx.stateDir,'state-identity.json');const bytes=kind==='malformed'?'invalid':JSON.stringify({instanceId:'00000000-0000-4000-8000-000000000000'});await writeFile(path,bytes);
 await expect(state(f.paths.stateDir)).rejects.toMatchObject({code:'INVALID_CONFIG'});expect(await readFile(path,'utf8')).toBe(bytes);
});
