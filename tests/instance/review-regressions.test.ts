import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { temporaryInstance } from '../helpers/temp.js';
import { openInstance } from '../../src/instance/open.js';

let fixture: Awaited<ReturnType<typeof temporaryInstance>>;
let buildDir: string;
const children: ChildProcess[] = [];
beforeAll(async () => {
  fixture = await temporaryInstance();
  buildDir = join(fixture.root, 'build');
  await writeFile(join(fixture.root, 'package.json'), '{"type":"module"}');
  // Exercise compiled code with the same installed runtime dependencies as the package.
  await symlink(resolve('node_modules'), join(fixture.root, 'node_modules'), 'dir');
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', buildDir], { encoding: 'utf8' });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const child of children) child.kill();
  await fixture.cleanup();
});
async function waitFor(path: string) {
  for (let i = 0; i < 500; i++) { if (existsSync(path)) return; await setTimeout(10); }
  throw new Error(`Child did not create ${path}`);
}

it.each(['own toJSON', 'custom prototype'])('rejects array %s before storage', async mode => {
  const ctx = await openInstance(fixture.paths);
  try {
    const hooked = [1];
    Object.defineProperty(hooked, 'toJSON', { value: () => ({ replaced: true }) });
    const custom = [2];
    Object.setPrototypeOf(custom, { toJSON: () => ({ replaced: true }) });
    const value = mode === 'own toJSON' ? hooked : custom;
    await expect(ctx.store.transact(tx => tx.put('probe', 'hook', value))).rejects.toMatchObject({ code: 'INVALID_JSON' });
    expect(await ctx.store.read('probe', 'hook')).toBeUndefined();
  } finally { await ctx.close(); }
});

it('executes the CLI when launched through its npm-style executable symlink', async () => {
  const executable = join(fixture.root, 'lorecrew');
  await symlink(join(buildDir, 'cli.js'), executable);
  const invalid = spawnSync(process.execPath, [executable, 'invalid'], { encoding: 'utf8' });
  expect(invalid.status).toBe(1);
  expect(invalid.stderr, JSON.stringify(invalid)).not.toBe('');
  expect(JSON.parse(invalid.stderr)).toMatchObject({ code: 'USAGE' });
  const vault=join(fixture.root,'symlink-vault'),state=join(fixture.root,'symlink-state');await mkdir(vault);
  const result = spawnSync(process.execPath, [executable, 'init', '--state-dir', state, '--vault', vault], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ instanceId: expect.any(String), stateDir: state });
});

it('does not remove a live replacement owner during a dead-PID recovery race', async () => {
  const state = join(fixture.root, 'race-state'); await mkdir(state);
  const lockUrl = pathToFileURL(join(buildDir, 'instance', 'lock.js')).href;
  const ready = join(state, 'ready'); const trigger = join(state, 'switch'); const replacementReady = join(state, 'replacement-ready');
  const replacementScript = join(fixture.root, 'replacement.mjs');
  await writeFile(replacementScript, `import { acquireLock } from ${JSON.stringify(lockUrl)}; import { writeFileSync } from 'node:fs'; const lock=await acquireLock(${JSON.stringify(state)},'replacement'); writeFileSync(${JSON.stringify(replacementReady)},'ready'); setInterval(()=>{},1000);`);
  const original = spawn(process.execPath, ['--input-type=module', '-e', `
    import { acquireLock } from ${JSON.stringify(lockUrl)};
    import { existsSync, writeFileSync } from 'node:fs'; import { spawn } from 'node:child_process';
    const lock=await acquireLock(${JSON.stringify(state)},'original'); writeFileSync(${JSON.stringify(ready)},'ready');
    const timer=setInterval(async()=>{ if(!existsSync(${JSON.stringify(trigger)})) return; clearInterval(timer);
      writeFileSync(${JSON.stringify(join(state, 'releasing'))},'ready'); await lock.release();
      const child=spawn(process.execPath,[${JSON.stringify(replacementScript)}],{stdio:'ignore',detached:true});
      writeFileSync(${JSON.stringify(join(state, 'replacement-pid'))},String(child.pid)); child.unref();
    },5);
  `], { stdio: 'ignore' });
  children.push(original); await waitFor(ready);
  const actualKill = process.kill.bind(process);
  let switched = false;
  // Delay the real liveness probe until an independent owner has attempted release/replacement.
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === original.pid && !switched) {
      switched = true; writeFileSync(trigger, 'switch');
      const coordinator = spawnSync(process.execPath, ['-e', `
        const fs=require('node:fs'); const until=Date.now()+2500;
        while(!fs.existsSync(${JSON.stringify(join(state, 'releasing'))}) && Date.now()<until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);
        const grace=Date.now()+150;
        while(Date.now()<grace) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);

      `]);
      expect(coordinator.status).toBe(0);
      // Model the exited original PID as reaped, independent of this parent's blocked SIGCHLD loop.
      // The replacement is a real process that acquired through the production API.
      if (existsSync(replacementReady)) throw Object.assign(new Error('original exited'), { code: 'ESRCH' });
    }
    return actualKill(pid, signal);
  });
  try {
    const { acquireLock } = await import('../../src/instance/lock.js');
    await expect(acquireLock(state, 'recoverer')).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
    await waitFor(replacementReady);
    expect(JSON.parse(await readFile(join(state, 'instance.lock', 'owner.json'), 'utf8'))).toMatchObject({ instanceId: 'replacement' });
  } finally {
    spy.mockRestore();
    const pidPath = join(state, 'replacement-pid');
    if (existsSync(pidPath)) { try { actualKill(Number(readFileSync(pidPath, 'utf8'))); } catch {} }
  }
});

it('closes during a contender transition publication window without stranding ownership', async () => {
  const state = join(fixture.root, 'publication-state');
  const paths = { stateDir: state, vaultDir: fixture.paths.vaultDir };
  const ctx = await openInstance(paths);
  const paused = join(state, 'publication-paused'); const resume = join(state, 'publication-resume'); const done = join(state, 'publication-done');
  const gate = join(state, 'instance.lock-recovery');
  const lockUrl = pathToFileURL(join(buildDir, 'instance', 'lock.js')).href;
  const contender = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import { existsSync, writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module'; import { setTimeout } from 'node:timers/promises';
    let paused=false;
    async function pause(){ if(paused) return; paused=true; writeFileSync(${JSON.stringify(paused)},'ready'); while(!existsSync(${JSON.stringify(resume)})) await setTimeout(5); }
    const mkdir=fs.mkdir.bind(fs); const link=fs.link.bind(fs);
    fs.mkdir=async(...args)=>{ const result=await mkdir(...args); if(String(args[0])===${JSON.stringify(gate)}) await pause(); return result; };
    fs.link=async(...args)=>{ if(String(args[1])===${JSON.stringify(gate)}) await pause(); return link(...args); };
    syncBuiltinESMExports();
    const { acquireLock }=await import(${JSON.stringify(lockUrl)});
    try { const lock=await acquireLock(${JSON.stringify(state)},'contender'); await lock.release(); writeFileSync(${JSON.stringify(done)},'acquired-and-released'); }
    catch(error) { writeFileSync(${JSON.stringify(done)},error.code ?? String(error)); }
  `], { stdio: 'ignore' });
  children.push(contender);
  try {
    await waitFor(paused);
    await expect(ctx.close()).resolves.toBeUndefined();
  } finally { writeFileSync(resume, 'continue'); await waitFor(done); }
  const reopened = await openInstance(paths);
  expect(reopened.instanceId).toBe(ctx.instanceId);
  await reopened.close();
});

it('allows close retry after explicit recovery of ambiguous transition metadata', async () => {
  const paths = { stateDir: join(fixture.root, 'close-retry-state'), vaultDir: fixture.paths.vaultDir };
  const ctx = await openInstance(paths);
  const gate = join(paths.stateDir, 'instance.lock-recovery');
  await mkdir(gate);
  await expect(ctx.close()).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
  // Only the explicit operator/test recovery removes ambiguous metadata.
  await rm(gate, { recursive: true });
  await expect(ctx.close()).resolves.toBeUndefined();
  const reopened = await openInstance(paths);
  expect(reopened.instanceId).toBe(ctx.instanceId);
  await reopened.close();
});
