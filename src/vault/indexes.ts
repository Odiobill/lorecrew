import { lstat, readdir, realpath, readFile } from 'node:fs/promises';
import { join, relative, isAbsolute, sep, dirname, posix } from 'node:path';
import { AppError, type Json } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import { parseConcept, validatePath } from './parse.js';
import type { Concept, VaultDiagnostic } from './types.js';

const within = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)); };
/** Reject symlinks altogether: this also prevents alias cycles and duplicate publications. */
export async function safePath(root: string, path: string): Promise<string> {
  validatePath(path);
  if (await realpath(root) !== root) throw new AppError('UNSAFE_PATH', 'Vault root changed');
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink() || !within(root, await realpath(current))) throw new AppError('UNSAFE_PATH', 'Symlinks are not supported in vault document paths', {path});
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return current;
}
export const diagnostic = (code: string, severity: VaultDiagnostic['severity'], message: string, remediation: string): VaultDiagnostic => ({code, severity, message, remediation});
export async function scanVault(root: string): Promise<{concepts: Concept[]; diagnostics: VaultDiagnostic[]}> {
  const concepts: Concept[] = []; const diagnostics: VaultDiagnostic[] = [];
  async function walk(dir: string) {
    for (const entry of await readdir(join(root, dir), {withFileTypes:true})) {
      if (entry.name === '.git') continue;
      const path = posix.join(dir, entry.name);
      if (entry.isSymbolicLink()) { diagnostics.push(diagnostic('UNSAFE_PATH', 'error', `Unsupported symlink: ${path}`, 'Replace the symlink with an ordinary file or directory inside the vault.')); continue; }
      if (entry.isDirectory()) { await safePath(root, posix.join(path, 'index.md')); await walk(path); }
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        try { concepts.push(parseConcept(path, await readFile(await safePath(root, path), 'utf8'))); }
        catch (error) { diagnostics.push(diagnostic(error instanceof AppError ? error.code : 'VAULT_IO', 'error', `Cannot read OKF document: ${path}`, 'Repair the frontmatter or file path; keep the original content.')); }
      }
    }
  }
  await walk(''); return {concepts, diagnostics};
}
export function stableId(concept: Concept): string | undefined {
  const extension = concept.metadata.lorecrew;
  return extension && typeof extension === 'object' && !Array.isArray(extension) && typeof extension.id === 'string' && extension.id.trim() ? extension.id : undefined;
}
export function assertUniqueIds(concepts: Concept[]): void {
  const ids = new Set<string>();
  for (const concept of concepts) { const id = stableId(concept); if (!id) continue; if (ids.has(id)) throw new AppError('DUPLICATE_ID', 'Duplicate Lorecrew stable ID', {id}); ids.add(id); }
}
const secretKey = /^(api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|client[-_]?secret|password|authorization|credential)$/i;
export function containsCredentials(value: unknown): boolean {
  if (typeof value === 'string') return /\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|[a-z]+:\/\/[^\s/@:]+:[^\s/@]+@)/i.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => {
    if (secretKey.test(key) && item !== null && item !== '') {
      const binding = typeof item === 'string' && /^(?:env|binding|credential):[A-Za-z_][A-Za-z0-9_.-]*$/.test(item);
      const reference = item && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 1 && (typeof item.env === 'string' || typeof item.binding === 'string');
      if (!binding && !reference) return true;
    }
    return containsCredentials(item);
  });
}
export async function diagnoseVault(ctx: InstanceContext): Promise<VaultDiagnostic[]> {
  const {concepts, diagnostics} = await scanVault(ctx.vaultDir);
  const {agentDefinition, groupDefinition} = await import('../agents/resolve.js');
  if (!concepts.some(c => c.path === 'index.md')) diagnostics.push(diagnostic('ROOT_INDEX_MISSING', 'error', 'The vault needs a valid OKF 0.2 root index.', 'Add index.md with okf_version: "0.2" frontmatter.'));
  try { assertUniqueIds(concepts); } catch { diagnostics.push(diagnostic('DUPLICATE_ID', 'error', 'Stable IDs must be unique across the vault.', 'Give each portable definition a unique lorecrew.id.')); }
  for (const concept of concepts) {
    try {
      if (concept.metadata.type === 'Agent') agentDefinition(concept);
      if (concept.metadata.type === 'Group') groupDefinition(concept);
    } catch { diagnostics.push(diagnostic('INVALID_DEFINITION', 'error', `Invalid portable definition: ${concept.path}`, 'Supply the required agent or group fields under lorecrew.')); }
    if (containsCredentials(concept.metadata.lorecrew)) diagnostics.push(diagnostic('CREDENTIAL_VALUE', 'error', `Credential value in portable configuration: ${concept.path}`, 'Replace secret values with local credential binding names.'));
    for (const match of concept.body.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const href = match[1]!.split('#')[0]!.split('?')[0]!;
      if (!href || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href)) continue;
      try {
        const decoded = decodeURIComponent(href);
        const target = decoded.startsWith('/') ? decoded.slice(1) : posix.normalize(posix.join(dirname(concept.path), decoded));
        const check = target.endsWith('/') || !posix.extname(target) ? posix.join(target, 'index.md') : target;
        await lstat(await safePath(ctx.vaultDir, check));
      } catch { diagnostics.push(diagnostic('BROKEN_LINK', 'warning', `Unresolved link in ${concept.path}`, 'Check the relative target or add the linked document when available.')); }
    }
  }
  for (const name of ['config.json', 'providers.json']) {
    try { const config: Json = JSON.parse(await readFile(join(ctx.stateDir, name), 'utf8')); if (containsCredentials(config)) diagnostics.push(diagnostic('CREDENTIAL_VALUE', 'error', `Credential value in local configuration: ${name}`, 'Use environment or local credential binding references.')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') diagnostics.push(diagnostic('INVALID_CONFIG', 'error', `Cannot read local configuration: ${name}`, 'Repair the JSON configuration.')); }
  }
  return diagnostics;
}
