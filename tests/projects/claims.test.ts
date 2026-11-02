import { afterEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet, realGit } from '../helpers/git-fleet.js';
import { openInstance } from '../../src/instance/open.js';
import { GitClient } from '../../src/git/client.js';

const ownershipModule = () => import('../../src/projects/ownership.js');
const registryModule = () => import('../../src/projects/registry.js');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const project = { id: 'engine', repositoryKey: 'https://github.com/lorecrew/engine.git', title: 'Engine' };
async function fleet() { const f = await gitFleet(); cleanups.push(f.cleanup); return f; }
async function initialized() {
  const f = await fleet();
  const { initFleet, openOwnership } = await ownershipModule();
  await initFleet(f.a.ctx, f.a.git, 'origin');
  return { ...f, aOwner: openOwnership(f.a.ctx, f.a.git, 'origin'), bOwner: openOwnership(f.b.ctx, f.b.git, 'origin') };
}

describe('Git assignment authority', () => {
  it.each([0, 1, 2])('admits exactly one owner in a deterministic race %i and keeps only that grant offline', async () => {
    const f = await initialized(); f.raceNextPushes();
    const results = await Promise.allSettled([f.aOwner.claim(project, 'a'), f.bOwner.claim(project, 'b')]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await f.readAssignments()).filter(x => x.projectId === project.id)).toHaveLength(1);
    const aWon = results[0]?.status === 'fulfilled';
    const winner = aWon ? f.aOwner : f.bOwner; const loser = aWon ? f.bOwner : f.aOwner;
    await f.disconnect();
    await expect(winner.assertOwner(project.id, 1)).resolves.toBeUndefined();
    await expect(winner.assertOwner(project.id, 2)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await expect(loser.assertOwner(project.id, 1)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await expect(loser.claim(project, 'retry')).rejects.toBeDefined();
  });
  it('fetches the remote after a lost successful push acknowledgment before admitting and retries idempotently', async () => {
    const f = await initialized(); f.a.loseNextPushAck(); const before = f.a.remoteFetches;
    const grant = await f.aOwner.claim(project, 'lost');
    expect(f.a.remoteFetches - before).toBeGreaterThanOrEqual(2);
    expect(grant).toMatchObject({ projectId: 'engine', repositoryKey: 'repo:github.com/lorecrew/engine', generation: 1, ownerId: f.a.ctx.instanceId });
    expect(await f.readAssignments()).toEqual([grant]);
    expect(await f.aOwner.claim(project, 'lost')).toEqual(grant);
  });
  it('does not admit an unconfirmed successful push, and can recover it after reconnect and restart', async () => {
    const f = await initialized(); f.a.loseNextPushAck(true);
    await expect(f.aOwner.claim(project, 'uncertain')).rejects.toBeDefined();
    expect(await f.readAssignments()).toHaveLength(1);
    await expect(f.aOwner.assertOwner(project.id, 1)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await f.a.ctx.close();
    const ctx = await openInstance({ stateDir: f.a.ctx.stateDir, vaultDir: f.a.ctx.vaultDir }); cleanups.push(() => ctx.close());
    const recovered = (await ownershipModule()).openOwnership(ctx, f.a.git, 'origin');
    await expect(recovered.assertOwner(project.id, 1)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await f.reconnect();
    const grant = await recovered.claim(project, 'uncertain');
    expect(grant.ownerId).toBe(ctx.instanceId);
    await f.disconnect(); await expect(recovered.assertOwner(project.id, 1)).resolves.toBeUndefined();
  });
  it('retains a confirmed grant across restart without network access', async () => {
    const f = await initialized(); await f.aOwner.claim(project, 'persist'); await f.a.ctx.close(); await f.disconnect();
    const ctx = await openInstance({ stateDir: f.a.ctx.stateDir, vaultDir: f.a.ctx.vaultDir }); cleanups.push(() => ctx.close());
    await expect((await ownershipModule()).openOwnership(ctx, f.a.git, 'origin').assertOwner(project.id, 1)).resolves.toBeUndefined();
  });
  it('does not create a second project for equivalent repository keys', async () => {
    const f = await initialized(); await f.aOwner.claim(project, 'first');
    await expect(f.bOwner.claim({ ...project, id: 'duplicate', repositoryKey: 'git@github.com:lorecrew/engine.git' }, 'duplicate')).rejects.toMatchObject({ code: 'REPOSITORY_REGISTERED' });
    expect(await f.readAssignments()).toHaveLength(1);
  });
  it('recomputes a rejected push to preserve claims for different repositories', async () => {
    const f = await initialized(); f.raceNextPushes();
    const grants = await Promise.all([f.aOwner.claim(project, 'first'), f.bOwner.claim({ id: 'other', title: 'Other', repositoryKey: 'fork:independent-engine' }, 'second')]);
    expect(await f.readAssignments()).toEqual(expect.arrayContaining(grants));
    expect(await f.readAssignments()).toHaveLength(2);
  });
  it('does not grant authority through a Markdown projection or the knowledge main branch', async () => {
    const f = await initialized();
    await writeFile(join(f.b.ctx.vaultDir, 'projects.md'), `---\nownerId: ${f.b.ctx.instanceId}\nprojectId: engine\ngeneration: 1\n---\n`);
    await expect(f.bOwner.assertOwner('engine', 1)).rejects.toMatchObject({ code: 'NOT_OWNER' });
    await f.disconnect(); await expect(f.bOwner.claim(project, 'offline')).rejects.toBeDefined();
  });
  it('initializes an orphan branch without changing main, is idempotent, and requires initialization', async () => {
    const f = await fleet(); const { initFleet, openOwnership } = await ownershipModule();
    await expect(openOwnership(f.a.ctx, f.a.git, 'origin').claim(project, 'early')).rejects.toMatchObject({ code: 'FLEET_NOT_INITIALIZED' });
    const before = (await realGit(f.remote, ['rev-parse', 'main'])).stdout;
    await initFleet(f.a.ctx, f.a.git, 'origin'); await initFleet(f.b.ctx, f.b.git, 'origin');
    expect(await f.readAssignments()).toEqual([]);
    expect((await realGit(f.remote, ['rev-list', '--parents', 'refs/heads/lorecrew/assignments'])).stdout.trim().split(/\s+/)).toHaveLength(1);
    expect((await realGit(f.remote, ['rev-parse', 'main'])).stdout).toBe(before);
  });
  it('requires confirmed domain adoption before obsolete fleet and project CLI mutations', async () => {
    const f = await fleet(); await f.a.ctx.close(); const { runCli } = await import('../../src/cli.js');
    await expect(runCli(['fleet', 'init', '--state-dir', f.a.ctx.stateDir, '--remote', 'origin'])).rejects.toMatchObject({code:'AUTHORITY_NOT_LOCAL'});
    await expect(runCli(['project', 'claim', '--state-dir', f.a.ctx.stateDir, '--id', 'engine', '--repository', project.repositoryKey, '--title', 'Engine', '--request-id', 'cli','--remote','origin'])).rejects.toMatchObject({code:'AUTHORITY_NOT_LOCAL'});
  });
  it('does not treat an existing project ID as a different repository', async () => {
    const f = await initialized(); await f.aOwner.claim(project, 'first');
    await expect(f.aOwner.claim({ ...project, repositoryKey: 'fork:different' }, 'different')).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    expect(await f.readAssignments()).toHaveLength(1);
  });
  it('refuses a different assignment remote after a confirmed fleet binding', async () => {
    const f = await initialized();
    const { openOwnership } = await ownershipModule();
    await expect(openOwnership(f.a.ctx, f.a.git, join(f.root, 'other.git')).claim(project, 'wrong-fleet')).rejects.toMatchObject({ code: 'FLEET_MISMATCH' });
    expect(await f.readAssignments()).toHaveLength(0);
  });
  it('does not emit a second claim event when retrying an already confirmed request', async () => {
    const f = await initialized(); await f.aOwner.claim(project, 'same'); await f.aOwner.claim(project, 'same');
    expect((await f.a.ctx.store.events(0)).filter(event => event.kind === 'project.claimed')).toHaveLength(1);
  });
});

it('normalizes HTTPS and SSH identity and requires an explicit identity for ambiguous repositories', async () => {
  const { canonicalRepositoryKey } = await registryModule();
  for (const value of ['https://GitHub.com/lorecrew/engine.git', 'git@github.com:lorecrew/engine.git', 'ssh://git@github.com/lorecrew/engine.git', 'repo:github.com/lorecrew/engine']) expect(canonicalRepositoryKey(value)).toBe('repo:github.com/lorecrew/engine');
  expect(canonicalRepositoryKey('fork:my-engine')).toBe('fork:my-engine');
  for (const value of ['/tmp/engine', '../engine', 'engine', 'https://example.test/engine', 'https://github.com/a/../engine', 'https://user:secret@github.com/a/b', 'https://github.com/a/b/tree/main', 'git@bitbucket.org:a/b/src/main']) expect(() => canonicalRepositoryKey(value)).toThrow();
});

it('rejects GitLab browser routes while retaining valid nested repository namespaces', async () => {
  const { canonicalRepositoryKey } = await registryModule();
  for (const value of ['https://gitlab.com/group/subgroup/engine.git', 'git@gitlab.com:group/subgroup/engine.git', 'ssh://git@gitlab.com/group/subgroup/engine.git', 'repo:gitlab.com/group/subgroup/engine']) {
    expect(canonicalRepositoryKey(value)).toBe('repo:gitlab.com/group/subgroup/engine');
  }
  for (const value of ['https://gitlab.com/group/engine/-/tree/main', 'git@gitlab.com:group/engine/-/tree/main', 'ssh://git@gitlab.com/group/engine/-/issues', 'repo:gitlab.com/group/subgroup/engine/-/tree/main']) {
    expect(() => canonicalRepositoryKey(value)).toThrow(expect.objectContaining({ code: 'AMBIGUOUS_REPOSITORY' }));
  }
});

it('runs Git arguments literally in the supplied directory despite inherited Git location variables', async () => {
  const f = await fleet(); const git = new GitClient();
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = f.remote;
  try {
    const result = await git.run(f.a.ctx.vaultDir, ['rev-parse', '--show-toplevel']);
    expect(result.exitCode).toBe(0); expect(result.stdout.trim()).toBe(f.a.ctx.vaultDir);
  } finally { if (saved === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved; }
  const literal = 'literal; $(this-is-not-a-command)';
  expect((await git.run(f.a.ctx.vaultDir, ['config', 'lorecrew.literal', literal])).exitCode).toBe(0);
  expect((await realGit(f.a.ctx.vaultDir, ['config', '--get', 'lorecrew.literal'])).stdout.trim()).toBe(literal);
});
