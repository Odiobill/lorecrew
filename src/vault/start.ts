import {readVaultIdentity} from '../repositories/identity.js';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const INITIAL_VAULT_INDEX = '---\nokf_version: "0.2"\n---\n# Knowledge vault\n';

/** Recognition only: preserve unknown content and propagate unreadable-vault errors. */
export async function inspectVaultStart(vaultDir: string): Promise<{ kind: 'new' | 'existing'; needsRootIndex: boolean }> {
  const existing = { kind: 'existing' as const, needsRootIndex: false };
  if (!(await lstat(vaultDir)).isDirectory()) return existing;
  const entries = await readdir(vaultDir);
  let hasIndex = false;
  for (const entry of entries) {
    const path = join(vaultDir, entry), stat = await lstat(path);
    if (stat.isSymbolicLink()) return existing;
    if(entry==='.lorecrew'&&stat.isDirectory()&&(await readdir(path)).length===1&&(await readdir(path))[0]==='vault.json'){try{await readVaultIdentity(vaultDir);continue;}catch{return existing;}}
    if (entry === '.git' && (stat.isDirectory() || stat.isFile())) continue;
    if (entry !== 'index.md' || !stat.isFile()) return existing;
    // Do not follow a link substituted between lstat and open, or block on a FIFO.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await file.stat()).isFile() || !(await file.readFile()).equals(Buffer.from(INITIAL_VAULT_INDEX))) return existing;
    } finally { await file.close(); }
    hasIndex = true;
  }
  return { kind: 'new', needsRootIndex: !hasIndex };
}
