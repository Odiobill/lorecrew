import { afterEach, expect, it } from 'vitest';
import { cp, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gitVaultFixture } from '../helpers/git-vault.js';
import { ensureLocalAuthority } from '../../src/projects/authority-domain.js';
import { openConfiguredOwnership, openConfiguredWorkloadOwnership } from '../../src/projects/configured-ownership.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { orderedVault, openVault } from '../../src/vault/write.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { revisionOf } from '../../src/vault/parse.js';
import { scriptedProvider, fauxAssistantMessage, fauxToolCall } from '../helpers/scripted-provider.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const doc=(metadata:object,body:string)=>`---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
async function fixture(activePath='skills/repair.md'){
 const fleet=await gitVaultFixture();cleanup.push(fleet.close);const {ctx,git}=fleet;await ensureLocalAuthority(ctx,fleet.identity,'skill-evolution');await cp('tests/fixtures/vault',ctx.vaultDir,{recursive:true});
 const path=join(ctx.vaultDir,'agents/ada.md');await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
 const vault=openVault(ctx);const workload=openConfiguredWorkloadOwnership(ctx,git);const provider=scriptedProvider();const options={ctx,vault,ownership:openConfiguredOwnership(ctx,git),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,resume:false};
 const runtime=await openRuntime(options);cleanup.push(()=>runtime.close());const grant=await workload.claim('curator','assign');await runtime.curator.assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});
 const session=await runtime.createSession({requestId:'curator',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});
 const metadata={type:'Skill',title:'Repair',description:'Repair safely',lorecrew:{skill:{schemaVersion:1,name:'repair',scope:'global',status:'active',resources:[]}}};
 const active=await vault.propose({id:'base',path:activePath,expectedRevision:null,actor:'user:test',content:doc(metadata,'old safe')});
 async function candidate(id:string,body='new safe',checks=true,resources:string[]=[],code?:string){
  const candidatePath=`skills/${id}.md`;await vault.propose({id,path:candidatePath,expectedRevision:null,actor:'user:test',content:doc({...metadata,lorecrew:{skill:{...metadata.lorecrew.skill,status:'candidate',resources}}},body)});
  const fixturePath=`fixtures/${id}.md`;if(checks)await vault.propose({id:`fixture:${id}`,path:fixturePath,expectedRevision:null,actor:'user:test',content:doc({type:'SkillFixture',files:[{path:'repair.test.mjs',content:code??"import {test} from 'node:test'; import {strict as assert} from 'node:assert'; import subject from './skill-subject.mjs'; test('repair',()=>assert.ok(subject?.concept.body.includes('new')));"}]},'Checks new remedy')});
  const proposal={id,qualifiedId:'global/repair',baseRevision:active.revision,candidatePath,lessonPaths:[],checks:checks?[{name:'repair',command:'node --test',fixturePath}]:[],expectedImprovement:'repair'};
  await runtime.skills.proposeSkill({proposal,sessionId:session.id});return proposal;
 }
 return {ctx,vault,runtime,workload,session,active,candidate,options,supervisor:options.supervisor,...provider};
}
it('keeps failed and no-check candidates inactive with their actual evidence inspectable',async()=>{
 const f=await fixture();expect(f.runtime.skills).toHaveProperty('evaluateProposal');
 const p=await f.candidate('failure','still old');const evaluation=await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});
 expect(evaluation.checks[0],JSON.stringify(await f.ctx.store.list('learning-execution'))).toMatchObject({before:'fail',after:'fail'});expect(evaluation.eligible).toBe(false);expect(evaluation.checks[0]!.evidencePaths).toHaveLength(2);
 await expect(f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'SKILL_NOT_ELIGIBLE'});
 expect((await f.vault.read('skills/repair.md')).revision).toBe(f.active.revision);expect(await f.vault.read(p.candidatePath)).toBeDefined();
 const empty=await f.candidate('empty','new safe',false);expect((await f.runtime.skills.evaluateProposal({proposalId:empty.id,sessionId:f.session.id})).eligible).toBe(false);
 expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items).toHaveLength(1);
});
it('activates a proven improvement, rejects conflicting activation, and rolls back without altering task pins',async()=>{
 const f=await fixture();expect(f.runtime.skills).toHaveProperty('evaluateProposal');const p=await f.candidate('improved');const competing=await f.candidate('competing');
 const ev=await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});expect(ev).toMatchObject({improved:true,eligible:true,regressions:[]});expect(ev.checks[0]).toMatchObject({before:'fail',after:'pass'});
 await f.runtime.skills.evaluateProposal({proposalId:competing.id,sessionId:f.session.id});
 const promoted=await f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id});
 const pin=await f.runtime.skills.loadSkill({sessionId:f.session.id,taskId:'ongoing',qualifiedId:'global/repair'});expect(pin.revision).toBe(promoted.revision);
 await expect(f.runtime.skills.activateProposal({proposalId:competing.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 await f.runtime.skills.rollbackSkill({qualifiedId:'global/repair',expectedActiveRevision:promoted.revision,targetRevision:f.active.revision,userId:'operator'});
 expect((await f.vault.read('skills/repair.md')).revision).toBe(f.active.revision);expect((await f.runtime.skills.loadSkill({sessionId:f.session.id,taskId:'ongoing',qualifiedId:'global/repair'})).revision).toBe(pin.revision);
 expect((await f.runtime.skills.loadSkill({sessionId:f.session.id,taskId:'new-task',qualifiedId:'global/repair'})).revision).toBe(f.active.revision);
});
it('rejects changed candidates and revoked curators but allows separately attributed tentative user activation',async()=>{
 const f=await fixture();expect(f.runtime.skills).toHaveProperty('evaluateProposal');const p=await f.candidate('changed');await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});
 const candidate=await f.vault.read(p.candidatePath);await f.vault.propose({id:'edit',path:p.candidatePath,expectedRevision:candidate.revision,actor:'user:editor',content:{metadata:{},body:'unevaluated change'}});
 await expect(f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
 const p2=await f.candidate('revoked');await f.runtime.skills.evaluateProposal({proposalId:p2.id,sessionId:f.session.id});await f.workload.revoke('curator',1);
 await expect(f.runtime.skills.activateProposal({proposalId:p2.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'OWNER_REVOKED'});
 const activated=await f.runtime.skills.activateUnvalidated({proposalId:p.id,expectedActiveRevision:f.active.revision,userId:'operator'});const concept=await f.vault.read('skills/repair.md');expect(concept.revision).toBe(activated.revision);expect(concept.metadata.evidenceState).toBe('tentative');expect(JSON.stringify(concept.metadata)).toContain('user:operator');
});

it('shows tentative user activation and preserves version resources across edits and rollback',async()=>{
 const f=await fixture();const resourcePath='references/check.md';await f.vault.propose({id:'resource',path:resourcePath,expectedRevision:null,actor:'user:test',content:doc({type:'Reference'},'original resource')});
 const initial=await f.vault.read('skills/repair.md');const m=initial.metadata as any;m.lorecrew.skill.resources=[resourcePath];f.active.revision=(await f.vault.propose({id:'base-resource',path:initial.path,expectedRevision:initial.revision,actor:'user:test',content:doc(m,'old safe')})).revision;
 const p=await f.candidate('resource-candidate','new safe',false,[resourcePath]);const promoted=await f.runtime.skills.activateUnvalidated({proposalId:p.id,expectedActiveRevision:f.active.revision,userId:'operator'});
 expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items[0]).toMatchObject({evidenceState:'tentative'});
 const resource=await f.vault.read(resourcePath);await f.vault.propose({id:'resource-edit',path:resourcePath,expectedRevision:resource.revision,actor:'user:test',content:doc({type:'Reference'},'changed resource')});
 expect((await f.runtime.skills.loadSkill({sessionId:'reader',taskId:'promoted',qualifiedId:'global/repair'})).resources[0]!.body).toBe('original resource\n');
 await f.runtime.skills.rollbackSkill({qualifiedId:'global/repair',expectedActiveRevision:promoted.revision,targetRevision:f.active.revision,userId:'operator'});
 expect((await f.runtime.skills.loadSkill({sessionId:'reader',taskId:'rolled-back',qualifiedId:'global/repair'})).resources[0]!.body).toBe('original resource\n');
});
it.each(['revocation','candidate','resource'] as const)('rejects %s arriving while activation is queued',async change=>{
 const f=await fixture();const resourcePath='references/check.md';await f.vault.propose({id:'resource',path:resourcePath,expectedRevision:null,actor:'user:test',content:doc({type:'Reference'},'frozen')});
 const p=await f.candidate('queued','new safe',true,[resourcePath]);await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});
 let release!:()=>void;let queued!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});const arrived=new Promise<void>(resolve=>{queued=resolve;});cleanup.push(async()=>{release();});
 const original=f.vault.propose;f.vault.propose=(proposal,admit)=>{if(proposal.id.startsWith('skill-activate:')){void orderedVault(f.ctx,()=>held);queued();}return original(proposal,admit);};
 const activation=f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id});const rejected=expect(activation).rejects.toMatchObject({code:change==='revocation'?'OWNER_REVOKED':'REVISION_CONFLICT'});await Promise.race([arrived,activation]);
 if(change==='revocation')await f.workload.revoke('curator',1);else {const path=join(f.ctx.vaultDir,change==='candidate'?p.candidatePath:resourcePath);await writeFile(path,(await readFile(path,'utf8'))+'Changed after evaluation\n');}
 release();await rejected;expect((await f.vault.read('skills/repair.md')).revision).toBe(f.active.revision);
});
it('does not treat a broken fixture import as a baseline failure or an unrelated passing check as improvement',async()=>{
 const f=await fixture();const bad=await f.candidate('broken','new safe',true,[],"import './missing.mjs';");expect((await f.runtime.skills.evaluateProposal({proposalId:bad.id,sessionId:f.session.id})).checks[0]).toMatchObject({before:'unavailable',after:'unavailable'});
 const unchanged=await f.candidate('unchanged','new safe',true,[],"import {test} from 'node:test'; test('repair',()=>{});");expect((await f.runtime.skills.evaluateProposal({proposalId:unchanged.id,sessionId:f.session.id})).eligible).toBe(false);
});
it('retains unfavorable before/after checks and refuses a candidate with a baseline regression',async()=>{
 const f=await fixture();const p=await f.candidate('regression','new unsafe');const fixturePath='fixtures/safety.md';await f.vault.propose({id:'safety',path:fixturePath,expectedRevision:null,actor:'user:test',content:doc({type:'SkillFixture',files:[{path:'safety.test.mjs',content:"import {test} from 'node:test'; import {strict as assert} from 'node:assert'; import subject from './skill-subject.mjs'; test('safety',()=>assert.ok(!subject.concept.body.includes('unsafe')));"}]},'Preserve safety')});
 const proposal={...p,id:'with-regression',checks:[...p.checks,{name:'safety',command:'node --test',fixturePath}]};await f.runtime.skills.proposeSkill({proposal,sessionId:f.session.id});const result=await f.runtime.skills.evaluateProposal({proposalId:proposal.id,sessionId:f.session.id});expect(result).toMatchObject({improved:true,eligible:false,regressions:['safety']});
});
it('replays activation after a lost acknowledgement without changing the candidate, evaluation, or active bytes',async()=>{
 const f=await fixture();const p=await f.candidate('replay');await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});const original=f.vault.propose;let fail=true;
 f.vault.propose=async(proposal,admit)=>{const result=await original(proposal,admit);if(fail&&proposal.id.startsWith('skill-activate:')){fail=false;throw new Error('lost receipt');}return result;};
 const args={proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated' as const,sessionId:f.session.id};await expect(f.runtime.skills.activateProposal(args)).rejects.toThrow('lost receipt');const current=await f.vault.read('skills/repair.md');expect(await f.runtime.skills.activateProposal(args)).toEqual({revision:current.revision});
});
it('serializes repeated evaluation calls and rejects edited evaluation claims',async()=>{
 const f=await fixture();const p=await f.candidate('repeated');const [one,two]=await Promise.all([f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id}),f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id})]);expect(one).toEqual(two);expect(await f.ctx.store.list('learning-execution')).toHaveLength(2);
 const evaluation=(await f.vault.list()).find(c=>c.metadata.type==='SkillEvaluation')!;const metadata=evaluation.metadata as any;metadata.lorecrew.evaluation.eligible=true;metadata.lorecrew.evaluation.improved=true;metadata.lorecrew.evaluation.checks[0].before='fail';metadata.lorecrew.evaluation.checks[0].after='pass';metadata.lorecrew.evaluation.checks.push({name:'invented',before:'fail',after:'pass',evidencePaths:[]});
 await f.vault.propose({id:'edit-evaluation',path:evaluation.path,expectedRevision:evaluation.revision,actor:'user:editor',content:doc(metadata,evaluation.body)});
 await expect(f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'SKILL_NOT_ELIGIBLE'});
});
it('replays rollback after a lost write acknowledgement and preserves the restored revision',async()=>{
 const f=await fixture();const p=await f.candidate('rollback-replay','new safe',false);const promoted=await f.runtime.skills.activateUnvalidated({proposalId:p.id,expectedActiveRevision:f.active.revision,userId:'operator'});const original=f.vault.propose;let fail=true;
 f.vault.propose=async(proposal,admit)=>{const result=await original(proposal,admit);if(fail&&proposal.id.startsWith('skill-rollback:')){fail=false;throw new Error('lost rollback receipt');}return result;};
 const args={qualifiedId:'global/repair',expectedActiveRevision:promoted.revision,targetRevision:f.active.revision,userId:'operator'};await expect(f.runtime.skills.rollbackSkill(args)).rejects.toThrow('lost rollback receipt');await expect(f.runtime.skills.rollbackSkill(args)).resolves.toBeUndefined();expect((await f.vault.read('skills/repair.md')).revision).toBe(f.active.revision);
});

it('composes fixture/proposal/evaluation/validated activation through real curator CodeMode tools',async()=>{
 const f=await fixture();await f.ctx.store.transact(tx=>tx.put('curator-work','tool-chain',{id:'tool-chain',sourcePaths:[],sessionId:f.session.id,generation:1,state:'running',prompt:'Evolve repair'}));
 const files=[{path:'repair.test.mjs',content:"import {test} from 'node:test'; import {strict as assert} from 'node:assert'; import subject from './skill-subject.mjs'; test('repair',()=>assert.ok(subject.concept.body.includes('new')));"}];
 const code=`const fixture=JSON.parse(await tools.skill_fixture(${JSON.stringify({files})}));const proposal=JSON.parse(await tools.curator_propose({kind:'skill',title:'Repair',description:'Improved repair',body:'new safe',expectedBenefit:'Use the improved repair',skill:{qualifiedId:'global/repair',baseRevision:${JSON.stringify(f.active.revision)},resources:[],checks:[{name:'repair',command:'node --test',fixturePath:fixture.path}],expectedImprovement:'repair'}}));text(await tools.skill_evaluate({proposalId:proposal.proposalId}));text(await tools.skill_activate({proposalId:proposal.proposalId,expectedActiveRevision:${JSON.stringify(f.active.revision)}}));text(Object.keys(tools));`;
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'}),fauxAssistantMessage('Evolved')]);await f.runtime.submit({sessionId:f.session.id,requestId:'evolve',text:'Improve repair using named checks'});
 await expect.poll(async()=>(await f.runtime.snapshot(f.session.id)).status).toBe('completed');const active=await f.vault.read('skills/repair.md');expect(active.revision,JSON.stringify((await f.runtime.snapshot(f.session.id)).tools)).not.toBe(f.active.revision);
 expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items[0]).toMatchObject({evidenceState:'validated'});expect(JSON.stringify((await f.runtime.snapshot(f.session.id)).tools)).not.toContain('activateUnvalidated');
 await f.vault.propose({id:'substantive-edit',path:active.path,expectedRevision:active.revision,actor:'user:editor',content:{metadata:{},body:'untested new claim'}});expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items[0]).toMatchObject({evidenceState:'tentative'});
});
it('joins direct evaluation cancellation at a persisted foreground wait',async()=>{
 const f=await fixture();const p=await f.candidate('waiting');await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'running',dependsOn:[],executingSessionId:'fg'}));
 const pending=f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});const stopped=expect(pending).rejects.toBeDefined();await expect.poll(async()=>(await f.runtime.snapshot(f.session.id)).blockedReason).toBe('foreground_priority');
 await f.runtime.cancel(f.session.id);await stopped;expect(await f.ctx.store.list('learning-execution')).toHaveLength(0);expect((await f.ctx.store.read<any>('runtime-session',f.session.id)).cancellationSettled).toBe(true);
});
it('joins direct evaluation fixture processes before acknowledging cancellation',async()=>{
 const f=await fixture();const p=await f.candidate('cancelled','new safe',true,[],"import {test} from 'node:test'; test('repair',async()=>{await new Promise(resolve=>setTimeout(resolve,10000));});");
 const pending=f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});const stopped=expect(pending).rejects.toBeDefined();await expect.poll(async()=>(await f.ctx.store.list<any>('host-process'))[0]?.state).toBe('running');
 await f.runtime.cancel(f.session.id);await stopped;expect((await f.ctx.store.read<any>('runtime-session',f.session.id)).cancellationSettled).toBe(true);expect((await f.ctx.store.list<any>('host-process'))[0].state).toBe('stopped');expect((await f.vault.list()).filter(c=>c.metadata.type==='SkillEvaluation')).toHaveLength(0);
});

it('joins an evaluation inside a live Pi tool before declaring workload quiescence',async()=>{
 const f=await fixture();const p=await f.candidate('handoff');const run=f.supervisor.run.bind(f.supervisor);let first=true;f.supervisor.run=async input=>{const result=await run(input);if(first){first=false;await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'running',dependsOn:[],executingSessionId:'fg'}));}return result;};
 f.faux.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:`text(await tools.skill_evaluate({proposalId:${JSON.stringify(p.id)}}));`}),{stopReason:'toolUse'}),fauxAssistantMessage('Stopped')]);await f.runtime.submit({sessionId:f.session.id,requestId:'evaluate',text:'Evaluate candidate'});
 await expect.poll(async()=>(await f.runtime.snapshot(f.session.id)).blockedReason).toBe('foreground_priority');const stop=f.runtime.stopWorkloadAndProve('curator');await expect(stop).resolves.toMatchObject({quiescent:true});expect((await f.ctx.store.read<any>('runtime-session',f.session.id)).cancellationSettled).toBe(true);
});
it('review: does not attribute an unrelated baseline failure to a passing named check',async()=>{
 const f=await fixture();const p=await f.candidate('named-status','new safe',true,[],"import {test} from 'node:test'; import {strict as assert} from 'node:assert'; import subject from './skill-subject.mjs'; test('repair',()=>{}); test('other',()=>assert.ok(subject.concept.body.includes('new')));");
 const evaluation=await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});expect(evaluation.checks[0]).toMatchObject({before:'pass',after:'pass'});expect(evaluation).toMatchObject({improved:false,eligible:false});
 await expect(f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'SKILL_NOT_ELIGIBLE'});
});
it('review: preserves named improvement but rejects an unrelated candidate fixture failure',async()=>{
 const f=await fixture();const p=await f.candidate('fixture-status','new unsafe',true,[],"import {test} from 'node:test'; import {strict as assert} from 'node:assert'; import subject from './skill-subject.mjs'; test('repair',()=>assert.ok(subject.concept.body.includes('new'))); test('other',()=>assert.ok(!subject.concept.body.includes('unsafe')));");
 const evaluation=await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});expect(evaluation.checks[0]).toMatchObject({before:'fail',after:'pass'});expect(evaluation).toMatchObject({improved:true,eligible:false});
 await expect(f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id})).rejects.toMatchObject({code:'SKILL_NOT_ELIGIBLE'});
});
it('review: rejects edited embedded active resource bytes and removes their validated display state',async()=>{
 const f=await fixture();const resourcePath='references/validated.md';await f.vault.propose({id:'resource',path:resourcePath,expectedRevision:null,actor:'user:test',content:doc({type:'Reference'},'evaluated bytes')});
 const p=await f.candidate('embedded-active','new safe',true,[resourcePath]);await f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});await f.runtime.skills.activateProposal({proposalId:p.id,expectedActiveRevision:f.active.revision,mode:'validated',sessionId:f.session.id});
 const active=await f.vault.read('skills/repair.md');const metadata=active.metadata as any;metadata.lorecrew.skill.activation.resources[0].body='unevaluated bytes';await f.vault.propose({id:'embedded-edit',path:active.path,expectedRevision:active.revision,actor:'user:editor',content:{metadata}});
 expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items[0]).toMatchObject({evidenceState:'tentative'});await expect(f.runtime.skills.loadSkill({sessionId:'new-reader',taskId:'new-task',qualifiedId:'global/repair'})).rejects.toMatchObject({code:'SKILL_RESOURCE_INTEGRITY'});
});
it('review: rejects edited archived resource bytes for historical load and rollback',async()=>{
 const f=await fixture();const resourcePath='references/archived.md';await f.vault.propose({id:'resource',path:resourcePath,expectedRevision:null,actor:'user:test',content:doc({type:'Reference'},'archived bytes')});
 const p=await f.candidate('embedded-history','new safe',false,[resourcePath]);const promoted=await f.runtime.skills.activateUnvalidated({proposalId:p.id,expectedActiveRevision:f.active.revision,userId:'operator'});await f.runtime.skills.rollbackSkill({qualifiedId:'global/repair',expectedActiveRevision:promoted.revision,targetRevision:f.active.revision,userId:'operator'});
 const history=(await f.vault.list()).find(c=>c.metadata.type==='SkillHistory'&&(c.metadata.lorecrew as any).snapshot.concept.revision===promoted.revision)!;const metadata=history.metadata as any;metadata.lorecrew.snapshot.resources[0].body='edited archive bytes';await f.vault.propose({id:'archive-edit',path:history.path,expectedRevision:history.revision,actor:'user:editor',content:doc(metadata,history.body)});
 await expect(f.runtime.skills.loadSkill({sessionId:'new-reader',taskId:'historical',qualifiedId:'global/repair',revision:promoted.revision})).rejects.toMatchObject({code:'SKILL_RESOURCE_INTEGRITY'});
 await expect(f.runtime.skills.rollbackSkill({qualifiedId:'global/repair',expectedActiveRevision:f.active.revision,targetRevision:promoted.revision,userId:'operator'})).rejects.toMatchObject({code:'SKILL_RESOURCE_INTEGRITY'});
});
it('review: cancels a queued session without waiting for a different blocked evaluation or starting it later',async()=>{
 const f=await fixture();const p=await f.candidate('queued-cancel');const sibling=await f.runtime.createSession({requestId:'sibling',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});
 await f.ctx.store.transact(tx=>tx.put('team-task','foreground',{id:'foreground',state:'running',dependsOn:[],executingSessionId:'fg'}));
 const first=f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:f.session.id});const firstResult=first.catch(error=>error);await expect.poll(async()=>(await f.runtime.snapshot(f.session.id)).blockedReason).toBe('foreground_priority');
 const queued=f.runtime.skills.evaluateProposal({proposalId:p.id,sessionId:sibling.id});const queuedResult=queued.catch(error=>error);const cancel=f.runtime.cancel(sibling.id);let settled=false;void cancel.then(()=>{settled=true;});
 try{await expect.poll(()=>settled,{timeout:500}).toBe(true);expect((await f.runtime.snapshot(f.session.id)).blockedReason).toBe('foreground_priority');expect((await f.ctx.store.read<any>('runtime-session',sibling.id)).cancellationSettled).toBe(true);}
 finally{await f.runtime.cancel(f.session.id);await firstResult;await queuedResult;await cancel;}
 expect(await f.ctx.store.list('learning-execution')).toHaveLength(0);expect((await f.vault.list()).filter(c=>c.metadata.type==='SkillEvaluation')).toHaveLength(0);
});

it('review: recovers an unbound legacy active skill by reviewed preservation and deprecation before replacement',async()=>{
 const activePath=`skills/active/${revisionOf('global/repair')}.md`;const f=await fixture(activePath);
 const pinInput={sessionId:f.session.id,taskId:'legacy-ongoing',qualifiedId:'global/repair',requestId:'legacy-load'};
 const pin=await f.runtime.skills.loadSkill(pinInput);
 const original=await f.vault.read(activePath);const legacyMetadata=structuredClone(original.metadata) as any;
 legacyMetadata.lorecrew.skill.activation={mode:'explicit_unvalidated',actor:'user:legacy',resources:[]};
 const legacy=await f.vault.propose({id:'legacy-format',path:original.path,expectedRevision:original.revision,actor:'user:operator',content:{metadata:legacyMetadata}});
 f.active.revision=legacy.revision;
 // The old procedure is blocked before it can register a replacement baseline.
 await expect(f.candidate('blocked-recovery','new reviewed safe')).rejects.toMatchObject({code:'SKILL_RESOURCE_INTEGRITY'});
 const legacyRaw=await readFile(join(f.ctx.vaultDir,original.path),'utf8');
 const archivePath='learning/legacy-skill-archives/repair.md';
 await f.vault.propose({id:'reviewed-archive',path:archivePath,expectedRevision:null,actor:'user:operator',content:doc({type:'LegacySkillArchive',qualifiedId:'global/repair',originalPath:original.path,originalRevision:legacy.revision,raw:legacyRaw},'Unverified obsolete source retained for inspection; not a verified SkillHistory snapshot.')});
 // Only the explicitly reviewing user retires the old definition, after preserving its exact bytes.
 const deprecatedMetadata=structuredClone(legacyMetadata);deprecatedMetadata.lorecrew.skill.status='deprecated';
 const deprecated=await f.vault.propose({id:'reviewed-deprecation',path:original.path,expectedRevision:legacy.revision,actor:'user:operator',content:{metadata:deprecatedMetadata},preconditions:[{path:archivePath,revision:(await f.vault.read(archivePath)).revision}]});
 expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items).toEqual([]);
 // The canonical publication path must be free. Stop all runtime writers before this user maintenance move.
 await f.runtime.close();const retiredPath='learning/legacy-skill-archives/repair-deprecated.md';
 await rename(join(f.ctx.vaultDir,original.path),join(f.ctx.vaultDir,retiredPath));
 f.runtime=await openRuntime(f.options);cleanup.push(()=>f.runtime.close());
 expect((await f.vault.read(retiredPath)).revision).toBe(deprecated.revision);
 const source=await f.vault.read('skills/blocked-recovery.md');const candidatePath='skills/reviewed-recovery.md';
 const candidate=await f.vault.propose({id:'reviewed-candidate',path:candidatePath,expectedRevision:null,actor:'user:operator',content:doc(source.metadata,'new reviewed safe')});
 const proposal={id:'reviewed-recovery',qualifiedId:'global/repair',baseRevision:null,candidatePath,lessonPaths:[],checks:[{name:'repair',command:'node --test',fixturePath:'fixtures/blocked-recovery.md'}],expectedImprovement:'repair'};
 await f.runtime.skills.proposeSkill({proposal,sessionId:f.session.id});
 const evaluation=await f.runtime.skills.evaluateProposal({proposalId:proposal.id,sessionId:f.session.id});
 expect(evaluation).toMatchObject({baselineRevision:null,eligible:true,improved:true});expect(evaluation.checks[0]).toMatchObject({before:'fail',after:'pass'});
 const activated=await f.runtime.skills.activateProposal({proposalId:proposal.id,expectedActiveRevision:null,mode:'validated',sessionId:f.session.id});
 expect((await f.runtime.skills.catalog.list({agentId:'agent-ada'})).items).toEqual([expect.objectContaining({qualifiedId:'global/repair',revision:activated.revision,evidenceState:'validated'})]);
 expect((await f.vault.read(activePath)).revision).toBe(activated.revision);
 expect((await f.vault.read(retiredPath)).revision).toBe(deprecated.revision);
 expect((await f.vault.read(retiredPath)).metadata).toEqual(deprecatedMetadata);
 expect((await f.vault.read(archivePath)).metadata.raw).toBe(legacyRaw);
 expect((await f.vault.read(candidatePath)).revision).toBe(candidate.revision);
 expect(await f.runtime.skills.loadSkill(pinInput)).toEqual(pin);
 expect(await f.runtime.skills.loadSkill({...pinInput,requestId:'after-recovery-load'})).toEqual(pin);
 expect(await f.runtime.skills.loadSkill({...pinInput,taskId:'after-recovery',requestId:'fresh-load'})).toMatchObject({revision:activated.revision,body:'new reviewed safe\n'});
});
