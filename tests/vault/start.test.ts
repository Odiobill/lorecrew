import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';

const scaffold = '---\nokf_version: "0.2"\n---\n# Knowledge vault\n';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() { const f = await temporaryInstance(); cleanups.push(f.cleanup); return f; }
async function classifier() {
  const api = await import('../../src/vault/start.js').catch(() => undefined);
  expect(api, 'read-only starting-vault classifier exists').toHaveProperty('inspectVaultStart', expect.any(Function));
  return api!;
}

it.each([
  ['empty', undefined, 'new', true],
  ['git-only', undefined, 'new', true],
  ['scaffold', scaffold, 'new', false],
  ['scaffold-git', scaffold, 'new', false],
  ['custom-root', '---\nokf_version: "0.2"\n---\n# My notes\n', 'existing', false],
  ['malformed-root', '---\n[broken', 'existing', false],
  ['almost-scaffold', scaffold + '\n', 'existing', false],
  ['notes-only', undefined, 'existing', false],
  ['malformed-note', undefined, 'existing', false],
  ['binary-only', undefined, 'existing', false],
  ['empty-user-folder', undefined, 'existing', false],
  ['symlink', undefined, 'existing', false],
  ['root-symlink', undefined, 'existing', false],
  ['git-symlink', undefined, 'existing', false],
] as const)('classifies %s conservatively without writes', async (name, root, kind, needsRootIndex) => {
  const { paths, root: temp } = await fixture(), vault = paths.vaultDir;
  if (name.includes('git') && name !== 'git-symlink') await fs.mkdir(join(vault, '.git'));
  if (root !== undefined) await fs.writeFile(join(vault, 'index.md'), root);
  if (name === 'notes-only') await fs.writeFile(join(vault, 'note.md'), '# Notes only\n');
  if (name === 'malformed-note') await fs.writeFile(join(vault, 'broken.md'), '---\n[broken');
  if (name === 'binary-only') await fs.writeFile(join(vault, 'image.bin'), Buffer.from([0, 255, 1]));
  if (name === 'empty-user-folder') await fs.mkdir(join(vault, 'notes'));
  if (name.includes('symlink')) {
    const target = join(temp, 'outside'); await fs.writeFile(target, scaffold);
    await fs.symlink(target, join(vault, name === 'root-symlink' ? 'index.md' : name === 'git-symlink' ? '.git' : 'link'));
  }
  const entries = await fs.readdir(vault), before = new Map<string, Buffer | string>();
  for (const entry of entries) { const path = join(vault, entry), s = await fs.lstat(path); if (s.isSymbolicLink()) before.set(entry, await fs.readlink(path)); else if (s.isFile()) before.set(entry, await fs.readFile(path)); }
  const api = await classifier();
  expect(await api.inspectVaultStart(vault)).toEqual({ kind, needsRootIndex });
  expect(await fs.readdir(vault)).toEqual(entries);
  for (const [entry, bytes] of before) expect(typeof bytes === 'string' ? await fs.readlink(join(vault, entry)) : await fs.readFile(join(vault, entry))).toEqual(bytes);
});

it('propagates filesystem denial rather than treating unreadable content as empty', async () => {
  const f = await fixture(), api = await classifier();
  await fs.chmod(f.paths.vaultDir, 0);
  try { await expect(api.inspectVaultStart(f.paths.vaultDir)).rejects.toMatchObject({ code: 'EACCES' }); }
  finally { await fs.chmod(f.paths.vaultDir, 0o700); }
});
