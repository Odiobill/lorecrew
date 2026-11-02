import { link, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { AppError } from '../contracts/base.js';
interface Owner { pid: number; instanceId: string; token: string }
const busy = () => new AppError('INSTANCE_BUSY', 'Instance has an active or ambiguous lock owner; explicit recovery is required for ambiguous metadata');
function parseOwner(text: string): Owner {
  const owner: Owner = JSON.parse(text);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.instanceId !== 'string' || !owner.instanceId || typeof owner.token !== 'string' || !owner.token) throw busy();
  return owner;
}
async function ownerAt(path: string): Promise<Owner> {
  try { return parseOwner(await readFile(join(path, 'owner.json'), 'utf8')); }
  catch { throw busy(); }
}
function positivelyDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
export async function acquireLock(stateDir: string, instanceId: string) {
  const path = join(stateDir, 'instance.lock');
  const transitionPath = join(stateDir, 'instance.lock-recovery');
  const owner: Owner = { pid: process.pid, instanceId, token: randomUUID() };
  // Every ownership transition uses one exclusive, atomically published metadata file.
  // A stranded/ambiguous transition needs explicit recovery; there is no elapsed-time takeover.
  async function transition<T>(wait: boolean, fn: () => Promise<T>): Promise<T> {
    const prepared = join(stateDir, `.lock-transition-${randomUUID()}`);
    let acquired = false;
    await writeFile(prepared, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
    try {
      for (;;) {
        try { await link(prepared, transitionPath); acquired = true; break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (!wait) throw busy();
          let holder: Owner | undefined;
          try { holder = parseOwner(await readFile(transitionPath, 'utf8')); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EISDIR') holder = await ownerAt(transitionPath); // Legacy gate remains fail-closed.
            else if (code !== 'ENOENT') throw busy();
          }
          if (holder && positivelyDead(holder.pid)) throw busy();
          await setTimeout(5);
        }
      }
      return await fn();
    } finally {
      if (acquired) await unlink(transitionPath);
      await unlink(prepared);
    }
  }
  await transition(false, async () => {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!positivelyDead((await ownerAt(path)).pid)) throw busy();
      await rm(path, { recursive: true });
      await mkdir(path, { mode: 0o700 });
    }
    try { await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { flag: 'wx', mode: 0o600 }); }
    catch (error) { await rm(path, { recursive: true }); throw error; }
  });
  const assertOwner = async () => { if ((await ownerAt(path)).token !== owner.token) throw busy(); };
  return {
    identify: (id: string) => transition(true, async () => {
      await assertOwner(); owner.instanceId = id;
      await writeFile(join(path, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
    }),
    release: () => transition(true, async () => { await assertOwner(); await rm(path, { recursive: true }); }),
  };
}
