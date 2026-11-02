import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';
import { openInstance } from '../../src/instance/open.js';
import { openVault } from '../../src/vault/write.js';
import { openKnowledge } from '../../src/knowledge/search.js';
import { KnowledgeIndex } from '../../src/knowledge/index.js';
import { SkillCatalog } from '../../src/skills/catalog.js';
import { openSkillLoader } from '../../src/skills/load.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { openOwnership } from '../../src/projects/ownership.js';
import { GitClient } from '../../src/git/client.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const note=(type:string,title:string,body:string,extra:object={})=>`---\n${JSON.stringify({type,title,...extra})}\n---\n${body}`;
const skill=(scope:string,scopeId?:string,status='active',body='SECRET_SKILL_INSTRUCTIONS',resources:string[]=[])=>note('Skill','Renderer repair',body,{description:'Repair renderer registration',lorecrew:{skill:{schemaVersion:1,name:'repair',scope,...(scopeId?{scopeId}:{}),status,resources}}});
async function fixture(){
 const f=await temporaryInstance();cleanup.push(f.cleanup);await cp('tests/fixtures/vault',f.paths.vaultDir,{recursive:true});
 const ctx=await openInstance(f.paths);cleanup.push(()=>ctx.close());const vault=openVault(ctx);
 const put=async(path:string,text:string)=>{await mkdir(dirname(join(ctx.vaultDir,path)),{recursive:true});await writeFile(join(ctx.vaultDir,path),text);};
 await put('lessons/renderer.md',note('Lesson','Repair framework renderer','The renderer plugin must register before mounting.',{description:'Renderer registration failure',symptoms:['framework renderer registration failure','unknown adapter'],tags:['framework'],applicability:{framework:'tiny-ui',version:'2.0'},sourcePaths:['projects/first/fix.md'],evidenceState:'contested'}));
 await put('skills/global.md',skill('global'));await put('skills/engineering.md',skill('group','group-engineering'));await put('skills/other.md',skill('group','other'));
 await put('skills/ada.md',skill('agent','agent-ada'));await put('skills/candidate.md',skill('global',undefined,'candidate','TRIAL_BODY'));await put('skills/old.md',note('Skill','Old','DEPRECATED_BODY',{description:'old repair',lorecrew:{skill:{schemaVersion:1,name:'old',scope:'global',status:'deprecated',resources:[]}}}));
 const index=new KnowledgeIndex(join(ctx.stateDir,'index.sqlite'));cleanup.push(()=>index.close());const knowledge=openKnowledge({ctx,vault,index});
 return {...f,ctx,vault,put,index,knowledge,catalog:new SkillCatalog(vault),loader:openSkillLoader({ctx,vault})};
}
it('rebuilds FTS search from valid vault notes, returns brief contested hits and escapes malformed syntax',async()=>{
 const f=await fixture();expect((await f.knowledge.search({query:'renderer registration'})).items.some(x=>x.path==='lessons/renderer.md')).toBe(true);await f.put('lessons/invalid.md','---\ntype: [broken\n---\nframework');
 await f.knowledge.rebuild();const page=await f.index.search({query:'framework renderer registration failure',framework:'tiny-ui',version:'2.0'});
 expect(page.items[0]).toMatchObject({path:'lessons/renderer.md',evidenceState:'contested',sourcePaths:['projects/first/fix.md']});expect(JSON.stringify(page)).not.toContain('plugin must register');
 expect((await f.index.search({query:'unknown adapter'})).items[0]?.path).toBe('lessons/renderer.md');
 for(const query of ['"renderer','renderer OR (','NEAR(renderer* )','" OR 1=1 --'])await expect(f.index.search({query})).resolves.toHaveProperty('items');
 expect((await f.index.search({query:'renderer',version:'3.0'})).items.map(x=>x.path)).not.toContain('lessons/renderer.md');
 await f.index.close();await rm(join(f.ctx.stateDir,'index.sqlite'));const rebuilt=new KnowledgeIndex(join(f.ctx.stateDir,'index.sqlite'));cleanup.push(()=>rebuilt.close());await rebuilt.rebuild(await f.vault.list());expect(await rebuilt.search({query:'framework renderer registration failure',framework:'tiny-ui',version:'2.0'})).toEqual(page);
});
it('returns a body-free union of global, agent and group skills with qualified duplicate names',async()=>{
 const f=await fixture();const page=await f.catalog.list({agentId:'agent-ada'});
 expect(page.items.map(x=>x.qualifiedId)).toEqual(['agent:agent-ada/repair','global/repair','group:group-engineering/repair']);expect(JSON.stringify(page)).not.toContain('SECRET_SKILL_INSTRUCTIONS');expect((await f.catalog.list({agentId:'agent-ada',query:'registration'})).items).toHaveLength(3);
 await f.put('skills/malformed.md',skill('nonsense'));expect((await f.catalog.list({agentId:'agent-ada'})).items).toHaveLength(3);
});
it('pins skill bytes and resource revisions across promotion, restart, deletion, tasks and explicit reload',async()=>{
 const f=await fixture();await f.put('resources/check.md',note('Reference','Check','OLD_RESOURCE'));await f.put('skills/global.md',skill('global',undefined,'active','OLD_BODY',['resources/check.md']));
 const input={sessionId:'s',taskId:'task-1',qualifiedId:'global/repair'};const loaded=await f.loader.loadSkill(input);
 expect(loaded.body).toBe('OLD_BODY');expect(loaded.resources[0]).toMatchObject({path:'resources/check.md',body:'OLD_RESOURCE'});
 await f.put('resources/check.md',note('Reference','Check','NEW_RESOURCE'));await f.put('skills/global.md',skill('global',undefined,'active','NEW_BODY',['resources/check.md']));
 const loader=openSkillLoader({ctx:f.ctx,vault:f.vault});expect(await loader.loadSkill(input)).toEqual(loaded);
 const current=await loader.loadSkill({...input,taskId:'task-2'});expect(current.revision).not.toBe(loaded.revision);expect(current.body).toBe('NEW_BODY');
 const reloaded=await loader.loadSkill({...input,revision:current.revision});expect(reloaded.body).toBe('NEW_BODY');expect((await f.ctx.store.events(0)).filter(e=>e.kind==='skill.reloaded')).toHaveLength(1);
 await rm(join(f.ctx.vaultDir,'skills/global.md'));await rm(join(f.ctx.vaultDir,'resources/check.md'));expect(await loader.loadSkill({...input,taskId:'task-2'})).toEqual(current);
});
it('requires deliberate candidate trials, retains deprecation history and rejects revision mismatches',async()=>{
 const f=await fixture();const trial={sessionId:'s',taskId:'t',qualifiedId:'global/repair'};
 // A candidate with its own qualified ID can be tried without replacing the active skill.
 await f.put('skills/candidate.md',note('Skill','Trial','TRIAL_BODY',{description:'Trial',lorecrew:{skill:{schemaVersion:1,name:'trial',scope:'global',status:'candidate',resources:[]}}}));
 await expect(f.loader.loadSkill({...trial,qualifiedId:'global/trial'})).rejects.toMatchObject({code:'SKILL_TRIAL_REQUIRED'});
 expect((await f.loader.loadSkill({...trial,qualifiedId:'global/trial',trial:true})).body).toBe('TRIAL_BODY');expect((await f.catalog.list({agentId:'agent-ada'})).items.map(x=>x.qualifiedId)).not.toContain('global/trial');
 await expect(f.loader.loadSkill({...trial,revision:'outdated'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 const old=await f.vault.read('skills/old.md');await expect(f.loader.loadSkill({...trial,qualifiedId:'global/old'})).rejects.toMatchObject({code:'SKILL_DEPRECATED'});expect((await f.loader.loadSkill({...trial,qualifiedId:'global/old',revision:old.revision})).body).toBe('DEPRECATED_BODY');
});
it('writes provenance-linked tentative scoped memory and records actual knowledge loads',async()=>{
 const f=await fixture();await f.ctx.store.transact(tx=>tx.put('runtime-session','s',{session:{id:'s',agentId:'agent-ada'},agent:{groups:['group-engineering']}}));
 const memory=await f.knowledge.remember({sessionId:'s',scope:'group',scopeId:'group-engineering',text:'Registration failed because the tiny-ui renderer was missing',sourcePaths:['lessons/renderer.md'],requestId:'remember-one'});
 expect(await f.knowledge.remember({sessionId:'s',scope:'group',scopeId:'group-engineering',text:'Registration failed because the tiny-ui renderer was missing',sourcePaths:['lessons/renderer.md'],requestId:'remember-one'})).toEqual(memory);
 await f.knowledge.rebuild();const page=await f.knowledge.search({query:'renderer missing'});expect(page.items.find(x=>x.path===memory.path)).toMatchObject({evidenceState:'tentative',sourcePaths:['lessons/renderer.md']});
 expect((await f.knowledge.loadKnowledge({sessionId:'s',...memory})).body).toContain('[lessons/renderer.md]');expect(await f.ctx.store.list('knowledge-load')).toHaveLength(1);
 await expect(f.knowledge.loadKnowledge({sessionId:'s',path:memory.path,revision:'bad'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
});
it('restarts pagination on changed generation and never accepts a cursor for a different query',async()=>{
 const f=await fixture();for(let n=0;n<3;n++)await f.put(`lessons/item${n}.md`,note('Lesson',`Renderer ${n}`,'renderer failure'));
 await f.knowledge.rebuild();const first=await f.knowledge.search({query:'renderer',limit:1});expect(first.nextCursor).toBeTypeOf('string');
 const next=await f.knowledge.search({query:'renderer',limit:1,cursor:first.nextCursor!});expect(next.items[0]?.path).not.toBe(first.items[0]?.path);
 await f.put('lessons/new.md',note('Lesson','Renderer new','renderer failure'));await f.knowledge.rebuild();expect((await f.knowledge.search({query:'renderer',limit:1,cursor:first.nextCursor!})).items).toEqual((await f.knowledge.search({query:'renderer',limit:1})).items);
 expect((await f.knowledge.search({query:'missing',cursor:first.nextCursor!})).items).toEqual([]);
});
it('executes discovery and lazy loads through real Pi CodeMode, inheriting helper scope with full memory tools',async()=>{
 const f=await fixture();const path=join(f.ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
 const provider=scriptedProvider();provider.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.skill_search({})); text(await tools.skill_load({qualifiedId:"group:group-engineering/repair"})); const p=await tools.knowledge_search({query:"renderer registration"}); text(p); const hit=JSON.parse(p).items.find(h=>h.path==="lessons/renderer.md"); text(await tools.knowledge_load({path:hit.path,revision:hit.revision}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Loaded')]);
 const runtime=await openRuntime({ctx:f.ctx,vault:f.vault,ownership:openOwnership(f.ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(f.ctx),supervisor:new ProcessSupervisor(f.ctx),models:provider.models});cleanup.push(()=>runtime.close());
 const s=await runtime.createSession({requestId:'helper',agentId:'agent-ada',temporaryIdentity:{id:'helper:research',sourceAgentId:'agent-ada',parentTaskId:'parent'}});await runtime.submit({sessionId:s.id,requestId:'go',text:'Find renderer lessons for another project'});
 await expect.poll(async()=> (await runtime.snapshot(s.id)).status).toBe('completed');const snap=await runtime.snapshot(s.id);expect(JSON.stringify(snap.tools)).toContain('SECRET_SKILL_INSTRUCTIONS');expect(JSON.stringify(snap.tools)).toContain('lessons/renderer.md');expect(await f.ctx.store.list('skill-pin')).toHaveLength(1);expect(await f.ctx.store.list('knowledge-load'),JSON.stringify(snap.tools)).toHaveLength(1);
 provider.faux.setResponses([fauxAssistantMessage(fauxToolCall('memory_remember',{scope:'global',text:'Shared helper memory',sourcePaths:[]}),{stopReason:'toolUse'}),fauxAssistantMessage('Remembered')]);await runtime.submit({sessionId:s.id,requestId:'read-write',text:'Remember'});await expect.poll(async()=> (await runtime.snapshot(s.id)).status).toBe('completed');expect((await f.vault.list()).filter(c=>c.metadata.type==='Memory')).toHaveLength(1);
 provider.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'text(await tools.memory_remember({scope:"agent",text:"Renderer reuse in another project",sourcePaths:["lessons/renderer.md"]}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Remembered')]);
 const writer=await runtime.createSession({requestId:'writer',agentId:'agent-ada'});await runtime.submit({sessionId:writer.id,requestId:'memory',text:'Save the reused lesson'});await expect.poll(async()=> (await runtime.snapshot(writer.id)).status).toBe('completed');
 expect((await f.vault.list()).find(c=>c.metadata.type==='Memory'&&c.body.includes('Renderer reuse'))?.metadata.sourcePaths).toEqual(['lessons/renderer.md']);
});

it('keeps load replay receipts immutable across later explicit skill reloads and rejects reused identities',async()=>{
 const f=await fixture();const request={sessionId:'s',taskId:'t',qualifiedId:'global/repair',requestId:'load-first'};const first=await f.loader.loadSkill(request);
 await f.put('skills/global.md',skill('global',undefined,'active','SECOND_BODY'));const revision=(await f.vault.read('skills/global.md')).revision;
 const second=await f.loader.loadSkill({...request,revision,requestId:'reload'});expect(second.body).toBe('SECOND_BODY');
 expect(await f.loader.loadSkill(request)).toEqual(first);expect((await f.loader.loadSkill({...request,requestId:'inspect-current'})).body).toBe('SECOND_BODY');
 await expect(f.loader.loadSkill({...request,revision})).rejects.toMatchObject({code:'REQUEST_MISMATCH'});
 const concept=await f.vault.read('lessons/renderer.md');await f.knowledge.loadKnowledge({sessionId:'s',path:concept.path,revision:concept.revision,requestId:'lesson-load'});
 await expect(f.knowledge.loadKnowledge({sessionId:'s',path:'skills/global.md',revision,requestId:'lesson-load'})).rejects.toMatchObject({code:'REQUEST_MISMATCH'});
});
it('recovers pending accepted replacements before rebuilding and waits until a complete application leaves the vault queue',async()=>{
 const f=await fixture();const {orderedVault}=await import('../../src/vault/write.js');
 const {applyAccepted}=await import('../../src/sync/apply.js');const {revisionOf}=await import('../../src/vault/parse.js');
 const old=await f.vault.read('lessons/renderer.md');const content=note('Lesson','Settled renderer','settled renderer result');
 await f.ctx.store.transact(tx=>tx.put('sync-replacements','pending',{id:'pending',path:old.path,beforeHash:old.revision,content,commit:'accepted',recoveryId:'backup',actor:'sync:accepted',state:'pending'}));
 expect((await f.knowledge.search({query:'settled renderer'})).items[0]?.revision).toBe(revisionOf(content));
 let release!:()=>void;let entered!:()=>void;const enteredPromise=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);
 const blocking=orderedVault(f.ctx,async()=>{entered();await hold;});await enteredPromise;
 const batch=applyAccepted({ctx:f.ctx,vault:f.vault,commit:'next',files:[{path:'lessons/a.md',baseHash:null,content:note('Lesson','SnapshotA','atomic snapshot')},{path:'lessons/b.md',baseHash:null,content:note('Lesson','SnapshotB','atomic snapshot')}]});
 const snapshot=f.knowledge.snapshot();release();await blocking;await batch;const concepts=await snapshot;
 expect(concepts.filter(c=>c.body==='atomic snapshot').map(c=>c.path).sort()).toEqual(['lessons/a.md','lessons/b.md']);
});
it('rejects missing resources and duplicate active skill IDs while retaining invalid-note diagnostics',async()=>{
 const f=await fixture();await f.put('skills/global.md',skill('global',undefined,'active','MUST_NOT_LOAD',['resources/absent.md']));
 await expect(f.loader.loadSkill({sessionId:'s',taskId:'t',qualifiedId:'global/repair'})).rejects.toMatchObject({code:'SKILL_RESOURCE_MISSING'});expect(await f.ctx.store.list('skill-pin')).toEqual([]);
 await f.put('skills/duplicate.md',skill('global'));await expect(f.catalog.list({agentId:'agent-ada'})).rejects.toMatchObject({code:'AMBIGUOUS_SKILL'});
 await f.put('lessons/broken.md','---\ntype: [broken\n---\nbroken note');await f.knowledge.rebuild();expect(await readFile(join(f.ctx.vaultDir,'lessons/broken.md'),'utf8')).toContain('broken note');expect((await f.vault.diagnose()).some(d=>d.code==='INVALID_CONCEPT')).toBe(true);
});
