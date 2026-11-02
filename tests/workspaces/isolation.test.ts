import { workspaceContext } from '../helpers/execution.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, test } from 'vitest';
import { mkdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryInstance } from '../helpers/temp.js';
import { realGit } from '../helpers/git-fleet.js';
import { openInstance, type InstanceContext } from '../../src/instance/open.js';
import { bindProject } from '../../src/projects/bindings.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { LinuxProcessProbe, ProcessSupervisor } from '../../src/workspaces/processes.js';
import type { HostProcessRecord } from '../../src/workspaces/types.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture(git = true) {
  const temp = await temporaryInstance(); cleanup.push(temp.cleanup);
  const ctx = await openInstance(temp.paths); cleanup.push(() => ctx.close());
  const path = join(temp.root, 'project'); await mkdir(path);
  if (git) {
    for (const args of [['init', '--initial-branch=main'], ['config', 'user.name', 'Workspace fixture'], ['config', 'user.email', 'workspace@example.test']]) expect((await realGit(path, args)).exitCode).toBe(0);
    await writeFile(join(path, 'file.txt'), 'original\n');
    expect((await realGit(path, ['add', '.'])).exitCode).toBe(0);
    expect((await realGit(path, ['commit', '-m', 'base'])).exitCode).toBe(0);
  }
  if(git)await bindProject(ctx, { projectId: 'project', path });else await ctx.store.transact(tx=>tx.put('project-binding','project',{projectId:'project',path}));
  const manager = new WorkspaceManager(ctx); const supervisor = new ProcessSupervisor(ctx);
  cleanup.push(() => supervisor.stop('project'));
  return { ...temp, ctx, path, manager, supervisor };
}
async function waitFile(path: string): Promise<string> {
  for (let i = 0; i < 150; i++) { try { return await readFile(path, 'utf8'); } catch {} await delay(20); }
  throw new Error(`Timed out waiting for ${path}`);
}
function live(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitGone(pid: number) {
  for (let i = 0; i < 150; i++) { if (!live(pid)) return; await delay(20); }
  // Linux may retain an adopted zombie; it is no longer executing.
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  expect(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]).toMatch(/^(Z)?$/);
}

describe('isolated workspaces', () => {
  test('different Git writers and the integration lead never alter the dirty user checkout', async () => {
    const f = await fixture(); await writeFile(join(f.path, 'file.txt'), 'user unsaved work\n');
    const [first, second] = await Promise.all([f.manager.acquire({projectId:'project',taskId:'one'}), f.manager.acquire({projectId:'project',taskId:'two'})] as const);
    expect(first.path).not.toBe(second.path); expect(first.path).not.toBe(f.path);
    expect(first.branch).toBe('lorecrew/task/one'); expect(second.branch).toBe('lorecrew/task/two');
    expect(await readFile(join(first.path, 'file.txt'), 'utf8')).toBe('original\n');
    const lead = await f.manager.acquireLead('project'); expect(lead.path).not.toBe(f.path); expect(lead.path).not.toBe(first.path);
    expect((await realGit(f.path, ['branch', '--show-current'])).stdout.trim()).toBe('main');
    expect(await readFile(join(f.path, 'file.txt'), 'utf8')).toBe('user unsaved work\n');
    await writeFile(join(first.path, 'file.txt'), 'changed unsaved work\n');
    await writeFile(join(first.path, 'new.txt'), 'untracked unsaved work\n');
    expect(await f.manager.diff(first.id)).toContain('changed'); expect(await f.manager.diff(first.id)).toContain('new.txt');
    await f.manager.release(first.id);
    expect(await readFile(join(first.path, 'file.txt'), 'utf8')).toContain('unsaved work');
    const resumed = await new WorkspaceManager(f.ctx).acquire({projectId:'project',taskId:'one'});
    expect(resumed.path).toBe(first.path); expect(await readFile(join(resumed.path, 'new.txt'), 'utf8')).toContain('unsaved');
  });
  test('legacy plain bindings refuse execution across independent managers without slot records',async()=>{const f=await fixture(false);await writeFile(join(f.path,'retained'),'before');for(const manager of [f.manager,new WorkspaceManager(f.ctx)])await expect(manager.acquire({projectId:'project',taskId:'old'})).rejects.toMatchObject({code:'MIGRATION_REQUIRED'});expect(await f.ctx.store.list('workspace')).toEqual([]);expect(await f.ctx.store.list('plain-execution-slot')).toEqual([]);expect(await readFile(join(f.path,'retained'),'utf8')).toBe('before');});
  test('release retains an isolated Git workspace while its command is live', async () => {
    const f = await fixture(); const w=await f.manager.acquire({projectId:'project',taskId:'writer'});
    const running=f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'writer',command:'echo $$ > running.pid; exec sleep 300'});
    void running.catch(()=>{});
    const pid=Number(await waitFile(join(w.path,'running.pid')));
    cleanup.push(async()=> {await f.supervisor.stop('project'); try {process.kill(pid,'SIGKILL');}catch{} await running;});
    await expect(f.manager.release(w.id)).rejects.toThrow();
    expect((await f.supervisor.stop('project')).quiescent).toBe(true);
    await running; await f.manager.release(w.id);
  });
  test('bindings store canonical paths, reject active rebinding and invalid task branch names', async () => {
    const f = await fixture(); const link = join(f.root,'link'); await symlink(f.path,link);
    await bindProject(f.ctx,{projectId:'project',path:link});
    expect((await f.ctx.store.read<{path:string}>('project-binding','project'))?.path).toBe(await realpath(f.path));
    await f.manager.acquire({projectId:'project',taskId:'valid'});
    await expect(bindProject(f.ctx,{projectId:'project',path:f.paths.vaultDir})).rejects.toThrow();
    await expect(f.manager.acquire({projectId:'project',taskId:'../../outside'})).rejects.toThrow();
  });
});

describe('host process supervision', () => {
  test('runs intentional shell input inside workspace, bounds display, retains full output, rejects request reuse', async () => {
    const f = await fixture(); const w = await f.manager.acquire({projectId:'project',taskId:'output'});
    const result = await f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'output',command:"pwd; printf 'marker\\n'; head -c 50000 /dev/zero | tr '\\0' x"});
    expect(result.exitCode).toBe(0); expect(result.output.length).toBeLessThan(20000); expect(result.output).toContain(w.path);
    expect(result.artifactPath).toBeTruthy(); const full = await readFile(result.artifactPath!,'utf8'); expect(full.length).toBeGreaterThan(50000); expect(full).toContain('marker');
    await expect(f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'output',command:'touch duplicated'})).rejects.toThrow();
    expect((await f.supervisor.stop('project')).quiescent).toBe(true);
  });
  test('stop includes shell grandchildren and survives construction of a new supervisor', async () => {
    const f = await fixture(); const w = await f.manager.acquire({projectId:'project',taskId:'children'});
    const running = f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'children',command:"sh -c 'sleep 300 & echo $! > child.pid; wait' & wait"});
    void running.catch(() => {});
    const pid = Number(await waitFile(join(w.path,'child.pid'))); cleanup.push(async()=>{if(live(pid)) { try {process.kill(pid,'SIGKILL');}catch{} } await running;});
    expect(live(pid)).toBe(true);
    expect((await new ProcessSupervisor(f.ctx).stop('project')).quiescent).toBe(true);
    await running; await waitGone(pid);
    await expect(f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'after-stop',command:'true'})).rejects.toThrow();
  });
  test('escaped orphan is detected and blocks quiescence even after its launching shell exits', async () => {
    const f = await fixture(); const w = await f.manager.acquire({projectId:'project',taskId:'orphan'});
    // setsid escapes the launched process group; its inherited marker still supplies evidence.
    const running = f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'orphan',command:"setsid sh -c 'echo $$ > escaped.pid; exec sleep 300' >/dev/null 2>&1 & sleep 0.1"});
    void running.catch(() => {});
    const pid = Number(await waitFile(join(w.path,'escaped.pid'))); cleanup.push(async()=>{try{process.kill(pid,'SIGKILL');}catch{} await running; await waitGone(pid);});
    await running;
    const result = await new ProcessSupervisor(f.ctx).stop('project'); expect(result.quiescent).toBe(false); expect(result.reason).toMatch(/descendant|escape|uncertain/i);
  });

  test('background children remain supervised after their launching shell exits', async () => {
    const f=await fixture(); const w=await f.manager.acquire({projectId:'project',taskId:'background'});
    await f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'background',command:'sleep 300 & echo $! > background.pid'});
    const pid=Number(await waitFile(join(w.path,'background.pid')));
    cleanup.push(async()=>{try{process.kill(pid,'SIGKILL');}catch{} await waitGone(pid);});
    expect(live(pid)).toBe(true);
    expect((await new ProcessSupervisor(f.ctx).stop('project')).quiescent).toBe(true); await waitGone(pid);
  });
  test('unknown same-group descendants with a cleared marker block quiescence', async () => {
    const f=await fixture(); const w=await f.manager.acquire({projectId:'project',taskId:'unknown'});
    await f.supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'unknown',command:'env -u LORECREW_PROCESS_TOKEN sleep 300 & echo $! > unknown.pid'});
    const pid=Number(await waitFile(join(w.path,'unknown.pid')));
    cleanup.push(async()=>{try{process.kill(pid,'SIGKILL');}catch{} await waitGone(pid);});
    expect((await f.supervisor.stop('project')).quiescent).toBe(false);
  });
  test('missing running identity and unavailable probe both deny quiescence', async () => {
    const f=await fixture();
    await f.ctx.store.transact(tx=>tx.put('host-process','lost',{id:'lost',projectId:'project',workspaceId:'unknown',command:'sleep 300',state:'running',token:'lost',pid:2147483647,start:'1'}));
    expect((await new ProcessSupervisor(f.ctx).stop('project')).quiescent).toBe(false);
    const unavailable=new ProcessSupervisor(f.ctx,{async snapshot(){return {processes:[],complete:false,reason:'Host visibility unavailable'};}});
    expect(await unavailable.stop('project')).toEqual({quiescent:false,reason:'Host visibility unavailable'});
  });

  test.each(['new identity','reused PID','missing baseline'] as const)('preexisting opaque host processes are unrelated, but %s blocks quiescence', async scenario => {
    const f=await fixture(); const procRoot=join(f.root,'proc'); await mkdir(procRoot);
    async function opaque(pid:number) {
      const directory=join(procRoot,String(pid)); await mkdir(directory);
      // Kernel-like identity file plus an unreadable marker source, using real filesystem I/O.
      await writeFile(join(directory,'stat'),`${pid} (opaque host service) S 1 ${pid} 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 12345 0`);
      await mkdir(join(directory,'environ'));
    }
    await opaque(500000001);
    const probe=new LinuxProcessProbe(procRoot);
    expect((await probe.snapshot()).processes[0]?.start).toBe('12345');
    const w=await f.manager.acquire({projectId:'project',taskId:'opaque'});
    const supervisor=new ProcessSupervisor(f.ctx,probe);
    await supervisor.run({contextId:await workspaceContext(f.ctx,w.id),requestId:'opaque',command:'printf done'});
    expect((await supervisor.stop('project')).quiescent).toBe(true);
    if (scenario === 'new identity') await opaque(500000002);
    if (scenario === 'reused PID') {
      const path=join(procRoot,'500000001','stat'); await writeFile(path,(await readFile(path,'utf8')).replace('12345','67890'));
    }
    if (scenario === 'missing baseline') {
      const record=(await f.ctx.store.list<HostProcessRecord>('host-process'))[0]!;
      delete record.opaqueBefore;
      await f.ctx.store.transact(tx=>tx.put('host-process',record.id,record));
    }
    const stopped=await supervisor.stop('project');
    expect(stopped.quiescent).toBe(false); expect(stopped.reason).toMatch(/opaque|visibility|uncertain/i);
  });
  test('durable launch intent with unknown PID cannot establish quiescence on restart', async () => {
    const f = await fixture();
    await f.ctx.store.transact(tx=>tx.put('host-process','interrupted',{id:'interrupted',projectId:'project',workspaceId:'unknown',command:'sleep 300',state:'launching',token:'interrupted'}));
    expect((await new ProcessSupervisor(f.ctx).stop('project')).quiescent).toBe(false);
  });
});

test('preserves a completed stop proof when an older run exit observation arrives later',async()=>{
 const f=await fixture();const workspace=await f.manager.acquire({projectId:'project',taskId:'exit-race'});const context=new AsyncLocalStorage<string>();const real=new LinuxProcessProbe();let runSnapshots=0;let reached!:()=>void;let release!:()=>void;
 const observed=new Promise<void>(resolve=>{reached=resolve;});const held=new Promise<void>(resolve=>{release=resolve;});cleanup.push(async()=>{release();});
 const supervisor=new ProcessSupervisor(f.ctx,{async snapshot(){const snapshot=await real.snapshot();if(context.getStore()==='run'&&++runSnapshots===3){reached();await held;}return snapshot;}});
 const running=context.run('run',async()=>supervisor.run({contextId:await workspaceContext(f.ctx,workspace.id),requestId:'exit-race',command:'sleep 10'}));
 await expect.poll(async()=>(await f.ctx.store.list<HostProcessRecord>('host-process'))[0]?.state).toBe('running');const stopping=supervisor.stopWorkspace(workspace.id);await observed;await expect(stopping).resolves.toMatchObject({quiescent:true});
 expect((await f.ctx.store.list<HostProcessRecord>('host-process'))[0]!.state).toBe('stopped');release();await running;
 expect((await f.ctx.store.list<HostProcessRecord>('host-process'))[0]!.state).toBe('stopped');
});
