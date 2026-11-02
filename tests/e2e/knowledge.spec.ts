import { navigate } from '../helpers/browser-workspace.js';
import { test as base, expect } from '@playwright/test';
import { localTeam } from '../helpers/local-team.js';
import { subjectHash } from '../../src/learning/hash.js';
import { component } from '../../src/export/history.js';
import { revisionOf } from '../../src/vault/parse.js';
import { openConfiguredWorkloadOwnership } from '../../src/projects/configured-ownership.js';
const test=base.extend<{crew:Awaited<ReturnType<typeof localTeam>>}>({crew:async({},use)=>{const crew=await localTeam();try{await use(crew);}finally{await crew.close();}}});
const doc=(metadata:object,body:string)=>`---\n${JSON.stringify(metadata)}\n---\n${body}\n`;

test('document selections and source links preserve entity hashes through refresh and history',async({page,crew})=>{
  const first='notes/first document.md',second='notes/日本語 100%.md';
  await crew.vault.propose({id:'route-first',path:first,expectedRevision:null,actor:'user:fixture',content:doc({type:'Note',title:'First document'},'[Follow evidence](日本語%20100%25.md)')});
  await crew.vault.propose({id:'route-second',path:second,expectedRevision:null,actor:'user:fixture',content:doc({type:'Note',title:'Linked evidence'},'Evidence content')});
  await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();await navigate(page,'Knowledge');
  await page.getByLabel('Search knowledge').fill('First document');await page.getByRole('button',{name:'Search knowledge',exact:true}).click();await page.getByRole('button',{name:/^First document tentative/}).click();
  await expect(page).toHaveURL(crew.url+'/#knowledge/'+encodeURIComponent(first));
  await page.getByRole('link',{name:'Follow evidence',exact:true}).click();await expect(page).toHaveURL(crew.url+'/#knowledge/'+encodeURIComponent(second));await expect(page.getByRole('heading',{name:'Linked evidence',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Linked evidence',exact:true})).toBeVisible();
  await page.goBack();await expect(page).toHaveURL(crew.url+'/#knowledge/'+encodeURIComponent(first));await expect(page.getByRole('heading',{name:'First document',exact:true})).toBeVisible();
  await page.goForward();await expect(page.getByRole('heading',{name:'Linked evidence',exact:true})).toBeVisible();
});

test('lesson, contradictory evidence and source task remain inspectable on desktop and mobile',async({page,crew},info)=>{
 await crew.vault.propose({id:'source-task',path:'history/source-task.md',expectedRevision:null,actor:'user:fixture',content:doc({type:'History',title:'Source task'},'# Source task\nThe command ran here.')});
 const receiptPath=`evidence/executions/${component(crew.ctx.instanceId)}/${revisionOf('passed')}.md`;
 await crew.vault.propose({id:'lesson',path:'lessons/compat.md',expectedRevision:null,actor:'user:fixture',content:doc({type:'Lesson',title:'Compatibility remedy',description:'Pin the dependency',claims:['remedy'],applicability:{framework:'sample',version:'2'},sourcePaths:['history/source-task.md','local/output.md']},`# Compatibility remedy\nPin the dependency.\n\n[Test evidence](../${receiptPath})\n[Unsafe link](javascript:alert(1))\n<script>window.__unsafe = true</script>`)});
 const lesson=await crew.vault.read('lessons/compat.md');const binding={path:lesson.path,revision:lesson.revision,subjectHash:subjectHash(lesson)};
 for(const [id,exitCode] of [['passed',0],['failed',1]] as const){await crew.ctx.store.transact(tx=>tx.put('learning-execution',id,{id,sessionId:'source-session',command:'node --test',exitCode,output:exitCode?'regression':'passed',at:'2026-10-23T10:00:00.000Z',localArtifact:true,subjects:[binding]}));await crew.runtime.learning.contributeEvidence({id,subjectId:lesson.path,subjectHash:binding.subjectHash,claimIds:['remedy'],context:{framework:'sample',version:'2'},kind:'test',receiptIds:[id],sessionId:'source-session'});}
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();
 await navigate(page,'Knowledge');await page.getByLabel('Search knowledge').fill('Compatibility');await page.getByRole('button',{name:'Search knowledge'}).click();
 await page.getByRole('button',{name:'Compatibility remedy'}).click();await expect(page.getByText('Contested',{exact:true})).toBeVisible();await expect(page.getByText('Validated for')).toBeVisible();await expect(page.getByText('Conflicting evidence')).toBeVisible();
 await expect(page.getByText('Unavailable on this instance').first()).toBeVisible();await expect(page.getByRole('link',{name:'Unsafe link'})).toHaveCount(0);await expect(page.getByText('Tentative')).toHaveCount(0);
 await page.screenshot({path:info.outputPath(`${info.project.name}-lesson-evidence.png`),fullPage:true});
 await page.getByRole('link',{name:'Test evidence'}).click();await expect(page.getByRole('heading',{name:'Executed command receipt'})).toBeVisible();
 await page.getByRole('button',{name:'Back to lesson'}).click();await page.getByRole('link',{name:'Source task'}).click();await expect(page.getByRole('heading',{name:'Source task'}).first()).toBeVisible();
 expect(await page.evaluate(()=>Boolean((window as any).__unsafe))).toBe(false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`${info.project.name}-knowledge.png`),fullPage:true});
});

test('candidate and active skills, revision and unresolved learning are keyboard accessible',async({page,crew},info)=>{
 const metadata={type:'Skill',title:'Repair',description:'Repair safely',lorecrew:{skill:{schemaVersion:1,name:'repair',scope:'global',status:'active',resources:[]}}};
 const active=await crew.vault.propose({id:'active',path:'skills/repair.md',expectedRevision:null,actor:'user:fixture',content:doc(metadata,'Old remedy')});
 await crew.vault.propose({id:'candidate',path:'skills/candidate.md',expectedRevision:null,actor:'user:fixture',content:doc({...metadata,lorecrew:{skill:{...metadata.lorecrew.skill,status:'candidate'}}},'Candidate remedy')});
 const grant=await openConfiguredWorkloadOwnership(crew.ctx,crew.git).claim('curator','assign');await crew.runtime.curator.assign({agentId:'agent-ada',ownerId:grant.ownerId,generation:1});
 const curator=await crew.runtime.createSession({requestId:'curator-evaluation',agentId:'agent-ada',background:true,workload:{workloadId:'curator',generation:1}});
 await crew.runtime.skills.proposeSkill({sessionId:curator.id,proposal:{id:'rejected',qualifiedId:'global/repair',baseRevision:active.revision,candidatePath:'skills/candidate.md',lessonPaths:[],checks:[],expectedImprovement:'repair'}});
 expect((await crew.runtime.skills.evaluateProposal({proposalId:'rejected',sessionId:curator.id})).eligible).toBe(false);
 await crew.vault.propose({id:'unresolved',path:'learning/proposals/unresolved.md',expectedRevision:null,actor:'agent:fixture',content:doc({type:'LearningProposal',title:'Unresolved conflict',sourcePaths:['skills/candidate.md']},'Conflicting approaches')});
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();
 await navigate(page,'Skills');
 await expect(page.getByRole('button',{name:/global\/repair Candidate · tentative Repair safely/})).toBeVisible();
 const activeRow=page.getByRole('button',{name:/global\/repair Active · tentative Repair safely/});
 await expect(activeRow).toBeVisible();await activeRow.click();await expect(page.getByText('Catalog revision')).toBeVisible();await page.getByLabel('Trial / load context').selectOption(curator.id);await expect(page.getByText('Task pin')).toBeVisible();
 await navigate(page,'Learning');
 await expect(page.getByRole('button',{name:/Unresolved conflict Unresolved · LearningProposal/})).toBeVisible();
 await expect(page.getByRole('button',{name:/Rejected · SkillProposal/})).toBeVisible();
 await page.keyboard.press('Tab');expect(await page.evaluate(()=>document.activeElement?.tagName)).not.toBe('BODY');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`${info.project.name}-learning.png`),fullPage:true});
});

test('review-only assessments show covered claims without execution validation',async({page,crew},info)=>{
 await crew.vault.propose({id:'review-only',path:'lessons/review-only.md',expectedRevision:null,actor:'user:fixture',content:doc({type:'Lesson',title:'Review only',claims:['remedy','version'],applicability:{version:'2'}},'# Review only')});
 const lesson=await crew.vault.read('lessons/review-only.md');
 for(const [id,outcome,claimIds] of [['favorable','pass',['remedy']],['unfavorable','fail',['version']]] as const)await crew.runtime.learning.recordEvidence({id,subjectId:lesson.path,subjectHash:subjectHash(lesson),claimIds:[...claimIds],context:{version:'2'},kind:'review',outcome,executor:'user:reviewer',at:'2026-10-23T10:00:00.000Z',artifactPaths:[]});
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();
 await navigate(page,'Knowledge');await page.getByLabel('Search knowledge').fill('Review only');await page.getByRole('button',{name:'Search knowledge'}).click();await page.getByRole('button',{name:'Review only'}).click();
 await expect(page.getByText('Tentative',{exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Reviews, not execution validation'})).toBeVisible();
 await expect(page.getByText('Reviewer assessments cover remedy (pass); version (fail). These do not establish a passing check or execution conflict.')).toBeVisible();
 await expect(page.getByRole('heading',{name:'Validated for'})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Conflicting evidence'})).toHaveCount(0);
 await page.screenshot({path:info.outputPath(`${info.project.name}-review-only.png`),fullPage:true});
});

test('old task pin and lifecycle actions survive catalog and proposal page boundaries',async({page,crew},info)=>{
 const metadata={type:'Skill',title:'Repair',description:'Repair safely',lorecrew:{skill:{schemaVersion:1,name:'repair',scope:'global',status:'active',resources:[]}}};
 const active=await crew.vault.propose({id:'active',path:'skills/repair.md',expectedRevision:null,actor:'user:fixture',content:doc(metadata,'Old remedy')});
 const session=await crew.runtime.createSession({requestId:'pin-and-proposal',agentId:'agent-ada'});
 expect((await crew.runtime.skills.loadSkill({sessionId:session.id,taskId:session.id,qualifiedId:'global/repair'})).revision).toBe(active.revision);
 for(let i=0;i<19;i++)await crew.vault.propose({id:`skill-filler-${i}`,path:`skills/alpha-${String(i).padStart(3,'0')}.md`,expectedRevision:null,actor:'user:fixture',content:doc({type:'Skill',title:`Alpha ${i}`,description:'Filler',lorecrew:{skill:{schemaVersion:1,name:`alpha-${String(i).padStart(3,'0')}`,scope:'global',status:'active',resources:[]}}},'Filler')});
 for(let i=0;i<101;i++)await crew.vault.propose({id:`proposal-filler-${i}`,path:`learning/00-filler-${String(i).padStart(3,'0')}.md`,expectedRevision:null,actor:'user:fixture',content:doc({type:'LearningProposal',title:`Filler ${i}`},'Pending')});
 await crew.vault.propose({id:'candidate',path:'skills/candidate.md',expectedRevision:null,actor:'user:fixture',content:doc({...metadata,lorecrew:{skill:{...metadata.lorecrew.skill,status:'candidate'}}},'New remedy')});
 await crew.runtime.skills.proposeSkill({sessionId:session.id,proposal:{id:'repair',qualifiedId:'global/repair',baseRevision:active.revision,candidatePath:'skills/candidate.md',lessonPaths:[],checks:[],expectedImprovement:'repair'}});
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();await navigate(page,'Skills');
 await page.getByRole('button',{name:'Next results'}).click();await page.getByRole('button',{name:/global\/repair Candidate/}).click();await expect(page.getByRole('button',{name:'Activate unvalidated'})).toBeVisible();
 await page.getByRole('button',{name:'Activate unvalidated'}).click();await expect(page.getByText('Candidate activated as tentative.')).toBeVisible();
 await page.getByRole('button',{name:/global\/repair Active/}).click();
 const catalog=page.locator('.inspection-detail .revision').filter({hasText:'Catalog revision'}).locator('code');
 const pin=page.locator('.inspection-detail .revision').filter({hasText:'Task pin'}).locator('code');
 await expect(catalog).not.toHaveText(active.revision);await expect(page.getByRole('button',{name:'Load for task'})).toBeDisabled();await page.getByLabel('Trial / load context').selectOption(session.id);await expect(pin).toHaveText(active.revision);
 await expect(page.getByRole('button',{name:`Restore ${active.revision.slice(0,12)}`})).toBeVisible();
 await page.getByRole('button',{name:'Load for task'}).click();await expect(page.getByText(`Revision ${active.revision} loaded and pinned to this task.`)).toBeVisible();await expect(pin).toHaveText(active.revision);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath(`${info.project.name}-old-pin.png`),fullPage:true});
});
