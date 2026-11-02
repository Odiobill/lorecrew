import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from '../contracts/base.js';

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), path.slice(parent.length));
  }
}

/** Validate placement without creating state or requiring a relocated vault to exist yet. */
export async function validateStatePlacement(paths: { stateDir: string; vaultDir: string }): Promise<{ stateDir: string; vaultDir: string }> {
  const stateDir = await canonicalPath(resolve(paths.stateDir));
  const vaultDir = await canonicalPath(resolve(paths.vaultDir));
  const rel = relative(vaultDir, stateDir);
  if (rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) {
    throw new AppError('INVALID_STATE_DIR', 'Operational state must live outside the vault');
  }
  await validatePrivateStatePlacement(stateDir);
  return { stateDir, vaultDir };
}

/** Canonical private-state validation, independent of any vault binding. */
export async function validatePrivateStatePlacement(path:string):Promise<string> {
  const stateDir=await canonicalPath(resolve(path));
  for (let parent = stateDir; ; parent = dirname(parent)) {
    try {
      const marker = join(parent, '.git');
      const metadata = await lstat(marker);
      let worktree = false;
      if (metadata.isDirectory()) {
        try { worktree = (await stat(join(marker, 'HEAD'))).isFile(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      } else if (metadata.isFile()) {
        worktree = /^gitdir:\s*\S+/m.test(await readFile(marker, 'utf8'));
      }
      if (worktree) throw new AppError('INVALID_STATE_DIR', 'Operational state must live outside project worktrees');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (dirname(parent) === parent) break;
  }
  return stateDir;
}
