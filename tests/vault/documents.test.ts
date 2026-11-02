import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openInstance } from '../../src/instance/open.js';
import type { InstanceContext } from '../../src/instance/open.js';
import { temporaryInstance } from '../helpers/temp.js';

const parser = () => import('../../src/vault/parse.js');
const writer = () => import('../../src/vault/write.js');
const resolver = () => import('../../src/agents/resolve.js');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture() {
  const f = await temporaryInstance(); cleanups.push(f.cleanup);
  await cp(resolve('tests/fixtures/vault'), f.paths.vaultDir, { recursive: true });
  const ctx = await openInstance(f.paths); cleanups.push(() => ctx.close());
  return { ...f, ctx };
}
async function vaultFixture() { const f = await fixture(); return { ...f, vault: (await writer()).openVault(f.ctx) }; }
const note = '---\ntype: Lesson\ncustom: 7\n---\nBody\r\n\n';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

it('preserves unknown metadata and exact body bytes for ordinary and unknown concept types', async () => {
  const { parseConcept } = await parser();
  expect(parseConcept('lessons/a.md', note)).toMatchObject({ path: 'lessons/a.md', revision: hash(note), metadata: { type: 'Lesson', custom: 7 }, body: 'Body\r\n\n' });
  expect(parseConcept('future.md', '---\ntype: Future Type\n---\n').metadata.type).toBe('Future Type');
});
it.each(['No frontmatter', '---\ncustom: 7\n---\nBody', '---\ntype: []\n---\n', '---\ntype: " "\n---\n', '---\ntype: [broken\n---\n', '---\ntype: Lesson\ntype: Agent\n---\n'])('rejects missing or malformed concept metadata: %s', async text => {
  const { parseConcept } = await parser(); expect(() => parseConcept('a.md', text)).toThrow();
});
it('validates root version, nested indexes and ISO-date reserved logs', async () => {
  const { parseConcept } = await parser();
  expect(parseConcept('index.md', '---\nokf_version: "0.2"\n---\n# Root').body).toBe('# Root');
  for (const text of ['# Root', '---\nokf_version: 0.2\n---\n', '---\nokf_version: "0.1"\n---\n']) expect(() => parseConcept('index.md', text)).toThrow();
  expect(parseConcept('lessons/index.md', '# Lessons').metadata).toEqual({});
  expect(() => parseConcept('lessons/index.md', note)).toThrow();
  expect(parseConcept('lessons/log.md', '# Log\n## 2026-10-23\n* Added lesson.').metadata).toEqual({});
  expect(() => parseConcept('log.md', '# Log\n## Yesterday\n* Added')).toThrow();
  expect(() => parseConcept('log.md', '# Log\n## 2026-02-30\n* Added')).toThrow();
});
it('treats bare verified mappings as one entry without inferring verification from human authorship', async () => {
  const { parseConcept, verificationEntries } = await parser();
  const human = parseConcept('a.md', '---\ntype: Lesson\ngenerated: {by: "human:ada"}\n---\nBody');
  expect(verificationEntries(human)).toEqual([]);
  const verified = parseConcept('b.md', '---\ntype: Lesson\nverified: {by: "human:lin", at: "2026-10-23T10:00:00Z"}\n---\nBody');
  expect(verificationEntries(verified)).toEqual([{by: 'human:lin', at: '2026-10-23T10:00:00Z'}]);
});
it('round-trips metadata patches without losing unrelated fields, comments or body bytes', async () => {
  const { vault, paths } = await vaultFixture();
  const text = '---\ntype: Lesson # keep comment\ncustom: {a: [1, true]}\n---\n\r\nBody\r\n';
  await writeFile(join(paths.vaultDir, 'a.md'), text);
  const result = await vault.propose({ id: 'patch', path: 'a.md', expectedRevision: hash(text), content: { metadata: { title: 'New' } }, actor: 'agent-ada' });
  const actual = await readFile(join(paths.vaultDir, 'a.md'), 'utf8');
  expect(actual).toContain('# keep comment');
  expect(await vault.read('a.md')).toMatchObject({ revision: result.revision, metadata: { title: 'New', custom: {a: [1, true]} }, body: '\r\nBody\r\n' });
  expect((await vault.read('a.md')).metadata.verified).toBeUndefined();
});
it('checks expected revisions and create-only writes without changing stale files', async () => {
  const { vault, paths } = await vaultFixture();
  await writeFile(join(paths.vaultDir, 'a.md'), note);
  for (const expectedRevision of [null, 'stale']) await expect(vault.propose({id: 'stale-'+expectedRevision, path: 'a.md', expectedRevision, content: note.replace('Body', 'Bad'), actor: 'agent-ada'})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
  expect(await readFile(join(paths.vaultDir, 'a.md'), 'utf8')).toBe(note);
  await expect(vault.propose({id: 'missing', path: 'missing.md', expectedRevision: 'stale', content: note, actor: 'agent-ada'})).rejects.toMatchObject({code: 'REVISION_CONFLICT'});
});
it('serializes writes across vault handles and allows one winner for a shared revision', async () => {
  const { vault, paths, ctx } = await vaultFixture();
  await writeFile(join(paths.vaultDir, 'a.md'), note);
  const other = (await writer()).openVault(ctx);
  const results = await Promise.allSettled([vault, other].map((v, i) => v.propose({id: 'race-'+i, path: 'a.md', expectedRevision: hash(note), content: note.replace('Body', 'Body'+i), actor: 'agent-ada'})));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: {code: 'REVISION_CONFLICT'} });
});
it.each(['../escape.md', '/tmp/escape.md', 'a/../../escape.md', 'a\\escape.md', '.git/config.md'])('rejects unsafe vault paths: %s', async path => {
  const { vault } = await vaultFixture();
  await expect(vault.read(path)).rejects.toMatchObject({code: 'UNSAFE_PATH'});
  await expect(vault.propose({id: path, path, expectedRevision: null, content: note, actor: 'agent-ada'})).rejects.toMatchObject({code: 'UNSAFE_PATH'});
});
it('rejects escaping directory and file symlinks for reads, writes and scans', async () => {
  const { vault, root, paths } = await vaultFixture();
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'a.md'), note);
  await symlink(outside, join(paths.vaultDir, 'alias'));
  await symlink(join(outside, 'a.md'), join(paths.vaultDir, 'file.md'));
  for (const path of ['alias/a.md', 'file.md', 'alias/new.md']) {
    await expect(vault.read(path)).rejects.toMatchObject({code:'UNSAFE_PATH'});
    await expect(vault.propose({id:path, path, expectedRevision:null, content:note, actor:'agent-ada'})).rejects.toMatchObject({code:'UNSAFE_PATH'});
  }
  expect((await vault.diagnose()).some(d => d.code === 'UNSAFE_PATH')).toBe(true);
  expect(await readFile(join(outside, 'a.md'), 'utf8')).toBe(note);
});
it('returns the original durable receipt on request retries and refuses mismatched reuse', async () => {
  const { vault, ctx, paths } = await vaultFixture();
  const request = { id: 'retry', path:'new.md', expectedRevision:null, content:note, actor:'agent-ada' };
  const first = await vault.propose(request);
  await writeFile(join(paths.vaultDir, 'new.md'), note.replace('Body','Human edit'));
  await ctx.close(); const reopened = await openInstance({stateDir: paths.stateDir, vaultDir:paths.vaultDir}); cleanups.push(() => reopened.close());
  const next = (await writer()).openVault(reopened);
  expect(await next.propose(request)).toEqual(first);
  await expect(next.propose({...request, content: note+'different'})).rejects.toMatchObject({code:'REQUEST_MISMATCH'});
  expect(await readFile(join(paths.vaultDir, 'new.md'), 'utf8')).toContain('Human edit');
});
it.each(['before-publication', 'after-publication', 'external-edit'])('recovers durable publication intent: %s', async phase => {
  const { ctx, paths } = await fixture();
  // A real Store wrapper simulates process loss at the transaction boundary. File IO remains real.
  let transactions = 0;
  const crashCtx: InstanceContext = {...ctx, store: {...ctx.store, transact: async fn => {
    transactions++;
    if (phase !== 'before-publication' && transactions === 2) throw new Error('process lost');
    const value = await ctx.store.transact(fn);
    if (phase === 'before-publication' && transactions === 1) throw new Error('process lost');
    return value;
  }}};
  const request = {id:'crash', path:'recover.md', expectedRevision:null, content:note, actor:'agent-ada'};
  await expect((await writer()).openVault(crashCtx).propose(request)).rejects.toThrow('process lost');
  if (phase === 'external-edit') await writeFile(join(paths.vaultDir, 'recover.md'), note+'Human');
  await ctx.close(); const nextCtx = await openInstance(paths); cleanups.push(() => nextCtx.close());
  const next = (await writer()).openVault(nextCtx);
  if (phase === 'external-edit') {
    await expect(next.propose(request)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(await readFile(join(paths.vaultDir, 'recover.md'), 'utf8')).toContain('Human');
  } else {
    const receipt = await next.propose(request);
    expect((await next.read('recover.md')).revision).toBe(receipt.revision);
    expect((await nextCtx.store.events(0)).filter(e => e.kind === 'vault.published')).toHaveLength(1);
  }
});
it('resolves portable agent and group definitions with membership owned by agents', async () => {
  const { vault } = await vaultFixture(); const {resolveAgent, resolveGroup} = await resolver();
  expect(await resolveAgent(vault, 'agent-ada')).toMatchObject({id:'agent-ada', name:'Ada', personality:'Thoughtful and direct', responsibilities:['Implementation','Delivery'], groups:['group-engineering'], model:{provider:'local-openai',modelId:'coding-model', thinkingLevel:'high'}, revision:expect.any(String)});
  expect((await resolveAgent(vault, 'agent-lin')).groups).toEqual(['group-engineering']);
  expect(await resolveGroup(vault, 'group-engineering')).toMatchObject({id:'group-engineering', name:'Engineering', description:'Builds and maintains Lorecrew', revision:expect.any(String)});
});
it('rejects duplicate stable IDs in human edits and proposed definitions', async () => {
  const { vault, paths } = await vaultFixture(); const { resolveAgent } = await resolver();
  const ada = await readFile(join(paths.vaultDir, 'agents/ada.md'), 'utf8');
  await expect(vault.propose({id:'duplicate',path:'agents/copy.md',expectedRevision:null,content:ada,actor:'agent-lin'})).rejects.toMatchObject({code:'DUPLICATE_ID'});
  await writeFile(join(paths.vaultDir, 'agents/copy.md'), ada);
  await expect(resolveAgent(vault, 'agent-ada')).rejects.toMatchObject({code:'DUPLICATE_ID'});
});
it('diagnoses invalid concepts, broken links and credential values without rejecting valid linked notes', async () => {
  const { vault, paths } = await vaultFixture();
  await writeFile(join(paths.vaultDir,'bad.md'),'broken');
  await writeFile(join(paths.vaultDir,'linked.md'),note+'[Missing](./missing.md)');
  await writeFile(join(paths.stateDir,'providers.json'),JSON.stringify({local:{apiKey:'sensitive-value'}}));
  const diagnostics = await vault.diagnose();
  expect(diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:'INVALID_CONCEPT',severity:'error'}), expect.objectContaining({code:'BROKEN_LINK',severity:'warning'}),expect.objectContaining({code:'CREDENTIAL_VALUE',severity:'error'})]));
  expect(JSON.stringify(diagnostics)).not.toContain('sensitive-value');
  expect((await vault.read('linked.md')).body).toContain('[Missing]');
});
it('refuses secret-bearing portable model configuration and accepts local binding names', async () => {
  const { vault, paths } = await vaultFixture(); const {resolveAgent} = await resolver();
  const ada = await readFile(join(paths.vaultDir,'agents/ada.md'),'utf8');
  await writeFile(join(paths.vaultDir,'agents/ada.md'),ada.replace('provider: local-openai','apiKey: private-token\n    provider: local-openai'));
  await expect(resolveAgent(vault,'agent-ada')).rejects.toMatchObject({code:'CREDENTIAL_VALUE'});
  expect((await vault.diagnose()).some(d => d.code === 'CREDENTIAL_VALUE')).toBe(true);
});
it('initializes an empty bundle idempotently and doctor diagnoses imported invalid content', async () => {
  const f = await temporaryInstance(); cleanups.push(f.cleanup);
  const { runCli } = await import('../../src/cli.js');
  await runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);
  const index = await readFile(join(f.paths.vaultDir,'index.md'),'utf8');
  expect((await parser()).parseConcept('index.md',index).metadata.okf_version).toBe('0.2');
  await runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);
  expect(await readFile(join(f.paths.vaultDir,'index.md'),'utf8')).toBe(index);
  await writeFile(join(f.paths.vaultDir,'bad.md'),'human text');
  expect(await runCli(['doctor','--state-dir',f.paths.stateDir])).toMatchObject({ok:false,diagnostics:expect.arrayContaining([expect.objectContaining({code:'INVALID_CONCEPT'})])});
  expect(await readFile(join(f.paths.vaultDir,'bad.md'),'utf8')).toBe('human text');
});
it('does not overwrite an imported nonempty bundle during init', async () => {
  const f = await temporaryInstance(); cleanups.push(f.cleanup); await writeFile(join(f.paths.vaultDir,'human.md'),note);
  const {runCli} = await import('../../src/cli.js');
  await expect(runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir])).rejects.toMatchObject({code:'MIGRATION_REQUIRED'});
  await expect(readFile(join(f.paths.vaultDir,'index.md'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await runCli(['doctor','--state-dir',f.paths.stateDir])).toMatchObject({ok:false,diagnostics:expect.arrayContaining([expect.objectContaining({code:'INSTANCE_UNINITIALIZED'})])});
});
it('diagnoses malformed portable definitions instead of accepting incomplete model configuration', async () => {
  const { vault, paths } = await vaultFixture();
  const ada = await readFile(join(paths.vaultDir,'agents/ada.md'),'utf8');
  await writeFile(join(paths.vaultDir,'agents/ada.md'),ada.replace('    modelId: coding-model\n',''));
  expect(await vault.diagnose()).toEqual(expect.arrayContaining([expect.objectContaining({code:'INVALID_DEFINITION',severity:'error'})]));
});
it('defers pending publication when a human introduces a duplicate ID during recovery', async () => {
  const {ctx, paths} = await fixture();
  const definition = (await readFile(join(paths.vaultDir,'agents/ada.md'),'utf8')).replace('agent-ada','agent-new');
  const crashCtx: InstanceContext = {...ctx, store:{...ctx.store, transact: async fn => {const result=await ctx.store.transact(fn); throw new Error('process lost'); return result;}}};
  const request = {id:'duplicate-on-recovery',path:'agents/new.md',expectedRevision:null,content:definition,actor:'agent-ada'};
  await expect((await writer()).openVault(crashCtx).propose(request)).rejects.toThrow('process lost');
  await writeFile(join(paths.vaultDir,'agents/human.md'),definition);
  await ctx.close(); const reopened=await openInstance(paths); cleanups.push(() => reopened.close());
  const vault=(await writer()).openVault(reopened);
  await expect(vault.propose(request)).rejects.toMatchObject({code:'REVISION_CONFLICT'});
  expect((await vault.read('agents/human.md')).metadata.type).toBe('Agent');
  await expect(readFile(join(paths.vaultDir,'agents/new.md'))).rejects.toMatchObject({code:'ENOENT'});
});
it('rejects unfinished frontmatter on reserved plain markdown files', async () => {
  const {parseConcept}=await parser();
  expect(() => parseConcept('agents/index.md','---\ntype: Agent')).toThrow();
  expect(() => parseConcept('log.md','---\ntype: Log')).toThrow();
});
it.each([
  ['provider', '/home/alice/provider.json'],
  ['provider', '../bindings/provider.json'],
  ['provider', 'C:\\Users\\alice\\provider.json'],
  ['modelId', '/home/alice/models/model.bin'],
  ['modelId', 'C:\\Users\\alice\\models\\model.bin'],
  ['modelId', 'file:///home/alice/models/model.bin'],
  ['modelId', '~/models/model.bin'],
  ['modelId', '../models/model.bin'],
])('rejects machine-specific %s configuration %s during propose, resolve and doctor', async (field, value) => {
  const {vault, paths} = await vaultFixture();
  const path = 'agents/ada.md'; const original = await readFile(join(paths.vaultDir,path),'utf8');
  const malformed = original.replace(field === 'provider' ? 'provider: local-openai' : 'modelId: coding-model', `${field}: ${JSON.stringify(value)}`);
  await expect.soft(vault.propose({id:`machine-${field}`,path,expectedRevision:hash(original),content:malformed,actor:'agent-lin'})).rejects.toMatchObject({code:'INVALID_DEFINITION'});
  expect.soft(await readFile(join(paths.vaultDir,path),'utf8')).toBe(original);
  await writeFile(join(paths.vaultDir,path),malformed);
  await expect.soft((await resolver()).resolveAgent(vault,'agent-ada')).rejects.toMatchObject({code:'INVALID_DEFINITION'});
  expect(await vault.diagnose()).toEqual(expect.arrayContaining([expect.objectContaining({code:'INVALID_DEFINITION',severity:'error'})]));
});
it('preserves logical provider names and organization/model identifiers in portable definitions', async () => {
  const {vault, paths} = await vaultFixture();
  const path='agents/ada.md'; const original=await readFile(join(paths.vaultDir,path),'utf8');
  const content=original.replace('provider: local-openai','provider: local_openai.eu-1').replace('modelId: coding-model','modelId: organization/model-v2.1');
  const receipt=await vault.propose({id:'logical-model',path,expectedRevision:hash(original),content,actor:'agent-lin'});
  expect(await (await resolver()).resolveAgent(vault,'agent-ada')).toMatchObject({model:{provider:'local_openai.eu-1',modelId:'organization/model-v2.1'},revision:receipt.revision});
  expect((await vault.diagnose()).filter(d => d.severity === 'error')).toEqual([]);
});
