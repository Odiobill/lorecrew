import { afterEach, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';
import { startApp } from '../../src/app.js';
import { openInstance } from '../../src/instance/open.js';
import { runCli } from '../../src/cli.js';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
it.each([false,true])('keeps actual fresh startup and restart in onboarding before automatic device export (git-only: %s)',async(gitOnly)=>{
 const f=await temporaryInstance();closes.push(f.cleanup);if(gitOnly){const {GitClient}=await import('../../src/git/client.js');await new GitClient().run(f.paths.vaultDir,['init','--template=','--initial-branch=main']);}const init=await runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);const root=await readFile(join(f.paths.vaultDir,'index.md'));let app!:Awaited<ReturnType<typeof startApp>>,cookie='';
 for(let start=0;start<2;start++){
  let secret='';app=await startApp({...f.paths,port:0,onBootstrap:value=>{secret=value;}});closes.push(app.close);await app.sync!.flush();
  const login=await fetch(app.url+'/api/v1/auth/login',{method:'POST',headers:{origin:app.url,'content-type':'application/json'},body:JSON.stringify({secret})});expect(login.status).toBe(200);cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const view=await(await fetch(app.url+'/api/v1/setup',{headers:{cookie}})).json() as any;expect(view).toMatchObject({state:null,needsSetup:true,readiness:{model:'missing_model'}});expect(await readFile(join(f.paths.vaultDir,'index.md'))).toEqual(root);expect((await readdir(f.paths.vaultDir)).sort()).toEqual(['.git','.lorecrew','index.md']);
  if(start===0)await app.close();
 }
 // A deliberate note allows device publication; persisted starter entry still resumes until completed.
 await writeFile(join(f.paths.vaultDir,'note.md'),'---\ntype: Note\n---\nFirst deliberate note\n');await app.sync!.flush();expect(await readFile(join(f.paths.vaultDir,'devices',String(init.instanceId)+'.md'),'utf8')).toContain('Reported device');expect(await(await fetch(app.url+'/api/v1/setup',{headers:{cookie}})).json()).toMatchObject({needsSetup:true,entry:'starter'});
 await app.close();const ctx=await openInstance(f.paths);closes.push(()=>ctx.close());expect(ctx.instanceId).toBe(init.instanceId);for(const kind of ['runtime-session','runtime-outbox','team-task','fleet','assignment-grants','skill-pin'])expect(await ctx.store.list(kind)).toEqual([]);
});
it('starts the application without a remote, composes a durable local outbox, and drains it before closing storage',async()=>{
 const f=await temporaryInstance();closes.push(f.cleanup);await runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);await writeFile(join(f.paths.vaultDir,'index.md'),'---\nokf_version: "0.2"\n---\n# Local vault\n');
 const app=await startApp({...f.paths,port:0,onBootstrap:()=>{}});closes.push(app.close);
 expect(await app.schedules!.list()).toEqual([]);
 await app.sync!.flush();expect((await app.sync!.status()).mode).toBe('awaiting_remote');
 await mkdir(join(f.paths.vaultDir,'lessons'));await writeFile(join(f.paths.vaultDir,'lessons/local.md'),'---\ntype: Lesson\n---\nLocal edit\n');
 const flushing=app.sync!.flush();await app.close();await flushing;
 await expect(app.schedules!.tick(new Date().toISOString())).rejects.toMatchObject({code:'SCHEDULES_CLOSED'});
 const reopened=await openInstance(f.paths);closes.push(()=>reopened.close());expect((await reopened.store.list('sync-local-commit')).length).toBeGreaterThan(0);const {GitClient}=await import('../../src/git/client.js');expect((await new GitClient().run(f.paths.vaultDir,['show','HEAD:lessons/local.md'])).stdout).toContain('Local edit');expect(await readFile(join(f.paths.vaultDir,'lessons/local.md'),'utf8')).toContain('Local edit');
});
it('keeps application startup available when a configured remote cannot be reached',async()=>{
 const f=await temporaryInstance();closes.push(f.cleanup);await runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);await writeFile(join(f.paths.vaultDir,'index.md'),'---\nokf_version: "0.2"\n---\n# Local vault\n');
 const app=await startApp({...f.paths,syncRemote:join(f.root,'missing.git'),port:0,onBootstrap:()=>{}});closes.push(app.close);await app.sync!.flush();expect((await app.sync!.status()).error).toBeTruthy();expect((await fetch(app.url+'/')).status).toBeLessThan(500);
});
