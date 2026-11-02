import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function temporaryInstance() {
  const root = await mkdtemp(join(tmpdir(), 'lorecrew-test-'));
  const stateDir = join(root, 'state');
  const vaultDir = join(root, 'vault');
  await mkdir(vaultDir);
  return { root, paths: { stateDir, vaultDir }, cleanup: () => rm(root, { recursive: true, force: true }) };
}
