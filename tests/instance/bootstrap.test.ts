import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { temporaryInstance } from '../helpers/temp.js';

// A missing bootstrap is an assertion failure rather than a test-module load error.
const bootstrap = () => import('../../src/instance/open.js');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture() {
  const fixture = await temporaryInstance();
  cleanups.push(fixture.cleanup);
  return fixture;
}
async function open(paths: {stateDir: string; vaultDir: string}, clock?: {now(): number}) {
  const module = await bootstrap();
  const ctx = await module.openInstance({ ...paths, ...(clock ? { clock } : {}) });
  cleanups.push(() => ctx.close());
  return ctx;
}

describe('durable local bootstrap', () => {
  it('exports the instance bootstrap API', async () => {
    await expect(bootstrap()).resolves.toHaveProperty('openInstance', expect.any(Function));
  });
  it('survives reopen and refuses a second writer', async () => {
    const { paths } = await fixture();
    const a = await open(paths);
    await a.store.transact(tx => tx.put('probe', 'p', { value: 7 }));
    await expect(open(paths)).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
    await a.close();
    const b = await open(paths);
    expect(b.instanceId).toBe(a.instanceId);
    expect(await b.store.read('probe', 'p')).toEqual({ value: 7 });
    expect(isAbsolute(b.stateDir)).toBe(true);
    expect(isAbsolute(b.vaultDir)).toBe(true);
  });
  it('commits ordered records and events together and rolls back failures', async () => {
    const { paths } = await fixture();
    const ctx = await open(paths, { now: () => 1700000000000 });
    await ctx.store.transact(tx => { tx.insert('probe', 'a', { value: 1 }); tx.emit('created', { id: 'a' }); });
    await expect(ctx.store.transact(tx => { tx.put('probe', 'a', { value: 2 }); tx.emit('bad', null); throw new Error('rollback'); })).rejects.toThrow('rollback');
    await expect(ctx.store.transact(tx => tx.insert('probe', 'a', {}))).rejects.toMatchObject({ code: 'RECORD_EXISTS' });
    await Promise.all([ctx.store.transact(tx => tx.put('probe', 'b', { value: 3 })), ctx.store.transact(tx => { expect(tx.get('probe', 'b')).toEqual({value: 3}); tx.delete('probe', 'b'); })]);
    expect(await ctx.store.list('probe')).toEqual([{ value: 1 }]);
    expect(await ctx.store.events(0)).toMatchObject([{ seq: 1, kind: 'created', at: '2023-11-14T22:13:20.000Z', data: { id: 'a' } }]);
    expect(await ctx.store.events(1)).toEqual([]);
    await ctx.close();
    const reopened = await open(paths);
    expect(await reopened.store.events(0)).toHaveLength(1);
    expect(await reopened.store.read('probe', 'a')).toEqual({ value: 1 });
  });
  it('rejects non-JSON values without partially committing a transaction', async () => {
    const { paths } = await fixture();
    const ctx = await open(paths);
    const cycle: unknown[] = []; cycle.push(cycle);
    for (const value of [undefined, NaN, Infinity, 1n, new Date(), () => {}, { missing: undefined }, cycle, [ , 1]]) {
      await expect(ctx.store.transact(tx => { tx.put('probe', 'ok', {}); tx.put('probe', 'bad', value); })).rejects.toMatchObject({ code: 'INVALID_JSON' });
    }
    await expect(ctx.store.transact(tx => { tx.put('probe', 'ok', {}); tx.emit('bad', NaN); })).rejects.toMatchObject({ code: 'INVALID_JSON' });
    expect(await ctx.store.list('probe')).toEqual([]);
    expect(await ctx.store.events(0)).toEqual([]);
  });
  it('rejects asynchronous transactions and leaves the store usable', async () => {
    const { paths } = await fixture();
    const ctx = await open(paths);
    await expect(ctx.store.transact(async tx => { tx.put('probe', 'a', {}); await Promise.resolve(); tx.put('probe', 'b', {}); })).rejects.toMatchObject({ code: 'ASYNC_TRANSACTION' });
    await ctx.store.transact(tx => tx.put('probe', 'c', {}));
    expect(await ctx.store.list('probe')).toEqual([{}]);
    expect(await ctx.store.read('probe', 'a')).toBeUndefined();
    expect(await ctx.store.read('probe', 'b')).toBeUndefined();
  });
  it('uses SQLite WAL and FULL synchronization and refuses newer schemas', async () => {
    const { paths } = await fixture();
    const ctx = await open(paths);
    const db = new DatabaseSync(join(paths.stateDir, 'control.sqlite'));
    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    // FULL must also be set explicitly by the store; doctor reports the live connection setting.
    expect(ctx.store.durability()).toEqual({ journalMode: 'wal', synchronous: 2 });
    await ctx.close();
    db.exec('PRAGMA user_version=999'); db.close();
    await expect(open(paths)).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
    // Failed opening releases its lock.
    const repair = new DatabaseSync(join(paths.stateDir, 'control.sqlite'));
    repair.exec('PRAGMA user_version=0'); repair.close();
    await open(paths);
  });
  it('gives clones of the same vault distinct local identities', async () => {
    const { paths, root } = await fixture();
    const a = await open(paths);
    const b = await open({ stateDir: join(root, 'clone-state'), vaultDir: paths.vaultDir });
    expect(b.instanceId).not.toBe(a.instanceId);
  });
  it('refuses state inside the vault including symlink aliases', async () => {
    const { paths } = await fixture();
    await expect(open({ ...paths, stateDir: join(paths.vaultDir, 'state') })).rejects.toMatchObject({ code: 'INVALID_STATE_DIR' });
    const alias = join(paths.stateDir, '..', 'alias'); await symlink(paths.vaultDir, alias);
    await expect(open({ ...paths, stateDir: join(alias, 'state') })).rejects.toMatchObject({ code: 'INVALID_STATE_DIR' });
  });
  it('refuses ambiguous lock owners and live PIDs including reused identities', async () => {
    const { paths } = await fixture();
    const ctx = await open(paths); await ctx.close();
    const lockDir = join(paths.stateDir, 'instance.lock');
    await mkdir(lockDir);
    await expect(open(paths)).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, instanceId: ctx.instanceId, token: 'different-process-start' }));
    await expect(open(paths)).rejects.toMatchObject({ code: 'INSTANCE_BUSY' });
  });
  it('recovers a positively dead PID without using elapsed time', async () => {
    const { paths } = await fixture();
    const ctx = await open(paths); await ctx.close();
    const child = spawnSync(process.execPath, ['-e', '']);
    expect(child.status).toBe(0);
    const lockDir = join(paths.stateDir, 'instance.lock');
    await mkdir(lockDir);
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: child.pid, instanceId: ctx.instanceId, token: 'dead-process' }));
    expect((await open(paths)).instanceId).toBe(ctx.instanceId);
  });
  it('preserves binding and does not silently change an existing vault', async () => {
    const { paths, root } = await fixture();
    const ctx = await open(paths); await ctx.close();
    const otherVault = join(root, 'other-vault'); await mkdir(otherVault);
    await expect(open({ ...paths, vaultDir: otherVault })).rejects.toMatchObject({ code: 'VAULT_MISMATCH' });
    expect(JSON.parse(await readFile(join(paths.stateDir, 'config.json'), 'utf8')).vaultDir).toBe(paths.vaultDir);
  });
});

it('initializes through CLI commands with a stable identity and live durability diagnostics', async () => {
  const { paths } = await fixture();
  const { runCli } = await import('../../src/cli.js');
  const a = await runCli(['init', '--state-dir', paths.stateDir, '--vault', paths.vaultDir]);
  const b = await runCli(['init', '--state-dir', paths.stateDir, '--vault', paths.vaultDir]);
  expect(a).toMatchObject({ instanceId: expect.any(String), stateDir: paths.stateDir, vaultDir: paths.vaultDir });
  expect(b).toEqual(a);
  expect(await runCli(['doctor', '--state-dir', paths.stateDir])).toMatchObject({ instanceId: a.instanceId, journalMode: 'wal', synchronous: 2, ok: true });
});

it('initializes a git-only vault once with the exact scaffold and stable revision',async()=>{
 const {paths}=await fixture();const {GitClient}=await import('../../src/git/client.js');await new GitClient().run(paths.vaultDir,['init','--template=','--initial-branch=main']);const {runCli}=await import('../../src/cli.js');
 const a=await runCli(['init','--state-dir',paths.stateDir,'--vault',paths.vaultDir]);
 expect(await readFile(join(paths.vaultDir,'index.md'),'utf8')).toBe('---\nokf_version: "0.2"\n---\n# Knowledge vault\n');
 const ctx=await open(paths);const {openVault}=await import('../../src/vault/write.js');const revision=(await openVault(ctx).read('index.md')).revision;await ctx.close();
 expect(await runCli(['init','--state-dir',paths.stateDir,'--vault',paths.vaultDir])).toEqual(a);
 const reopened=await open(paths);expect((await openVault(reopened).read('index.md')).revision).toBe(revision);expect(await reopened.store.list('vault.proposals')).toHaveLength(0);
});
it.each([['index.md','---\nokf_version: "0.2"\n---\n# Existing\n'],['index.md','---\n[invalid'],['notes.md','# Existing notes\n'],['data.bin','raw data']])('init preserves populated %s and its diagnostics',async(name,content)=>{
 const {paths}=await fixture();await writeFile(join(paths.vaultDir,name),content);const {runCli}=await import('../../src/cli.js');await expect(runCli(['init','--state-dir',paths.stateDir,'--vault',paths.vaultDir])).rejects.toMatchObject({code:'MIGRATION_REQUIRED'});
 expect(await readdir(paths.vaultDir)).toEqual([name]);expect(await readFile(join(paths.vaultDir,name),'utf8')).toBe(content);
 const ctx=await open(paths);const {openVault}=await import('../../src/vault/write.js');expect(await ctx.store.list('vault.proposals')).toEqual([]);const diagnostics=await openVault(ctx).diagnose();if(name!=='index.md'||content.includes('[invalid'))expect(diagnostics.some(d=>d.severity==='error')).toBe(true);
});

it('rejects array accessors at the JSON boundary', async () => {
  const { paths } = await fixture();
  const ctx = await open(paths);
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => 1 });
  await expect(ctx.store.transact(tx => tx.put('probe', 'accessor', accessor))).rejects.toMatchObject({ code: 'INVALID_JSON' });
  expect(await ctx.store.read('probe', 'accessor')).toBeUndefined();
});

it('allows non-worktree directories containing an empty .git marker', async () => {
  const { paths, root } = await fixture();
  await mkdir(join(root, '.git'));
  expect((await open(paths)).stateDir).toBe(paths.stateDir);
});
it('refuses operational state inside an actual Git worktree', async () => {
  const { paths, root } = await fixture();
  await mkdir(join(root, '.git'));
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await expect(open(paths)).rejects.toMatchObject({ code: 'INVALID_STATE_DIR' });
});
it('keeps the generic JSON store contract when projection kinds contain partial records',async()=>{
 const f=await fixture();const ctx=await open(f.paths);for(const kind of ['runtime-session','runtime-effect','runtime-outbox','team-task','team-history','export-batch','sync-captured'])for(const [id,value] of Object.entries({minimal:{session:{id:'minimal',agentId:'agent-ada'},agent:{groups:['group-engineering']}},empty:{},partial:{sessionId:42,entry:true,executingSessionId:{},returnSessionId:null},scalar:'retained',nothing:null})){await ctx.store.transact(tx=>tx.put(kind,id,value));expect(await ctx.store.read(kind,id)).toEqual(value);}expect(await ctx.store.read('runtime-session-index','minimal')).toMatchObject({sessionId:'minimal',agentId:'agent-ada'});await expect(ctx.store.transact(tx=>tx.put('runtime-session','invalid',{session:{id:'invalid'},undefinedField:undefined}))).rejects.toMatchObject({code:'INVALID_JSON'});
});
