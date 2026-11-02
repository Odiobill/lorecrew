import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, encodeJson } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import { agentDefinition } from '../agents/resolve.js';
import { assertUniqueIds, containsCredentials, diagnoseVault, safePath, scanVault } from './indexes.js';
import { parseConcept, patchContent, revisionOf } from './parse.js';
import { vaultSnapshotRevision } from './snapshot.js';
import type { Vault, VaultProposal } from './types.js';

const JOURNAL = 'vault.proposals';
interface Publication {
  id: string; request: string; path: string; expectedRevision: string | null;
  content: string; actor: string; revision: string; state: 'pending' | 'published' | 'conflict';
  preconditions?:VaultProposal['preconditions']; snapshotPrecondition?:VaultProposal['snapshotPrecondition'];
}
// All Vault handles for an instance share publication/recovery ordering.
const queues = new WeakMap<InstanceContext, Promise<void>>();
export function orderedVault<T>(ctx: InstanceContext, fn: () => Promise<T>): Promise<T> {
  const result = (queues.get(ctx) ?? Promise.resolve()).then(fn);
  queues.set(ctx, result.then(() => {}, () => {})); return result;
}
async function existing(ctx: InstanceContext, path: string): Promise<string | undefined> {
  const safe = await safePath(ctx.vaultDir, path);
  try { return await readFile(safe, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function syncDirectory(path: string): Promise<void> {
  const dir = await open(path, 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
async function publish(ctx: InstanceContext, record: Publication): Promise<void> {
  const target = await safePath(ctx.vaultDir, record.path);
  const parent = dirname(target);
  await mkdir(parent, {recursive:true});
  await safePath(ctx.vaultDir, record.path);
  // Sync every created directory's parent before acknowledging the document.
  for (let dir = parent; dir !== ctx.vaultDir; dir = dirname(dir)) await syncDirectory(dirname(dir));
  const temp = join(parent, `.lorecrew-${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(record.content); await file.sync();
  } finally { await file.close(); }
  try {
    const current = await existing(ctx, record.path);
    const revision = current === undefined ? null : revisionOf(current);
    if (revision !== record.expectedRevision) throw new AppError('REVISION_CONFLICT', 'Document changed before publication', {path: record.path});
    // Recheck ancestors after staging. External-editor rename races remain best-effort.
    await safePath(ctx.vaultDir, record.path);
    if (record.expectedRevision === null) {
      try { await link(temp, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('REVISION_CONFLICT', 'Document was created before publication', {path:record.path}); throw error; }
      await unlink(temp);
    } else await rename(temp, target);
    await syncDirectory(parent);
  } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
async function checkGuards(ctx:InstanceContext,record:{preconditions?:VaultProposal['preconditions'];snapshotPrecondition?:VaultProposal['snapshotPrecondition']}):Promise<void>{
 for(const condition of record.preconditions??[]){const observed=await existing(ctx,condition.path);if((observed===undefined?null:revisionOf(observed))!==condition.revision)throw new AppError('REVISION_CONFLICT','Publication source changed',{path:condition.path});}
 if(record.snapshotPrecondition&&vaultSnapshotRevision((await scanVault(ctx.vaultDir)).concepts,record.snapshotPrecondition.types)!==record.snapshotPrecondition.revision)throw new AppError('REVISION_CONFLICT','Reviewed catalog or audience changed; review again');
}
async function finish(ctx: InstanceContext, record: Publication): Promise<void> {
  // Recovery recognizes a published hash before considering the old expected revision.
  const current = await existing(ctx, record.path);
  const revision = current === undefined ? null : revisionOf(current);
  if (revision !== record.revision) {
    if (revision !== record.expectedRevision) {
      await ctx.store.transact(tx => tx.put(JOURNAL, record.id, {...record, state:'conflict'}));
      return;
    }
    const candidate = parseConcept(record.path, record.content);
    const scan = await scanVault(ctx.vaultDir);
    assertUniqueIds([...scan.concepts.filter(c => c.path !== record.path), candidate]);
    try { await checkGuards(ctx,record); await publish(ctx, record); }
    catch (error) {
      if (error instanceof AppError && error.code === 'REVISION_CONFLICT') { await ctx.store.transact(tx => tx.put(JOURNAL, record.id, {...record, state:'conflict'})); return; }
      throw error;
    }
  } else {
    // A crash may have followed rename and preceded the directory sync.
    await syncDirectory(dirname(await safePath(ctx.vaultDir, record.path)));
  }
  await ctx.store.transact(tx => {
    const stored = tx.get<Publication>(JOURNAL, record.id);
    if (stored?.state === 'published') return;
    tx.put(JOURNAL, record.id, {...record, state:'published'});
    tx.put('vault-writes',record.path,{path:record.path,hash:record.revision,actor:record.actor,proposalId:record.id});
    tx.emit('vault.published', {id:record.id, path:record.path, revision:record.revision, actor:record.actor});
  });
}
async function recover(ctx: InstanceContext): Promise<void> {
  for (const record of await ctx.store.list<Publication>(JOURNAL)) if (record.state === 'pending') {
    try { await finish(ctx, record); }
    catch (error) {
      if (!(error instanceof AppError) || !['UNSAFE_PATH', 'DUPLICATE_ID', 'INVALID_CONCEPT'].includes(error.code)) throw error;
      await ctx.store.transact(tx => tx.put(JOURNAL, record.id, {...record, state:'conflict'}));
    }
  }
}
function receipt(record: Publication): {revision:string} {
  if (record.state === 'conflict') throw new AppError('REVISION_CONFLICT', 'Publication deferred because the document changed', {path:record.path, proposalId:record.id});
  return {revision:record.revision};
}
export function openVault(ctx: InstanceContext): Vault {
  return {
    read: path => orderedVault(ctx, async () => { await recover(ctx); const text = await existing(ctx, path); if (text === undefined) throw new AppError('NOT_FOUND', 'Vault document not found', {path}); return parseConcept(path, text); }),
    list: () => orderedVault(ctx, async () => { await recover(ctx); return (await scanVault(ctx.vaultDir)).concepts; }),
    diagnose: () => orderedVault(ctx, async () => { await recover(ctx); return diagnoseVault(ctx); }),
    propose: (proposal, admit) => orderedVault(ctx, async () => {
      if (!proposal.id?.trim() || !proposal.actor?.trim()) throw new AppError('INVALID_PROPOSAL', 'Proposals require a stable request ID and actor');
      await safePath(ctx.vaultDir, proposal.path);
      const request = encodeJson({id:proposal.id, path:proposal.path, expectedRevision:proposal.expectedRevision, content:proposal.content, actor:proposal.actor, ...(proposal.preconditions?{preconditions:proposal.preconditions}:{}),...(proposal.snapshotPrecondition?{snapshotPrecondition:proposal.snapshotPrecondition}:{})});
      const prior = await ctx.store.read<Publication>(JOURNAL, proposal.id);
      if (prior && prior.request !== request) throw new AppError('REQUEST_MISMATCH', 'Request ID has already been used for a different proposal');
      await recover(ctx);
      if (prior) return receipt((await ctx.store.read<Publication>(JOURNAL, proposal.id))!);
      await checkGuards(ctx,proposal);
      const original = await existing(ctx, proposal.path);
      if ((original === undefined ? null : revisionOf(original)) !== proposal.expectedRevision) throw new AppError('REVISION_CONFLICT', 'Expected revision does not match current document', {path:proposal.path});
      const content = patchContent(proposal.path, original, proposal.content);
      const concept = parseConcept(proposal.path, content);
      if (containsCredentials(concept.metadata.lorecrew)) throw new AppError('CREDENTIAL_VALUE', 'Portable configuration must refer to local credential bindings');
      if (concept.metadata.type === 'Agent') agentDefinition(concept);
      assertUniqueIds([...(await scanVault(ctx.vaultDir)).concepts.filter(c => c.path !== proposal.path), concept]);
      const record: Publication = {id:proposal.id, request, path:proposal.path, expectedRevision:proposal.expectedRevision, content, actor:proposal.actor, revision:concept.revision, state:'pending',...(proposal.preconditions?{preconditions:proposal.preconditions}:{}),...(proposal.snapshotPrecondition?{snapshotPrecondition:proposal.snapshotPrecondition}:{})};
      await ctx.store.transact(tx => { admit?.(tx); tx.insert(JOURNAL, record.id, record); });
      await finish(ctx, record);
      return receipt((await ctx.store.read<Publication>(JOURNAL, proposal.id))!);
    }),
  };
}

/** Caller must hold orderedVault(ctx). Reuses the canonical proposal recovery and scanner. */
export async function vaultSnapshotLocked(ctx:InstanceContext) {
  await recover(ctx);
  return (await scanVault(ctx.vaultDir)).concepts;
}
