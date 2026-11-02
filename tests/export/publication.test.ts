import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { openInstance, type InstanceContext } from '../../src/instance/open.js';
import { openVault } from '../../src/vault/write.js';
import { temporaryInstance } from '../helpers/temp.js';
import { realGit } from '../helpers/git-fleet.js';
import type { HistoryEntry, SessionRecord } from '../../src/runtime/types.js';
import type { TaskRecord } from '../../src/team/types.js';
import { openExporter } from '../../src/export/outbox.js';
import { redact } from '../../src/export/redact.js';
import { openLearning } from '../../src/learning/capture.js';
import type { LearningEvent } from '../../src/learning/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const entry=(id:string,kind:HistoryEntry['kind'],text:string):HistoryEntry=>({id,kind,at:'2026-10-23T10:00:00.000Z',data:{content:[{type:'text',text}]}});
async function fixture() {
  const f=await temporaryInstance();cleanup.push(f.cleanup);await cp('tests/fixtures/vault',f.paths.vaultDir,{recursive:true});
  let ctx=await openInstance(f.paths);cleanup.push(()=>ctx.close());
  const session={id:'session',instanceId:ctx.instanceId,agentId:'agent-ada',agentRevision:'definition-revision',model:{provider:'scripted',modelId:'test-model'},projectId:'project'};
  const task:TaskRecord={id:'task',projectId:'project',generation:1,leadSessionId:session.id,executingSessionId:session.id,dependsOn:[],objective:'Verify the greeting',deliverable:'Patch and tests',contextPaths:['agents/ada.md'],workspaceId:'work',state:'running',agentId:'agent-ada'};
  await ctx.store.transact(tx=>{tx.put('runtime-session',session.id,{session,agent:{name:'Ada'},input:{},extensionSnapshots:[]} as unknown as SessionRecord);tx.put('team-task',task.id,task);});
  const entries=[entry('user-1','user','Verify the greeting'),entry('assistant-1','assistant','Changed greeting. Tests: 3 passed.')];
  const runtime={async history(_id:string,after?:string){return after?entries.slice(entries.findIndex(e=>e.id===after)+1):[...entries];}};
  const options=()=>({ctx,vault:openVault(ctx),runtime,baseRevision:async()=> 'a'.repeat(40),policy:{literals:['configured-super-private']}});
  return {...f,get ctx(){return ctx;},entries,task,options,exporter:()=>openExporter(options()),async reopen(){await ctx.close();ctx=await openInstance(f.paths);},async markdown(){const docs=await openVault(ctx).list();return docs.map(d=>d.body).join('\n');},async history(){return (await openVault(ctx).list()).filter(c=>c.metadata.type==='History');}};
}
it('exports each entry once across restart, with shared evidence links and readable provenance',async()=>{
  const f=await fixture();const batches=await f.exporter().flush();expect(batches.length).toBeGreaterThan(0);
  expect(batches[0]).toMatchObject({originId:f.ctx.instanceId,baseRevision:'a'.repeat(40)});
  expect(batches[0]!.files.every(file=>file.baseHash===null)).toBe(true);
  await f.reopen();await f.exporter().flush();const history=await f.history();expect(history.filter(c=>c.metadata.lorecrew && JSON.stringify(c.metadata).includes('user-1'))).toHaveLength(1);
  expect(history).toHaveLength(2);const text=await f.markdown();expect(text).toContain('Tests: 3 passed');expect(text).toContain('definition-revision');
  for(const doc of await openVault(f.ctx).list())for(const match of doc.body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const path=posix.normalize(posix.join(posix.dirname(doc.path),decodeURIComponent(match[1]!)));await expect(readFile(join(f.paths.vaultDir,path),'utf8')).resolves.toBeTypeOf('string');
  }
  expect(await openVault(f.ctx).diagnose()).not.toEqual(expect.arrayContaining([expect.objectContaining({severity:'error'})]));
});
it('holds configured literals and credential shapes without leaking raw content or reasons',async()=>{
  const f=await fixture();const secret='sk-proj-123456789012345678901234';f.entries.push(entry('secret-entry','assistant',`Do not publish ${secret}`),entry('literal-entry','user','configured-super-private'));
  await f.exporter().flush();const all=(await f.markdown())+JSON.stringify(await f.ctx.store.list('export-batch'));expect(all).not.toContain(secret);expect(all).not.toContain('configured-super-private');
  expect(all).toContain('possible_secret');expect(await f.ctx.store.read('export-held','session:secret-entry')).toMatchObject({reason:'possible_secret'});
  expect(redact('Authorization: Bearer abcdefghijklmnop',{})).toMatchObject({held:true,reasons:['possible_secret']});
  expect(redact('-----BEGIN PRIVATE KEY-----\nabc',{}).held).toBe(true);
});
it('retains long tools only locally and appends late results after a terminal task',async()=>{
  const f=await fixture();f.entries.push(entry('tool-1','tool','Tests: 7 passed.\n'+'verbose detail '.repeat(1000)));
  await f.ctx.store.transact(tx=>tx.put('team-task',f.task.id,{...f.task,state:'completed',outcome:{summary:'Ready',tests:['7 passed']}}));
  await f.exporter().flush();const first=await f.history();expect(first).toHaveLength(3);expect(await f.markdown()).toContain('local-only');
  const artifacts=await readdir(join(f.ctx.stateDir,'artifacts','exports'));expect(artifacts).toHaveLength(1);expect(await readFile(join(f.ctx.stateDir,'artifacts','exports',artifacts[0]!),'utf8')).toContain('verbose detail '.repeat(1000));
  f.entries.push(entry('late-tool','tool','Final test evidence: 8 passed.'));await f.exporter().flush();expect(await f.history()).toHaveLength(4);expect(await f.markdown()).toContain('8 passed');const late=(await f.history()).find(c=>JSON.stringify(c.metadata).includes('late-tool'))!;const taskStatus=await readFile(join(f.paths.vaultDir,`status/${f.ctx.instanceId}/task.md`),'utf8');expect(taskStatus).toContain(posix.relative(`status/${f.ctx.instanceId}`,late.path));
});
it('migrates old completion sources once and wakes learning for locally exported late history before shared acknowledgment',async()=>{
 const f=await fixture();const learning=()=>openLearning({ctx:f.ctx,vault:openVault(f.ctx)});
 const event:LearningEvent={id:'completed',taskId:f.task.id,instanceId:f.ctx.instanceId,agentId:'agent-ada',model:{provider:'scripted',modelId:'test-model'},historyPaths:[],changedCommits:[],testReceipts:[],outcome:{summary:'Reported work'}};
 const captured=await learning().captureLesson(event);await f.exporter().flush();
 // Simulate records left by the previous implementation, without source indexes.
 await f.ctx.store.transact(tx=>{tx.delete('learning-sources','session');tx.put('learning-completion',f.task.id,{event,sessionId:'session',at:'2026-10-23T10:00:00.000Z'});tx.put('learning-drained',event.id,{path:captured.path,at:'2026-10-23T10:00:00.000Z'});tx.put('learning-execution','legacy-execution',{id:'legacy-execution',sessionId:'session',command:'echo checked',exitCode:0,output:'checked',at:'2026-10-23T10:00:00.000Z',localArtifact:true});});
 await learning().drain();expect(await f.ctx.store.list('learning-dirty')).toEqual([]);expect((await openVault(f.ctx).list()).filter(c=>c.metadata.type==='LearningProvenance')).toHaveLength(1);
 const originalGeneration=(await f.ctx.store.read<{generation:number}>('learning-drained',event.id))!.generation;expect(originalGeneration).toBe(3);
 await f.reopen();f.entries.push(entry('late-evidence','tool','New local evidence after completion'));await f.exporter().flush();
 expect(await f.ctx.store.list('learning-dirty')).toEqual([expect.objectContaining({generation:4})]);expect((await f.ctx.store.list<import('../../src/export/types.js').PublicationIntent>('export-batch')).every(i=>!i.acknowledged)).toBe(true);
 await learning().drain();const notes=await openVault(f.ctx).list();expect(notes.filter(c=>c.metadata.type==='Lesson')).toHaveLength(1);expect(notes.filter(c=>c.metadata.type==='LearningProvenance')).toHaveLength(2);
 const late=notes.find(c=>c.metadata.type==='History'&&c.body.includes('New local evidence after completion'))!;expect(notes.filter(c=>c.metadata.type==='LearningProvenance').some(c=>(c.metadata.sourcePaths as string[]).includes(late.path))).toBe(true);
 expect(await f.ctx.store.list('learning-dirty')).toEqual([]);
});
it('increments status only for changes and hashes the preceding validated export',async()=>{
  const f=await fixture();await f.exporter().flush();const path=`status/${f.ctx.instanceId}/task.md`;const before=await readFile(join(f.paths.vaultDir,path),'utf8');const first=await openVault(f.ctx).read(path);const old=first.metadata.lorecrew as {sequence:number};
  const preimage=before;
  await f.ctx.store.transact(tx=>tx.put('team-task',f.task.id,{...f.task,state:'completed',outcome:{summary:'Greeting done',tests:['3 passed']}}));
  const batches=await f.exporter().flush();const file=batches.at(-1)!.files.find(file=>file.path===path)!;expect(file.baseHash).toBe(createHash('sha256').update(preimage).digest('hex'));
  const after=await openVault(f.ctx).read(path);expect((after.metadata.lorecrew as {sequence:number}).sequence).toBeGreaterThan(old.sequence);expect(after.body).toContain('Greeting done');
  const again=await f.exporter().flush();expect(again).toHaveLength(batches.length);
});
it('rejects overwriting a snapshot whose declared origin differs',async()=>{
  const f=await fixture();await f.exporter().flush();const path=`status/${f.ctx.instanceId}/task.md`;
  const original=await readFile(join(f.paths.vaultDir,path),'utf8');await writeFile(join(f.paths.vaultDir,path),original.replace(`originId: ${f.ctx.instanceId}`,'originId: another-origin'));
  await f.ctx.store.transact(tx=>tx.put('team-task',f.task.id,{...f.task,state:'completed'}));await expect(f.exporter().flush()).rejects.toMatchObject({code:'EXPORT_ORIGIN'});
});
it('recovers persisted publication intent after a file write and lost receipt',async()=>{
  const f=await fixture();const vault=openVault(f.ctx);const propose=vault.propose;let fail=true;
  vault.propose=async input=>{const result=await propose(input);if(fail){fail=false;throw new Error('receipt lost');}return result;};
  await expect(openExporter({...f.options(),vault}).flush()).rejects.toThrow('receipt lost');expect(await f.ctx.store.list('export-batch')).toHaveLength(1);
  await f.reopen();const batches=await f.exporter().flush();expect(batches).toHaveLength(1);expect(await f.history()).toHaveLength(2);
});
it('does not depend on the retained event cursor to discover meaningful history',async()=>{
  const f=await fixture();await f.exporter().flush();f.entries.push(entry('after-expiry','assistant','Evidence survives event expiry'));
  await f.ctx.store.transact(tx=>{for(let i=0;i<10010;i++)tx.emit('token.noise',{i});});
  await f.reopen();await f.exporter().flush();expect(await f.markdown()).toContain('Evidence survives event expiry');
});

it('holds a divergent human edit instead of publishing it as a shared base or overwriting it',async()=>{
  const f=await fixture();await f.exporter().flush();const path=`status/${f.ctx.instanceId}/task.md`;const original=await readFile(join(f.paths.vaultDir,path),'utf8');const edited=original+'\nHuman annotation.\n';await writeFile(join(f.paths.vaultDir,path),edited);await f.ctx.store.transact(tx=>tx.put('team-task',f.task.id,{...f.task,state:'completed'}));await f.exporter().flush();expect(await readFile(join(f.paths.vaultDir,path),'utf8')).toBe(edited);expect(await f.ctx.store.read('export-conflict',path)).toMatchObject({reason:'live_file_changed'});
});

it('holds secret-bearing status and root edits without exposing source values',async()=>{
  const f=await fixture();await f.ctx.store.transact(tx=>tx.put('team-task',f.task.id,{...f.task,objective:'configured-super-private'}));
  await writeFile(join(f.paths.vaultDir,'index.md'),'---\nokf_version: "0.2"\n---\nHuman configured-super-private\n');await f.exporter().flush();
  const intents=await f.ctx.store.list('export-batch');expect(JSON.stringify(intents)).not.toContain('configured-super-private');expect((await f.history()).length).toBe(2);
  const status=await readFile(join(f.paths.vaultDir,`status/${f.ctx.instanceId}/task.md`),'utf8');expect(status).toContain('possible_secret');expect(status).not.toContain('configured-super-private');
});
it('acknowledges confirmed integration separately from local publication validation',async()=>{
  const f=await fixture();const exporter=f.exporter();const [batch]=await exporter.flush();expect(batch).toBeDefined();await f.reopen();await f.exporter().acknowledge(batch!.id);expect(await f.exporter().flush()).toHaveLength(0);
  await expect(f.exporter().acknowledge('unknown')).rejects.toMatchObject({code:'EXPORT_BATCH'});
});

it('preserves authored shared root bytes while ordered exports retain exact ordinary base ancestry',async()=>{
  const f=await fixture();const root=await readFile(join(f.paths.vaultDir,'index.md'),'utf8');
  for(const args of [['init','--initial-branch=main'],['config','user.name','Export fixture'],['config','user.email','fixture@example.test'],['add','.'],['commit','-m','Shared fixture']])expect((await realGit(f.paths.vaultDir,args)).exitCode).toBe(0);
  const revision=(await realGit(f.paths.vaultDir,['rev-parse','HEAD'])).stdout.trim();const exporter=openExporter({...f.options(),baseRevision:async()=>revision});const [first]=await exporter.flush();
  expect(first!.files.some(file=>file.path==='index.md')).toBe(false);expect(await readFile(join(f.paths.vaultDir,'index.md'),'utf8')).toBe(root);expect(first!.baseRevision).toBe(revision);
  await f.ctx.store.transact(tx=>tx.put('team-task',f.task.id,{...f.task,state:'completed'}));const batches=await exporter.flush();const path=`status/${f.ctx.instanceId}/task.md`;const before=batches[0]!.files.find(file=>file.path===path)!.content!;
  expect(batches[1]!.baseRevision).toBe(revision);expect(batches[1]!.files.find(file=>file.path===path)!.baseHash).toBe(createHash('sha256').update(before).digest('hex'));
});
it('retains an incomplete batch after its snapshot was written and exports unrelated work after restart',async()=>{
  const f=await fixture();const options=f.options();const vault=options.vault;const propose=vault.propose;
  const statusPath=`status/${f.ctx.instanceId}/task.md`;const devicePath=`devices/${f.ctx.instanceId}.md`;
  let injected=false;
  vault.propose=async input=>{
    const result=await propose(input);
    if(input.path===statusPath&&!injected){injected=true;await mkdir(join(f.paths.vaultDir,'devices'),{recursive:true});await writeFile(join(f.paths.vaultDir,devicePath),'---\ntype: Device\n---\nConcurrent human device note.\n');}
    return result;
  };
  expect(await openExporter({...options,vault}).flush()).toEqual([]);
  const [pending]=await f.ctx.store.list<import('../../src/export/types.js').PublicationIntent>('export-batch');expect(pending?.state).toBe('pending');
  const writtenSnapshot=await readFile(join(f.paths.vaultDir,statusPath),'utf8');expect(writtenSnapshot).toContain('sequence: 1');
  await f.reopen();
  const original=(await f.ctx.store.read<SessionRecord>('runtime-session','session'))!;
  await f.ctx.store.transact(tx=>{
    tx.put('runtime-session','other-session',{...original,session:{...original.session,id:'other-session'}});
    tx.put('team-task','other-task',{...f.task,id:'other-task',executingSessionId:'other-session',leadSessionId:'other-session',objective:'Independent work'});
  });
  const batches=await f.exporter().flush();
  expect(batches).toHaveLength(1);expect(batches[0]!.files.some(file=>file.path===`status/${f.ctx.instanceId}/other-task.md`)).toBe(true);
  expect(await f.ctx.store.read('export-batch',pending!.batch.id)).toEqual(pending);
  expect(await f.ctx.store.read('export-status','task')).toBeUndefined();expect(await f.ctx.store.read('export-cursor','session')).toBeUndefined();
  expect(await f.ctx.store.read('export-entry','session:user-1')).toBeUndefined();expect(await f.ctx.store.read('export-file',statusPath)).toBeUndefined();
  expect(await readFile(join(f.paths.vaultDir,statusPath),'utf8')).toBe(writtenSnapshot);
  expect(await readFile(join(f.paths.vaultDir,devicePath),'utf8')).toContain('Concurrent human device note.');
});
it('includes the selected portable agent identity in exported remote task reports',async()=>{
 const f=await fixture();await f.exporter().flush();const statuses=(await openVault(f.ctx).list()).filter(c=>c.metadata.type==='TaskStatus');expect(statuses[0]!.metadata.lorecrew).toMatchObject({agentId:'agent-ada',taskId:'task',state:'running'});
});
it('skips settled transcript payloads and export receipts on an unchanged pass',async()=>{
 const f=await fixture();await f.ctx.store.transact(tx=>{const r=tx.get<SessionRecord>('runtime-session','session')!;tx.put('runtime-session','session',{...r,finished:true});});const exporter=f.exporter();await exporter.flush();let histories=0;const original=f.options().runtime.history;f.options().runtime.history=async(id,after)=>{histories++;return original(id,after);};const list=f.ctx.store.list.bind(f.ctx.store);let historicalLists=0;f.ctx.store.list=async <T>(kind:string)=>{if(['export-file','export-batch','runtime-public-history'].includes(kind))historicalLists++;return list<T>(kind);};await exporter.flush();expect(histories).toBe(0);expect(historicalLists).toBe(0);
});
