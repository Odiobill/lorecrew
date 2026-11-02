import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitFleet, realGit } from '../helpers/git-fleet.js';
import { openVault } from '../../src/vault/write.js';
import { openSync } from '../helpers/legacy-sync/engine.js';
import { watchVault, type CapturedBatch } from '../../src/sync/watch.js';
import { revisionOf } from '../../src/vault/parse.js';
import type { PublicationBatch } from '../../src/export/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
const note=(body:string)=>`---\ntype: Lesson\n---\n# Lesson\n\n${body}\n`;
async function fixture(){
 const f=await gitFleet();cleanup.push(f.cleanup);
 const base=(await realGit(f.remote,['rev-parse','main'])).stdout.trim();
 const receipts:string[]=[];
 const a=openSync({...f.a,vault:openVault(f.a.ctx),remote:f.remote,acknowledge:async(id)=>{receipts.push(id);}});
 const b=openSync({...f.b,vault:openVault(f.b.ctx),remote:f.remote});
 const batch=(device:'a'|'b',id:string,path:string,content:string|null,previous:string|null=null):PublicationBatch=>({id,originId:f[device].ctx.instanceId,baseRevision:base,createdAt:'2026-10-23T10:00:00Z',files:[{path,content,baseHash:previous===null?null:revisionOf(previous)}]});
 const shared=async(path:string)=>(await realGit(f.remote,['show',`main:${path}`])).stdout;
 return {...f,aSync:a,bSync:b,base,batch,shared,receipts};
}
describe('Git knowledge contributions',()=>{
 it('preserves conflicting proposals and integrates independent batches without touching dirty live files',async()=>{
  const f=await fixture();const dirty='human unsaved elsewhere\n';await writeFile(join(f.a.ctx.vaultDir,'index.md'),dirty);
  const aa=f.batch('a','a-first','lessons/same.md',note('A'));const bb=f.batch('b','b-first','lessons/same.md',note('B'));
  await Promise.all([f.aSync.publish(aa),f.bSync.publish(bb)]);
  await f.bSync.publish(f.batch('b','b-independent','lessons/other.md',note('Other')));
  const result=await f.aSync.integrate();expect(result.conflicts).toHaveLength(1);expect(await f.shared('lessons/other.md')).toBe(note('Other'));
  expect(await f.shared('lessons/same.md')).not.toContain('<<<<<<<');expect(await readFile(join(f.a.ctx.vaultDir,'index.md'),'utf8')).toBe(dirty);
  const conflict=result.conflicts[0]!;expect(conflict.paths).toEqual(['lessons/same.md']);
  for(const version of [conflict.versions[0]!.left,conflict.versions[0]!.right])expect((await realGit(f.remote,['show',`${version.commit}:${version.path}`])).stdout).toMatch(/A|B/);
  expect(await f.shared(`proposals/sync/${conflict.id}.md`)).toContain(conflict.batchId);
  expect((await f.aSync.status()).conflicts).toBe(1);
 });
 it('recovers lost publication acknowledgment and deduplicates immutable IDs across restart',async()=>{
  const f=await fixture();const batch=f.batch('a','lost','lessons/a.md',note('A'));f.a.loseNextPushAck(true);
  await expect(f.aSync.publish(batch)).rejects.toThrow();expect(f.receipts).toEqual([]);expect((await f.aSync.status()).pending).toBe(1);
  await f.reconnect();const reopened=openSync({...f.a,vault:openVault(f.a.ctx),remote:f.remote});
  const receipt=await reopened.publish(batch);expect((await reopened.publish(batch)).commit).toBe(receipt.commit);
  const log=(await realGit(f.remote,['log',`refs/heads/lorecrew/contributions/${f.a.ctx.instanceId}`,'--format=%B'])).stdout;
  expect(log.match(/"id":"lost"/g)).toHaveLength(1);await expect(reopened.publish({...batch,files:[{...batch.files[0]!,content:note('changed')}]})).rejects.toThrow();
  const result=await reopened.integrate();expect(result.appliedBatchIds).toContain('lost');expect(await f.shared('lessons/a.md')).toBe(note('A'));
 });
 it('serializes same-path predecessors while allowing unrelated batches past their conflicts',async()=>{
  const f=await fixture();await f.aSync.publish(f.batch('a','winner','lessons/same.md',note('Winner')));await f.aSync.integrate();
  await f.bSync.publish(f.batch('b','first','lessons/same.md',note('First')));
  await f.bSync.publish(f.batch('b','next','lessons/same.md',note('Next'),note('First')));
  await f.bSync.publish(f.batch('b','other','lessons/other.md',note('Other')));
  const result=await f.bSync.integrate();expect(result.appliedBatchIds).toContain('other');expect(result.appliedBatchIds).not.toContain('next');expect(await f.shared('lessons/same.md')).toBe(note('Winner'));
  expect(result.conflicts.map(c=>c.batchId)).toEqual(expect.arrayContaining(['first','next']));
 });
 it('accepts ordered unpublished updates whose base hashes refer to preceding exports',async()=>{
  const f=await fixture();await f.aSync.publish(f.batch('a','one','lessons/a.md',note('One')));await f.aSync.publish(f.batch('a','two','lessons/a.md',note('Two'),note('One')));
  const result=await f.aSync.integrate();expect(result.appliedBatchIds).toEqual(expect.arrayContaining(['one','two']));expect(result.conflicts).toEqual([]);expect(await f.shared('lessons/a.md')).toBe(note('Two'));expect(f.receipts).toEqual(['one','two']);
 });
 it('publishes an immutable captured successor after a newer same-path correction is accepted while an older conflict remains',async()=>{
  const f=await fixture();const path='lessons/mixed-lineage.md';
  await f.aSync.publish(f.batch('a','shared-winner',path,note('Shared winner')));
  const shared=(await f.aSync.integrate()).acceptedCommit;
  const older=f.batch('b','older-conflict',path,note('Older unresolved proposal'));
  const olderReceipt=await f.bSync.publish(older);
  const conflicted=await f.bSync.integrate();expect(conflicted.conflicts.map(item=>item.batchId)).toEqual([older.id]);
  const correction={...f.batch('b','independent-correction',path,note('Independent correction'),note('Shared winner')),baseRevision:shared};
  await f.bSync.publish(correction);

  // The watcher captures Z before this instance knows that Y was accepted.
  await mkdir(join(f.b.ctx.vaultDir,'lessons'),{recursive:true});
  await writeFile(join(f.b.ctx.vaultDir,path),note('Independent correction'));
  const captured:PublicationBatch[]=[];
  const watcher=watchVault({ctx:f.b.ctx,vault:openVault(f.b.ctx),baseRevision:async()=>conflicted.acceptedCommit,onBatch:async batch=>{captured.push(batch);},debounceMs:100000,rescanMs:100000});
  try{
   await watcher.ready;await writeFile(join(f.b.ctx.vaultDir,path),note('Original captured successor'));await watcher.flush();
  }finally{await watcher.close();}
  expect(captured).toHaveLength(1);const successor=captured[0]!;const immutable=JSON.stringify(successor);
  expect(successor.baseRevision).toBe(conflicted.acceptedCommit);
  expect(successor.files).toEqual([{path,baseHash:revisionOf(note('Independent correction')),content:note('Original captured successor')}]);
  expect(await f.b.ctx.store.read('sync-integrated',correction.id)).toBeUndefined();
  const acceptedCorrection=await f.aSync.integrate();expect(acceptedCorrection.appliedBatchIds).toContain(correction.id);expect(acceptedCorrection.appliedBatchIds).not.toContain(older.id);
  expect(await f.shared(path)).toBe(note('Independent correction'));
  expect(successor.baseRevision).not.toBe(acceptedCorrection.acceptedCommit);

  const restarted=openSync({...f.b,vault:openVault(f.b.ctx),remote:f.remote});
  const published=await restarted.publish(successor);
  expect(await restarted.publish(successor)).toEqual(published);
  const result=await f.aSync.integrate();expect(result.appliedBatchIds).toContain(successor.id);expect(result.appliedBatchIds).not.toContain(older.id);
  expect(await f.shared(path)).toBe(note('Original captured successor'));
  expect(result.conflicts.map(item=>item.batchId)).toEqual([older.id]);
  expect(result.conflicts[0]!.versions[0]!.right.commit).toBe(olderReceipt.commit);
  expect((await realGit(f.remote,['show',`${olderReceipt.commit}:${path}`])).stdout).toBe(note('Older unresolved proposal'));
  const remote=JSON.parse((await realGit(f.remote,['show','-s','--format=%B',published.commit])).stdout) as {batch:PublicationBatch};
  expect(JSON.stringify(remote.batch)).toBe(immutable);
  expect(JSON.stringify((await f.b.ctx.store.read<CapturedBatch>('sync-captured',successor.id))!.batch)).toBe(immutable);
  expect(await f.b.ctx.store.read('sync-publication',successor.id)).toMatchObject({batch:successor,commit:published.commit});
 },15000);
 it('rejects a source hash naming an older contribution instead of the latest same-path predecessor',async()=>{
  const f=await fixture();const path='lessons/skipped-predecessor.md';
  await f.aSync.publish(f.batch('a','first-predecessor',path,note('First')));
  await f.aSync.publish(f.batch('a','latest-predecessor',path,note('Latest'),note('First')));
  await expect(f.aSync.publish(f.batch('a','skipped-predecessor',path,note('Invalid successor'),note('First')))).rejects.toMatchObject({code:'INVALID_CONTRIBUTION'});
  const result=await f.bSync.integrate();expect(result.appliedBatchIds).toEqual(['first-predecessor','latest-predecessor']);expect(await f.shared(path)).toBe(note('Latest'));
 });
 it.each(['skipped predecessor','foreign origin','unshared ancestry','manifest mismatch'])('rejects a forged contribution suffix with %s',async invalid=>{
  const f=await fixture();const path='lessons/invalid-suffix.md';
  await f.aSync.publish(f.batch('a','suffix-first',path,note('First')));
  const latest=await f.aSync.publish(f.batch('a','suffix-latest',path,note('Latest'),note('First')));
  const accepted=await f.bSync.integrate();
  const batch=f.batch('a','invalid-suffix',path,note('Forged successor'),note('Latest'));
  if(invalid==='skipped predecessor')batch.files[0]!.baseHash=revisionOf(note('First'));
  if(invalid==='foreign origin')batch.originId=f.b.ctx.instanceId;
  if(invalid==='unshared ancestry')batch.baseRevision=latest.commit;
  const {StagingRepository}=await import('../helpers/legacy-sync/contributions.js');
  const repo=new StagingRepository({...f.a,vault:openVault(f.a.ctx),remote:f.remote});await repo.init();await repo.fetch();
  const files=await repo.tree(latest.commit);files.set(path,note('Forged successor'));
  if(invalid==='manifest mismatch')files.set('lessons/unmanifested.md',note('Unmanifested'));
  const forged=await repo.commit(latest.commit,files,{format:'lorecrew-contribution-v1',batch});await repo.push(forged,`refs/heads/lorecrew/contributions/${f.a.ctx.instanceId}`);
  await expect(f.bSync.integrate()).rejects.toMatchObject({code:'INVALID_CONTRIBUTION'});
  expect((await realGit(f.remote,['rev-parse','main'])).stdout.trim()).toBe(accepted.acceptedCommit);
  expect(await f.shared(path)).toBe(note('Latest'));
 });
 it('refetches competing integration pushes and preserves both contributions',async()=>{
  const f=await fixture();await Promise.all([f.aSync.publish(f.batch('a','a','lessons/a.md',note('A'))),f.bSync.publish(f.batch('b','b','lessons/b.md',note('B')))]);
  let rejected=0;const racer=(who:'a'|'b')=>openSync({...f[who],git:{async run(cwd,args){const changed=args.map(arg=>arg==='user.email=lorecrew@localhost'?`user.email=${who}@localhost`:arg);const result=await f[who].git.run(cwd,changed);if(args[0]==='push'&&result.exitCode!==0)rejected++;return result;}},vault:openVault(f[who].ctx),remote:f.remote});
  f.raceNextPushes();const results=await Promise.all([racer('a').integrate(),racer('b').integrate()]);expect(rejected).toBeGreaterThan(0);
  for(const result of results)expect(result.appliedBatchIds).toEqual(expect.arrayContaining(['a','b']));expect(await f.shared('lessons/a.md')).toBe(note('A'));expect(await f.shared('lessons/b.md')).toBe(note('B'));
 });
 it('establishes shared integration after a lost push receipt before acknowledging exports',async()=>{
  const f=await fixture();await f.aSync.publish(f.batch('a','a','lessons/a.md',note('A')));f.a.loseNextPushAck(true);
  await expect(f.aSync.integrate()).rejects.toThrow();expect(f.receipts).toEqual([]);await f.reconnect();
  const result=await f.aSync.integrate();expect(result.appliedBatchIds).toContain('a');expect(f.receipts).toEqual(['a']);expect(await f.shared('lessons/a.md')).toBe(note('A'));
 });
 it('rejects assignment records, origin impersonation, unknown preimages, and malformed candidates',async()=>{
  const f=await fixture();
  for(const batch of [f.batch('a','control','control.json',note('grant')),f.batch('a','assignment','projects/assignments.md','---\ntype: Assignment\n---\nowner: a\n'),f.batch('a','foreign',`status/${f.b.ctx.instanceId}/t.md`,'---\ntype: TaskStatus\nlorecrew:\n  originId: '+f.b.ctx.instanceId+'\n---\nForeign\n'),f.batch('a','preimage','lessons/a.md',note('A'),note('unshared human')),f.batch('a','invalid','lessons/a.md','invalid yaml')])await expect(f.aSync.publish(batch)).rejects.toThrow();
  expect((await realGit(f.remote,['rev-parse','main'])).stdout.trim()).toBe(f.base);expect(f.receipts).toEqual([]);
 });
 it('retains failed transport intent and retries acknowledgment after an interrupted callback',async()=>{
  const f=await fixture();const batch=f.batch('a','retry','lessons/a.md',note('A'));await f.disconnect();await expect(f.aSync.publish(batch)).rejects.toThrow();expect((await f.aSync.status()).error).toBeTruthy();await f.reconnect();await f.aSync.publish(batch);
  let fail=true;const acknowledged:string[]=[];const engine=openSync({...f.a,vault:openVault(f.a.ctx),remote:f.remote,acknowledge:async(id)=>{if(fail)throw Error('interrupted callback');acknowledged.push(id);}});
  await expect(engine.integrate()).rejects.toThrow('interrupted callback');expect(await f.shared('lessons/a.md')).toBe(note('A'));fail=false;await engine.integrate();expect(acknowledged).toEqual(['retry']);expect((await engine.status()).pending).toBe(0);
 });
 it('regenerates root catalogs across origins without conflicting on generated additions',async()=>{
  const f=await fixture();const root=await f.shared('index.md');
  const device=(origin:string)=>`---\ntype: Device\nlorecrew:\n  originId: ${origin}\n---\n# Device\n`;
  for(const who of ['a','b'] as const){const origin=f[who].ctx.instanceId;const batch=f.batch(who,who,`devices/${origin}.md`,device(origin));batch.files.push({path:'index.md',baseHash:revisionOf(root),content:root+`\n<!-- lorecrew:device:${origin} -->\n[Device ${origin}](devices/${origin}.md)\n`});await (who==='a'?f.aSync:f.bSync).publish(batch);}
  const result=await f.aSync.integrate();expect(result.conflicts).toEqual([]);expect(result.appliedBatchIds).toEqual(expect.arrayContaining(['a','b']));
  const first=await f.shared('index.md');expect(first).toContain(f.a.ctx.instanceId);expect(first).toContain(f.b.ctx.instanceId);expect(first).toContain('# Fleet knowledge');
  expect((await f.aSync.integrate()).acceptedCommit).toBe(result.acceptedCommit);expect(await f.shared('index.md')).toBe(first);
 });
 it('holds broken-link batches atomically and accepts unrelated valid knowledge',async()=>{
  const f=await fixture();const broken=f.batch('a','broken','lessons/broken.md',note('[Missing](missing.md)'));broken.files.push({path:'lessons/also-held.md',baseHash:null,content:note('Hold together')});await f.aSync.publish(broken);await f.aSync.publish(f.batch('a','valid','lessons/valid.md',note('Valid')));
  const result=await f.aSync.integrate();expect(result.conflicts[0]?.reason).toBe('SYNC_LINK');expect(result.appliedBatchIds).toEqual(['valid']);expect((await realGit(f.remote,['show','main:lessons/also-held.md'])).exitCode).not.toBe(0);expect(await f.shared('lessons/valid.md')).toBe(note('Valid'));
 });
 it('rejects rewriting immutable history segments',async()=>{
  const f=await fixture();const path=`history/${f.a.ctx.instanceId}/session/entry.md`;await f.aSync.publish(f.batch('a','one',path,note('One')));
  await expect(f.aSync.publish(f.batch('a','two',path,note('Changed'),note('One')))).rejects.toThrow();
 });
 it('can bootstrap an empty remote with a validated OKF root',async()=>{
  const f=await fixture();const empty=join(f.root,'empty.git');await realGit(f.root,['init','--bare','--initial-branch=main',empty]);
  const sync=openSync({...f.a,vault:openVault(f.a.ctx),remote:empty});const batch=f.batch('a','initial','index.md','---\nokf_version: "0.2"\n---\n# New vault\n');batch.baseRevision=null;
  await sync.publish(batch);const result=await sync.integrate();expect(result.appliedBatchIds).toEqual(['initial']);expect((await realGit(empty,['show','main:index.md'])).stdout).toContain('# New vault');
 });
 it('preserves exact generated root bytes when a later substantive root edit conflicts',async()=>{
  const f=await fixture();const root=await f.shared('index.md');const devices=[['a',f.a.ctx.instanceId],['b',f.b.ctx.instanceId]] as const;
  for(const [who,id] of devices){const batch=f.batch(who,who,`devices/${id}.md`,`---\ntype: Device\nlorecrew:\n  originId: ${id}\n---\n# Device\n`);batch.files.push({path:'index.md',baseHash:revisionOf(root),content:root.replace('# Fleet knowledge',`# ${who} authored heading`)});await (who==='a'?f.aSync:f.bSync).publish(batch);}
  const result=await f.aSync.integrate();expect(result.conflicts).toHaveLength(1);const version=result.conflicts[0]!.versions.find(v=>v.path==='index.md')!;
  const retained=(await realGit(f.remote,['show',`${version.left.commit}:index.md`])).stdout;expect(revisionOf(retained)).toBe(version.left.hash);expect(retained).toContain('Shared catalog');
 });
 it('publishes the durable immutable snapshot even if the caller changes its object during transport',async()=>{
  const f=await fixture();let release!:()=>void;let arrived!:()=>void;const ready=new Promise<void>(resolve=>{arrived=resolve;});const blocked=new Promise<void>(resolve=>{release=resolve;});let once=true;
  const sync=openSync({...f.a,git:{async run(cwd,args){if(args[0]==='ls-remote'&&once){once=false;arrived();await blocked;}return f.a.git.run(cwd,args);}},vault:openVault(f.a.ctx),remote:f.remote});
  const batch=f.batch('a','immutable','lessons/a.md',note('Original'));const publishing=sync.publish(batch);await ready;batch.files[0]!.content=note('Mutated');release();await publishing;await sync.integrate();expect(await f.shared('lessons/a.md')).toBe(note('Original'));
 });
 it('does not overwrite authored content occupying the generated catalog path',async()=>{
  const f=await fixture();const seed=join(f.root,'seed');await mkdir(join(seed,'catalogs/sync'),{recursive:true});await writeFile(join(seed,'catalogs/sync/index.md'),'# Human catalog\n');await realGit(seed,['add','.']);await realGit(seed,['commit','-m','Human catalog']);await realGit(seed,['push','origin','main']);
  await f.aSync.publish(f.batch('a','new','lessons/a.md',note('A')));await expect(f.aSync.integrate()).rejects.toThrow();expect(await f.shared('catalogs/sync/index.md')).toBe('# Human catalog\n');
 });
 it('integrates parenthesized paths and balanced authored links while keeping the generated catalog navigable',async()=>{
  const f=await fixture();const path='lessons/topic(v2(draft)).md';const content=note('Parenthesized topic');const batch=f.batch('a','parenthesized',path,content);
  const reader=note('[Topic](topic(v2(draft)).md)\n[Encoded](topic%28v2%28draft%29%29.md)');batch.files.push({path:'lessons/reader.md',baseHash:null,content:reader});
  await f.aSync.publish(batch);const result=await f.aSync.integrate();expect(result.conflicts).toEqual([]);expect(result.appliedBatchIds).toContain('parenthesized');expect(f.receipts).toEqual(['parenthesized']);
  expect(await f.shared(path)).toBe(content);expect(await f.shared('lessons/reader.md')).toBe(reader);
  const catalog=await f.shared('catalogs/sync/index.md');expect(catalog).toContain('[lessons/topic(v2(draft)).md](../../lessons/topic%28v2%28draft%29%29.md)');
 });
 it('still holds balanced authored links whose full parenthesized destination does not exist',async()=>{
  const f=await fixture();await f.aSync.publish(f.batch('a','missing-parenthesized','lessons/reader.md',note('[Missing](topic(v2(draft)).md)')));
  const result=await f.aSync.integrate();expect(result.conflicts).toHaveLength(1);expect(result.conflicts[0]!.reason).toBe('SYNC_LINK');expect(result.appliedBatchIds).toEqual([]);expect(f.receipts).toEqual([]);
 });
 it('integrates unfinished bare, angle, and titled inline syntax as ordinary authored text',async()=>{
  const f=await fixture();const content=note(`[Draft](missing unfinished text
[Draft](<missing>
[Draft](missing "unfinished title
[Draft](missing "closed title"
[Draft](missing 'closed title'
[Draft](missing (closed title)
[Draft](<missing> "closed title"`);
  await f.aSync.publish(f.batch('a','unfinished','lessons/draft.md',content));const result=await f.aSync.integrate();expect(result.conflicts).toEqual([]);expect(result.appliedBatchIds).toEqual(['unfinished']);expect(f.receipts).toEqual(['unfinished']);expect(await f.shared('lessons/draft.md')).toBe(content);
 });
 it('validates complete destinations with supported titles and a final link delimiter',async()=>{
  const f=await fixture();const batch=f.batch('a','titled','lessons/topic(v2).md',note('Target'));const reader=note(`[Double](topic(v2).md "A title")
[Single](topic(v2).md 'A title')
[Parenthesis](topic(v2).md (A title))
[Angle](<topic(v2).md> "A title")`);batch.files.push({path:'lessons/reader.md',baseHash:null,content:reader});await f.aSync.publish(batch);
  const accepted=await f.aSync.integrate();expect(accepted.conflicts).toEqual([]);expect(f.receipts).toEqual(['titled']);expect(await f.shared('lessons/reader.md')).toBe(reader);
  await f.aSync.publish(f.batch('a','missing-titled','lessons/missing.md',note('[Missing](<absent(v2).md> "A title")')));const held=await f.aSync.integrate();expect(held.conflicts).toHaveLength(1);expect(held.conflicts[0]!.reason).toBe('SYNC_LINK');expect(f.receipts).toEqual(['titled']);
 });
});

it('rejects empty or whitespace-bearing attributed actors before publishing any contribution',async()=>{
 const f=await fixture();
 for(const [i,actor] of ['user:','user: ','user:two words','user:tab\tid','user:line\nid','user:trailing\n','agent:trailing\n','process:','human:owner\n'].entries()){
  await expect(f.aSync.publish({...f.batch('a',`invalid-actor-${i}`,'lessons/actor.md',note('Rejected')),actor})).rejects.toMatchObject({code:'INVALID_CONTRIBUTION'});
 }
 expect((await realGit(f.remote,['rev-parse','main'])).stdout.trim()).toBe(f.base);
 expect((await realGit(f.remote,['ls-remote','--heads',f.remote,`refs/heads/lorecrew/contributions/${f.a.ctx.instanceId}`])).stdout.trim()).toBe('');
});
it('holds legacy remote secret contributions before main integration while independent safe batches proceed',async()=>{
 const f=await fixture();const {StagingRepository}=await import('../helpers/legacy-sync/contributions.js');const repo=new StagingRepository({...f.a,vault:openVault(f.a.ctx),remote:f.remote});await repo.init();await repo.fetch();const privateText=note('sk-proj-SYNTHETIC_LEGACY_NOT_REAL_12345');const legacy=f.batch('a','legacy-secret','lessons/legacy-private.md',privateText);const files=await repo.tree(f.base);files.set(legacy.files[0]!.path,privateText);const commit=await repo.commit(f.base,files,{format:'lorecrew-contribution-v1',batch:legacy});await repo.push(commit,`refs/heads/lorecrew/contributions/${f.a.ctx.instanceId}`);
 await f.bSync.publish(f.batch('b','safe-after-legacy','lessons/eligible.md',note('Independent safe note')));const result=await f.bSync.integrate();expect(result.appliedBatchIds).not.toContain(legacy.id);expect(await f.shared('lessons/eligible.md')).toBe(note('Independent safe note'));expect((await realGit(f.remote,['show','main:lessons/legacy-private.md'])).exitCode).not.toBe(0);expect((await realGit(f.remote,['log','main','-p'])).stdout).not.toContain(privateText);expect(await f.bSync.status()).toMatchObject({error:'PUBLICATION_HELD',held:1});expect(JSON.stringify(await f.bSync.status())).not.toContain(privateText);expect((await realGit(f.remote,['rev-parse',`refs/heads/lorecrew/contributions/${f.a.ctx.instanceId}`])).stdout.trim()).toBe(commit);
});
it('reevaluates cached unaccepted contributions when literal policy changes',async()=>{
 const f=await fixture();const path='lessons/policy-conflict.md';await f.aSync.publish(f.batch('a','policy-winner',path,note('Winner')));await f.aSync.integrate();const literal='synthetic-legacy-configured-value';const contender=f.batch('b','policy-contender',path,note(literal));await f.bSync.publish(contender);const policy:{literals:string[]}={literals:[]};const sync=openSync({...f.b,vault:openVault(f.b.ctx),remote:f.remote,policy});await sync.integrate();expect((await sync.status()).conflicts).toBe(1);policy.literals.push(literal);await sync.integrate();expect(await sync.status()).toMatchObject({error:'PUBLICATION_HELD',held:1});expect(await f.shared(path)).toBe(note('Winner'));policy.literals.length=0;await sync.integrate();expect((await sync.status()).held).toBe(0);expect((await sync.status()).error).toBeUndefined();
});
