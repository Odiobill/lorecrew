import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInstance, type InstanceContext } from '../../src/instance/open.js';
import type { Assignment } from '../../src/projects/types.js';

import {GitClient,type GitRunOptions} from '../../src/git/client.js';
import {openState} from '../../src/instance/state.js';
import {planVaultIdentity} from '../../src/repositories/identity.js';
import {openRepositories} from '../../src/repositories/service.js';
export async function realGit(cwd:string,args:string[],options:GitRunOptions={}){return new GitClient().run(cwd,args,options);}
async function must(cwd: string, args: string[]) {
  const result = await realGit(cwd,args);
  if (result.exitCode) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
export async function gitFleet() {
  const root = await mkdtemp(join(tmpdir(), 'lorecrew-fleet-'));
  const remote = join(root, 'remote.git');
  const contexts: InstanceContext[] = [];
  let offline = false;
  let pushBarrier: { remaining: number; ready: Promise<void>; release(): void } | undefined;
  await must(root, ['init', '--bare', '--initial-branch=main', remote]);
  await must(remote, ['config', 'receive.denyNonFastForwards', 'true']);
  await must(remote, ['config', 'receive.denyDeletes', 'true']);
  const seed = join(root, 'seed');
  const seedState=await openState({stateDir:join(root,'seed-state')});try{const identity=await planVaultIdentity(seedState,seed,'seed');await openRepositories({state:seedState,git:new GitClient()}).create({repo:{kind:'vault',id:identity.vaultId,path:seed},parentPath:root,folderName:'seed',scaffold:[{path:'index.md',content:'---\nokf_version: "0.2"\n---\n# Fleet knowledge\n'},{path:'.lorecrew/vault.json',content:JSON.stringify(identity)+'\n'}]},'seed-create');}finally{await seedState.close();}await must(seed,['remote','add','origin',remote]);
  await must(seed, ['config', 'user.name', 'Fleet fixture']); await must(seed, ['config', 'user.email', 'fixture@example.test']);
  await writeFile(join(seed, 'index.md'), '---\nokf_version: "0.2"\n---\n# Fleet knowledge\n');
  await must(seed, ['add', 'index.md']); await must(seed, ['commit', '--allow-empty','-m', 'knowledge']); await must(seed, ['push', 'origin', 'main']);
  async function device(name: string) {
    const vaultDir = join(root, name); await must(root, ['clone', remote, vaultDir]);
    const ctx = await openInstance({ stateDir: join(root, `${name}-state`), vaultDir }); contexts.push(ctx);
    let loseAck = false; let disconnectAfterPush = false; let remoteFetches = 0;
    const git = { async run(cwd:string,args:string[],options:GitRunOptions={}) {
      const transport = args.some(arg=>['fetch','push','ls-remote'].includes(arg));
      if (offline && transport) return { stdout: '', stderr: 'transport disconnected', exitCode: 128 };
      if (args.includes('fetch')) remoteFetches++;
      if (args.includes('push') && pushBarrier) {
        const barrier = pushBarrier;
        if (--barrier.remaining === 0) { pushBarrier = undefined; barrier.release(); }
        await barrier.ready;
      }
      const result = await realGit(cwd,args,options);
      if (args.includes('push') && result.exitCode === 0 && loseAck) {
        loseAck = false; if (disconnectAfterPush) offline = true;
        return { stdout: '', stderr: 'connection closed after send', exitCode: 128 };
      }
      return result;
    } };
    return { ctx, git, loseNextPushAck(disconnect = false) { loseAck = true; disconnectAfterPush = disconnect; }, get remoteFetches() { return remoteFetches; } };
  }
  const a = await device('a'); const b = await device('b');
  return { root, remote, a, b,
    raceNextPushes(count = 2) { let release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; }); pushBarrier = { remaining: count, ready, release }; },
    async disconnect() { offline = true; }, async reconnect() { offline = false; },
    async readAssignments(): Promise<Assignment[]> {
      const text = await must(remote, ['show', 'refs/heads/lorecrew/assignments:control.json']);
      return (JSON.parse(text) as { assignments: Assignment[] }).assignments;
    },
    async cleanup() { for (const ctx of contexts) await ctx.close(); await rm(root, { recursive: true, force: true }); },
  };
}
