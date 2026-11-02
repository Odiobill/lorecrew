import { afterEach, expect, it } from 'vitest';
import { cp, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { openInstance } from '../../src/instance/open.js';
import { temporaryInstance } from '../helpers/temp.js';
import { gitFleet } from '../helpers/git-fleet.js';
import { openVault } from '../../src/vault/write.js';
import { parseConcept } from '../../src/vault/parse.js';
import { subjectHash } from '../../src/learning/hash.js';
import { deriveEvidenceState } from '../../src/learning/evidence.js';
import { openLearning, queueLearningCompletion, recordLearningSource } from '../../src/learning/capture.js';
import { openKnowledge } from '../../src/knowledge/search.js';
import { openVaultSync } from '../../src/sync/service.js';
import type { EvidenceRecord, LearningEvent, ExecutionReceipt } from '../../src/learning/types.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const lesson=()=>parseConcept('lessons/compat.md','---\n{"type":"Lesson","title":"Compatibility remedy","claims":["remedy","cause"],"applicability":{"framework":"sample","version":"2"}}\n---\nPin the dependency; the incompatible API may explain the failure.\n');
const evidence=(extra:Partial<EvidenceRecord>={}):EvidenceRecord=>({id:'check',subjectId:'lessons/compat.md',subjectHash:subjectHash(lesson()),claimIds:['remedy','cause'],context:{framework:'sample',version:'2'},kind:'test',outcome:'pass',executor:'instance:agent',at:'2026-10-23T10:00:00.000Z',artifactPaths:['evidence/receipt.md'],...extra});
it('validates only exact revisions and complete named claim/context coverage, retaining contradictions',()=>{
 const c=lesson();const pass=evidence();
 expect(deriveEvidenceState(c,[evidence({kind:'review'})])).toBe('tentative');
 expect(deriveEvidenceState(c,[pass])).toBe('validated');
 expect(deriveEvidenceState({...c,body:c.body+'Another remedy.'},[pass])).toBe('tentative');
 expect(deriveEvidenceState(c,[pass,evidence({id:'failure',outcome:'fail',claimIds:['remedy']})])).toBe('contested');
 expect(deriveEvidenceState(c,[evidence({claimIds:['remedy']})])).toBe('tentative');
 expect(deriveEvidenceState(c,[evidence({context:{framework:'sample',version:'3'}})])).toBe('tentative');
 expect(deriveEvidenceState(c,[evidence({claimIds:['undeclared']})])).toBe('tentative');
 expect(deriveEvidenceState(c,[evidence({outcome:'unknown'})])).toBe('tentative');
 expect(subjectHash({...c,metadata:{...c.metadata,verified:true,evidenceState:'validated',evidencePaths:['new.md'],updatedAt:'tomorrow'}})).toBe(subjectHash(c));
 for(const metadata of [{title:'New title'},{type:'Procedure'},{applicability:{version:'3'}},{claims:['different']}])expect(subjectHash({...c,metadata:{...c.metadata,...metadata}})).not.toBe(subjectHash(c));
});
async function fixture(){
 const f=await temporaryInstance();cleanup.push(f.cleanup);await cp('tests/fixtures/vault',f.paths.vaultDir,{recursive:true});let ctx=await openInstance(f.paths);cleanup.push(()=>ctx.close());
 return {...f,get ctx(){return ctx;},get vault(){return openVault(ctx);},get learning(){return openLearning({ctx,vault:openVault(ctx)});},async reopen(){await ctx.close();ctx=await openInstance(f.paths);}};
}
function event(instanceId:string):LearningEvent{return {id:'completion-task',taskId:'task',instanceId,agentId:'ada',model:{provider:'scripted',modelId:'test-model'},historyPaths:[],changedCommits:[],testReceipts:[],outcome:{summary:'Pinned dependency; tests passed',symptoms:'Import failure',versions:{sample:'2'},remedy:'Pin dependency'}};}
const receipt=(sessionId='session'):ExecutionReceipt=>({id:'execution-1',sessionId,command:'npm test -- compatibility',exitCode:0,output:'3 tests passed',at:'2026-10-23T10:00:00.000Z',localArtifact:true});
it('captures one tentative structured lesson across receipt loss and restart without inventing tests',async()=>{
 const f=await fixture();const e=event(f.ctx.instanceId);const vault=f.vault;const propose=vault.propose;let fail=true;
 vault.propose=async input=>{const result=await propose(input);if(fail){fail=false;throw new Error('lost receipt');}return result;};
 await expect(openLearning({ctx:f.ctx,vault}).captureLesson(e)).rejects.toThrow('lost receipt');await f.reopen();
 const saved=await f.learning.captureLesson(e);expect(await f.learning.captureLesson(e)).toEqual(saved);
 const notes=(await f.vault.list()).filter(c=>c.metadata.type==='Lesson');expect(notes).toHaveLength(1);expect(notes[0]!.metadata.evidenceState).toBe('tentative');expect(notes[0]!.metadata.verified).toBeUndefined();
 expect(notes[0]!.body).toContain('Pinned dependency; tests passed');expect(notes[0]!.body).toContain('Unknown');expect(notes[0]!.body).toContain('Rejected attempts');expect(notes[0]!.body).toContain('No executed test receipts');
 await expect(f.learning.captureLesson({...e,outcome:'changed'})).rejects.toMatchObject({code:'LEARNING_CONFLICT'});
});
it('rejects fabricated receipts and rebuilds evidence from shared files, invalidating edits and missing artifacts',async()=>{
 const f=await fixture();
 await writeFile(join(f.paths.vaultDir,'compat.md'),'---\n{"type":"Lesson","title":"Compatibility remedy","claims":["remedy","cause"],"applicability":{"framework":"sample","version":"2"},"verified":true,"evidenceState":"validated"}\n---\nPin dependency\n');
 const c=await f.vault.read('compat.md');const knowledge=openKnowledge({ctx:f.ctx,vault:f.vault});cleanup.push(()=>knowledge.close());expect((await knowledge.search({query:'Compatibility'})).items[0]!.evidenceState).toBe('tentative');
 const request={id:'e1',subjectId:c.path,subjectHash:subjectHash(c),claimIds:['remedy','cause'],context:{framework:'sample',version:'2'},kind:'test' as const,receiptIds:['execution-1'],sessionId:'session'};
 await expect(f.learning.contributeEvidence(request)).rejects.toMatchObject({code:'EVIDENCE_RECEIPT'});
 await f.ctx.store.transact(tx=>tx.put('learning-execution','execution-1',receipt('another-session')));await expect(f.learning.contributeEvidence(request)).rejects.toMatchObject({code:'EVIDENCE_RECEIPT'});
 await f.ctx.store.transact(tx=>tx.put('learning-execution','execution-1',{...receipt(),subjects:[{path:c.path,revision:c.revision,subjectHash:subjectHash(c)}]}));await f.learning.contributeEvidence(request);await f.learning.contributeEvidence(request);
 await expect(f.learning.contributeEvidence({...request,claimIds:['remedy']})).rejects.toMatchObject({code:'LEARNING_CONFLICT'});
 expect((await knowledge.search({query:'Compatibility'})).items[0]!.evidenceState).toBe('validated');expect((await f.vault.list()).filter(c=>c.metadata.type==='Evidence')).toHaveLength(1);
 await f.ctx.store.transact(tx=>tx.delete('learning-execution','execution-1'));await knowledge.rebuild();expect((await knowledge.search({query:'Compatibility'})).items[0]!.evidenceState).toBe('validated');
 const execution=(await f.vault.list()).find(c=>c.metadata.type==='ExecutionReceipt')!;await unlink(join(f.paths.vaultDir,execution.path));
 const missing=(await knowledge.search({query:'Compatibility'})).items[0]!;expect(missing.evidenceState).toBe('tentative');expect(missing.sourcePaths.some(p=>p.startsWith('evidence/records/'))).toBe(true);
 const updated=await f.vault.read(c.path);await f.vault.propose({id:'edit',path:c.path,expectedRevision:updated.revision,actor:'human',content:{metadata:{},body:'Completely different remedy'}});expect((await knowledge.search({query:'Compatibility'})).items[0]!.evidenceState).toBe('tentative');
 await expect(f.learning.contributeEvidence(request)).resolves.toBeUndefined();
 await f.ctx.store.transact(tx=>tx.put('learning-execution','execution-1',{...receipt(),subjects:[{path:c.path,revision:c.revision,subjectHash:subjectHash(c)}]}));
 const captured=await f.learning.captureLesson({...event(f.ctx.instanceId),testReceipts:['execution-1']});expect((await f.vault.read(captured.path)).metadata.sourcePaths).toEqual([]);
});
it('does not reuse an old execution receipt to validate substantively edited claims',async()=>{
 const f=await fixture();await f.vault.propose({id:'subject',path:'subject.md',expectedRevision:null,actor:'agent:fixture',content:'---\n{"type":"Lesson","title":"Pin dependency","claims":["remedy"],"applicability":{}}\n---\nPin version 2\n'});
 const before=await f.vault.read('subject.md');await f.ctx.store.transact(tx=>tx.put('learning-execution','execution-1',{...receipt(),subjects:[{path:before.path,revision:before.revision,subjectHash:subjectHash(before)}]}));
 await f.vault.propose({id:'change',path:before.path,expectedRevision:before.revision,actor:'human',content:{metadata:{},body:'Pin version 3'}});const after=await f.vault.read(before.path);
 await expect(f.learning.contributeEvidence({id:'stale',subjectId:after.path,subjectHash:subjectHash(after),claimIds:['remedy'],context:{},kind:'test',receiptIds:['execution-1'],sessionId:'session'})).rejects.toMatchObject({code:'EVIDENCE_RECEIPT'});
});
it('holds secret-bearing reports and receipts, names unavailable history honestly, and appends late provenance once',async()=>{
 const f=await fixture();const secret='sk-proj-123456789012345678901234';const e=event(f.ctx.instanceId);e.historyPaths=['history/missing.md'];e.outcome={summary:`${'x'.repeat(111)} ${secret}`};
 const captured=await f.learning.captureLesson(e);const note=await f.vault.read(captured.path);expect(JSON.stringify(note)).not.toContain(secret);expect(JSON.stringify(note)).not.toContain('sk-proj-');expect(note.metadata.sourcePaths).toEqual([]);
 await f.ctx.store.transact(tx=>{tx.put('learning-completion','task',{event:e,sessionId:'session',at:'2026-10-23T10:00:00.000Z'});tx.put('learning-execution','secret',{...receipt(),id:'secret',output:secret});});
 await f.learning.drain();expect((await f.vault.list()).filter(c=>c.metadata.type==='ExecutionReceipt')).toHaveLength(0);
 await f.ctx.store.transact(tx=>{tx.put('learning-execution','execution-1',receipt());recordLearningSource(tx,'session',{receiptId:'execution-1'});});await f.learning.drain();await f.learning.drain();
 expect((await f.vault.list()).filter(c=>c.metadata.type==='LearningProvenance')).toHaveLength(1);expect((await f.vault.list()).filter(c=>c.metadata.type==='Lesson')).toHaveLength(1);expect((await f.vault.list()).map(c=>c.body).join('\n')).toContain('3 tests passed');
});
it('does no state writes, publication, or historical source scans for unchanged drained completions across restart',async()=>{
 const f=await fixture();const e=event(f.ctx.instanceId);
 await f.ctx.store.transact(tx=>tx.put('learning-completion','task',{event:e,sessionId:'session',at:'2026-10-23T10:00:00.000Z'}));
 await f.learning.drain();await f.reopen();
 const vault=f.vault;let publications=0;let transactions=0;const scans:string[]=[];
 const propose=vault.propose;vault.propose=async input=>{publications++;return propose(input);};
 const transact=f.ctx.store.transact;f.ctx.store.transact=fn=>{transactions++;return transact(fn);};
 const list=f.ctx.store.list;f.ctx.store.list=async <T>(kind:string)=>{scans.push(kind);return list<T>(kind);};
 const worker=openLearning({ctx:f.ctx,vault});await worker.drain();await worker.drain();await worker.drain();await worker.captureLesson(e);
 expect({publications,transactions}).toEqual({publications:0,transactions:0});
 expect(scans.filter(kind=>['learning-completion','learning-execution','export-file'].includes(kind))).toEqual([]);
});
it('retains a source arriving during drain and retries failed publication after restart without duplicating acknowledgments',async()=>{
 const f=await fixture();const e=event(f.ctx.instanceId);
 await f.ctx.store.transact(tx=>queueLearningCompletion(tx,{event:e,sessionId:'session',at:'2026-10-23T10:00:00.000Z'}));await f.learning.drain();
 const arrive=async(id:string)=>f.ctx.store.transact(tx=>{tx.put('learning-execution',id,{...receipt(),id,output:id});recordLearningSource(tx,'session',{receiptId:id});});
 await arrive('first');const vault=f.vault;const propose=vault.propose;let raced=false;const acknowledgments:number[]=[];
 const transact=f.ctx.store.transact;f.ctx.store.transact=fn=>transact(tx=>fn({...tx,put(kind,id,value){if(kind==='learning-drained')acknowledgments.push((value as {generation:number}).generation);tx.put(kind,id,value);}}));
 vault.propose=async input=>{const result=await propose(input);if(!raced&&input.path.startsWith('evidence/executions/')){raced=true;await arrive('second');}return result;};
 await openLearning({ctx:f.ctx,vault}).drain();expect(acknowledgments).toEqual([1]);expect(await f.ctx.store.list('learning-dirty')).toEqual([expect.objectContaining({generation:2})]);
 await f.reopen();await f.learning.drain();expect(await f.ctx.store.list('learning-dirty')).toEqual([]);expect((await f.vault.list()).filter(c=>c.metadata.type==='ExecutionReceipt')).toHaveLength(2);
 await arrive('third');const failedVault=f.vault;const realPropose=failedVault.propose;let fail=true;
 failedVault.propose=async input=>{const result=await realPropose(input);if(fail&&input.path.startsWith('evidence/executions/')){fail=false;throw new Error('lost publication acknowledgment');}return result;};
 await openLearning({ctx:f.ctx,vault:failedVault}).drain();expect(await f.ctx.store.list('learning-dirty')).toEqual([expect.objectContaining({generation:3})]);expect(await f.ctx.store.list('learning-error')).toHaveLength(1);
 await f.reopen();await f.learning.drain();expect(await f.ctx.store.list('learning-error')).toEqual([]);expect(await f.ctx.store.list('learning-dirty')).toEqual([]);
 expect((await f.vault.list()).filter(c=>c.metadata.type==='ExecutionReceipt')).toHaveLength(3);expect((await f.vault.list()).filter(c=>c.metadata.type==='LearningProvenance')).toHaveLength(3);
 const before=await f.ctx.store.read('learning-drained',e.id);let writes=0;const finalTransact=f.ctx.store.transact;f.ctx.store.transact=fn=>{writes++;return finalTransact(fn);};
 await f.learning.drain();await f.learning.drain();expect(writes).toBe(0);expect(await f.ctx.store.read('learning-drained',e.id)).toEqual(before);
});
// This two-device case performs over 1,000 real Git commands; allow suite contention.
it('synchronizes readable execution provenance and contradictory evidence without the originating database',async()=>{
 const fleet=await gitFleet();cleanup.push(fleet.cleanup);const a=fleet.a;const b=fleet.b;const vault=openVault(a.ctx);const learning=openLearning({ctx:a.ctx,vault});
 await vault.propose({id:'lesson',path:'compat.md',expectedRevision:null,actor:'agent:fixture',content:'---\n{"type":"Lesson","title":"Compatibility remedy","claims":["remedy"],"applicability":{"version":"2"}}\n---\nPin dependency\n'});
 const c=await vault.read('compat.md');const subjects=[{path:c.path,revision:c.revision,subjectHash:subjectHash(c)}];await a.ctx.store.transact(tx=>tx.put('learning-execution','execution-1',{...receipt(),subjects}));
 await learning.contributeEvidence({id:'pass',subjectId:c.path,subjectHash:subjectHash(c),claimIds:['remedy'],context:{version:'2'},kind:'test',receiptIds:['execution-1'],sessionId:'session'});
 await a.ctx.store.transact(tx=>tx.put('learning-execution','execution-fail',{...receipt(),subjects,id:'execution-fail',exitCode:1,output:'Regression: import still fails'}));
 await learning.contributeEvidence({id:'fail',subjectId:c.path,subjectHash:subjectHash(c),claimIds:['remedy'],context:{version:'2'},kind:'reuse',receiptIds:['execution-fail'],sessionId:'session'});
 const runtime={history:async()=>[]};const syncA=await openVaultSync({ctx:a.ctx,vault,runtime,git:a.git,publicationMs:60000});cleanup.push(()=>syncA.close());await syncA.flush();
 const syncB=await openVaultSync({ctx:b.ctx,vault:openVault(b.ctx),runtime,git:b.git,publicationMs:60000});cleanup.push(()=>syncB.close());await syncB.flush();
 const knowledge=openKnowledge({ctx:b.ctx,vault:openVault(b.ctx)});cleanup.push(()=>knowledge.close());const hit=(await knowledge.search({query:'Compatibility'})).items.find(i=>i.path==='compat.md')!;expect(hit.evidenceState).toBe('contested');expect(hit.sourcePaths.length).toBeGreaterThan(1);
 const all=await openVault(b.ctx).list();const text=all.map(c=>c.body).join('\n');expect(text).toContain('3 tests passed');expect(text).toContain('Regression: import still fails');expect(text).toContain('local-only');expect(text).toContain('npm test -- compatibility');expect(await b.ctx.store.list('learning-execution')).toEqual([]);
 for(const path of hit.sourcePaths)await expect(readFile(join(b.ctx.vaultDir,path),'utf8')).resolves.toBeTypeOf('string');
},15_000);
