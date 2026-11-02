import {gitProject} from '../helpers/git-project.js';
import { workspaceContext } from '../helpers/execution.js';
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { gitFleet, realGit } from '../helpers/git-fleet.js';
import { openInstance, type InstanceContext } from '../../src/instance/open.js';
import { initFleet, openOwnership } from '../../src/projects/ownership.js';
import { bindProject } from '../../src/projects/bindings.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const project = { id: 'engine', repositoryKey: 'fork:engine', title: 'Engine' };
async function setup() {
  const f = await gitFleet(); cleanups.push(f.cleanup);
  await initFleet(f.a.ctx, f.a.git, 'origin');
  const aOwner = openOwnership(f.a.ctx, f.a.git, 'origin'); const bOwner = openOwnership(f.b.ctx, f.b.git, 'origin');
  const initial = await aOwner.claim(project, 'initial');
  return { ...f, aOwner, bOwner, initial, request: { projectId: project.id, expectedGeneration: 1, targetInstanceId: f.b.ctx.instanceId, requestId: 'move-engine' } };
}
async function handoff(input: Parameters<typeof import('../../src/projects/handoff.js').handoffProject>[0]) {
  return (await import('../../src/projects/handoff.js')).handoffProject(input);
}
const stopped = { async stopAndProve() { return { quiescent: true }; } };
async function reopen(ctx: InstanceContext) {
  await ctx.close();
  const reopened = await openInstance({ stateDir: ctx.stateDir, vaultDir: ctx.vaultDir }); cleanups.push(() => reopened.close()); return reopened;
}

describe('durable explicit project handoff', () => {
  it('closes admission before probing and leaves the remote grant unchanged when a child is uncertain', async () => {
    const f = await setup();
    await expect(handoff({ ownership: f.aOwner, ...f.request, probe: { async stopAndProve() {
      await expect(f.aOwner.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
      expect(await f.readAssignments()).toEqual([f.initial]);
      return { quiescent: false, reason: 'escaped child' };
    } } })).rejects.toMatchObject({ code: 'NOT_QUIESCENT' });
    expect(await f.readAssignments()).toEqual([f.initial]);
    const ctx = await reopen(f.a.ctx);
    await expect(openOwnership(ctx, f.a.git, 'origin').assertOwner('engine', 1)).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    await expect(f.bOwner.acceptGrant('engine')).rejects.toBeDefined();
  });

  it('persists revocation across a crash before push and refuses to resurrect it through claim or acceptance', async () => {
    const f = await setup();
    await f.aOwner.revokeLocal('engine', 1);
    expect(await f.readAssignments()).toEqual([f.initial]);
    const ctx = await reopen(f.a.ctx); const a = openOwnership(ctx, f.a.git, 'origin');
    await expect(a.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    await a.claim(project, 'initial');
    await expect(a.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    await bindProject(ctx, { projectId: 'engine', path:await gitProject(join(f.root,ctx.instanceId+'-code')) });
    await expect(a.acceptGrant('engine')).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    await f.disconnect();
    await expect(a.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
  });

  it('does not treat standalone revocation as proof of quiescence, including after restart', async () => {
    const f = await setup(); await f.aOwner.revokeLocal('engine', 1);
    const uncertain = { async stopAndProve() { return { quiescent: false, reason: 'active or uncertain child' }; } };
    await expect(handoff({ ownership: f.aOwner, probe: uncertain, ...f.request })).rejects.toMatchObject({ code: 'NOT_QUIESCENT' });
    expect(await f.readAssignments()).toEqual([f.initial]);
    const ctx = await reopen(f.a.ctx); const a = openOwnership(ctx, f.a.git, 'origin');
    await expect(handoff({ ownership: a, probe: uncertain, ...f.request })).rejects.toMatchObject({ code: 'NOT_QUIESCENT' });
    expect(await f.readAssignments()).toEqual([f.initial]);
    await expect(a.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    expect((await handoff({ ownership: a, probe: stopped, ...f.request })).generation).toBe(2);
  });

  it('refuses direct publication of a revoked transition without a durable quiescence proof', async () => {
    const f = await setup();
    const request = { projectId: 'engine', expectedGeneration: 1, targetInstanceId: f.b.ctx.instanceId, transitionId: 'without-proof' };
    await f.aOwner.closeAdmission(request); await f.aOwner.revokeLocal('engine', 1);
    await expect(f.aOwner.publishTransfer(request)).rejects.toMatchObject({ code: 'NOT_QUIESCENT' });
    expect(await f.readAssignments()).toEqual([f.initial]);
  });

  it('publishes generation two only after revocation and requires a target workspace binding to accept', async () => {
    const f = await setup();
    const git = { async run(cwd: string, args: string[]) {
      if (args.includes('push')) await expect(f.aOwner.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
      return f.a.git.run(cwd, args);
    } };
    const a = openOwnership(f.a.ctx, git, 'origin');
    const grant = await handoff({ ownership: a, probe: stopped, ...f.request });
    expect(grant).toMatchObject({ generation: 2, ownerId: f.b.ctx.instanceId });
    expect(await f.readAssignments()).toEqual([grant]);
    await expect(f.bOwner.acceptGrant('engine')).rejects.toMatchObject({ code: 'PROJECT_NOT_BOUND' });
    await expect(f.bOwner.assertOwner('engine', 2)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await bindProject(f.b.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.b.ctx.instanceId+'-code')) });
    expect(await f.bOwner.acceptGrant('engine')).toEqual(grant);
    await f.disconnect();
    await expect(f.bOwner.assertOwner('engine', 2)).resolves.toBeUndefined();
    await expect(f.aOwner.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
  });

  it('retains revoked state when transport fails before push and retries the same transition after restart', async () => {
    const f = await setup(); let fail = true;
    const git = { async run(cwd: string, args: string[]) {
      if (fail && args.includes('push')) return { stdout: '', stderr: 'offline', exitCode: 128 };
      return f.a.git.run(cwd, args);
    } };
    const a = openOwnership(f.a.ctx, git, 'origin');
    await expect(handoff({ ownership: a, probe: stopped, ...f.request })).rejects.toMatchObject({ code: 'ASSIGNMENT_UNCONFIRMED' });
    expect(await f.readAssignments()).toEqual([f.initial]);
    const pending = await a.inspectHandoff('engine'); expect(pending).toMatchObject({ phase: 'revoked', expectedGeneration: 1 });
    const ctx = await reopen(f.a.ctx); const reopened = openOwnership(ctx, git, 'origin');
    await expect(reopened.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    fail = false;
    // A successful pre-revocation proof is durable, so a receipt retry need not stop work again.
    const grant = await handoff({ ownership: reopened, probe: { async stopAndProve() { return { quiescent: false }; } }, ...f.request });
    expect(grant.transitionId).toBe(pending?.transitionId);
    expect(grant.generation).toBe(2);
  });

  it('fetches the committed outcome after a lost push receipt and never increments again on retry', async () => {
    const f = await setup(); f.a.loseNextPushAck();
    const grant = await handoff({ ownership: f.aOwner, probe: stopped, ...f.request });
    const head = (await realGit(f.remote, ['rev-parse', 'refs/heads/lorecrew/assignments'])).stdout;
    expect(await handoff({ ownership: f.aOwner, probe: stopped, ...f.request })).toEqual(grant);
    expect((await realGit(f.remote, ['rev-parse', 'refs/heads/lorecrew/assignments'])).stdout).toBe(head);
    expect(await f.aOwner.inspectHandoff('engine')).toMatchObject({ phase: 'published', assignment: grant });
  });

  it('keeps the old generation revoked after push succeeds without confirmation and recovers by fetch after restart', async () => {
    const f = await setup(); f.a.loseNextPushAck(true);
    await expect(handoff({ ownership: f.aOwner, probe: stopped, ...f.request })).rejects.toBeDefined();
    const [published] = await f.readAssignments(); expect(published?.generation).toBe(2);
    const ctx = await reopen(f.a.ctx); const a = openOwnership(ctx, f.a.git, 'origin');
    await expect(a.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    await bindProject(f.b.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.b.ctx.instanceId+'-code')) });
    await expect(f.bOwner.acceptGrant('engine')).rejects.toBeDefined();
    await f.reconnect(); expect(await f.bOwner.acceptGrant('engine')).toEqual(published);
    expect(await handoff({ ownership: a, probe: stopped, ...f.request })).toEqual(published);
  });

  it('rejects stale generations, reused request identities, self-transfers, and publication without revocation', async () => {
    const f = await setup();
    await expect(handoff({ ownership: f.aOwner, probe: stopped, ...f.request, expectedGeneration: 2 })).rejects.toMatchObject({ code: 'STALE_GENERATION' });
    await expect(handoff({ ownership: f.aOwner, probe: stopped, ...f.request, targetInstanceId: f.a.ctx.instanceId })).rejects.toMatchObject({ code: 'INVALID_TRANSFER' });
    await expect(f.aOwner.publishTransfer({ projectId: 'engine', expectedGeneration: 1, targetInstanceId: f.b.ctx.instanceId, transitionId: 'unrevoked' })).rejects.toMatchObject({ code: 'OWNER_NOT_REVOKED' });
    await expect(handoff({ ownership: f.aOwner, ...f.request, probe: { async stopAndProve() { return { quiescent: false }; } } })).rejects.toMatchObject({ code: 'NOT_QUIESCENT' });
    await expect(handoff({ ownership: f.aOwner, probe: stopped, ...f.request, requestId: 'different' })).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    expect(await f.readAssignments()).toEqual([f.initial]);
  });

  it('blocks workspace acquisition and process launch while a failed handoff remains closed', async () => {
    const f = await setup(); await bindProject(f.a.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.a.ctx.instanceId+'-code')) });
    const manager = new WorkspaceManager(f.a.ctx); const workspace = await manager.acquireLead('engine');
    await expect(handoff({ ownership: f.aOwner, ...f.request, probe: { async stopAndProve() { return { quiescent: false }; } } })).rejects.toMatchObject({ code: 'NOT_QUIESCENT' });
    await expect(manager.acquire({ projectId: 'engine', taskId: 'late' })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
    const supervisor = new ProcessSupervisor(f.a.ctx, { async snapshot() { return { complete: true, processes: [] }; } });
    await expect(supervisor.run({contextId:await workspaceContext(f.a.ctx,workspace.id), command: 'true', requestId: 'late' })).rejects.toMatchObject({ code: 'ADMISSION_CLOSED' });
  });

  it('supports a later grant back at generation three without reviving generation one', async () => {
    const f = await setup();
    await bindProject(f.b.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.b.ctx.instanceId+'-code')) });
    await bindProject(f.a.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.a.ctx.instanceId+'-code')) });
    await handoff({ ownership: f.aOwner, probe: stopped, ...f.request }); await f.bOwner.acceptGrant('engine');
    await handoff({ ownership: f.bOwner, probe: stopped, projectId: 'engine', expectedGeneration: 2, targetInstanceId: f.a.ctx.instanceId, requestId: 'return' });
    expect((await f.aOwner.acceptGrant('engine')).generation).toBe(3);
    await expect(f.aOwner.assertOwner('engine', 3)).resolves.toBeUndefined();
    await expect(f.aOwner.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
  });

  it('can hand off a later accepted grant even when the original transfer receipt was never recovered', async () => {
    const f = await setup();
    await bindProject(f.a.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.a.ctx.instanceId+'-code')) });
    await bindProject(f.b.ctx, { projectId: 'engine', path:await gitProject(join(f.root,f.b.ctx.instanceId+'-code')) });
    f.a.loseNextPushAck(true);
    await expect(handoff({ ownership: f.aOwner, probe: stopped, ...f.request })).rejects.toBeDefined();
    await f.reconnect(); await f.bOwner.acceptGrant('engine');
    await handoff({ ownership: f.bOwner, probe: stopped, projectId: 'engine', expectedGeneration: 2, targetInstanceId: f.a.ctx.instanceId, requestId: 'return' });
    await f.aOwner.acceptGrant('engine');
    const next = await handoff({ ownership: f.aOwner, probe: stopped, ...f.request, expectedGeneration: 3, requestId: 'again' });
    expect(next).toMatchObject({ generation: 4, ownerId: f.b.ctx.instanceId });
    await expect(f.aOwner.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
    await expect(f.aOwner.assertOwner('engine', 3)).rejects.toMatchObject({ code: 'OWNER_REVOKED' });
  });

  it('refuses obsolete CLI transfer flags and unknown legacy authority without mutating the old assignment', async () => {
    const f = await setup(); const { runCli } = await import('../../src/cli.js');
    await f.a.ctx.close(); await f.b.ctx.close();
    await expect(runCli(['project','handoff','--state-dir',f.a.ctx.stateDir,'--id','engine','--generation','1','--target-instance',f.b.ctx.instanceId,'--request-id','cli'])).rejects.toMatchObject({code:'USAGE'});
    expect(await f.readAssignments()).toEqual([f.initial]);
    await expect(runCli(['project','accept','--state-dir',f.b.ctx.stateDir,'--id','engine'])).rejects.toMatchObject({code:'USAGE'});
    expect(await f.readAssignments()).toEqual([f.initial]);
  });
});
