import { test as base, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { localTeam } from '../helpers/local-team.js';
import { connectWorkspace,navigate } from '../helpers/browser-workspace.js';
import { fauxAssistantMessage,fauxToolCall } from '../helpers/scripted-provider.js';
import { openBrowserSessions } from '../../src/auth/sessions.js';
import { defineExtension,defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';

const waiting=defineExtension({name:'ui-wait',tools:[defineTool({name:'wait_for_stop',description:'Wait for a user stop',parameters:Type.Object({}),replay:'safe',async execute(_args,_api,context){
  await new Promise<void>(resolve=>{if(context.abortSignal?.aborted)resolve();else context.abortSignal?.addEventListener('abort',()=>resolve(),{once:true});});
  return {output:[{type:'text',text:'Wait finished'}]};
}})]});
const test=base.extend<{crew:Awaited<ReturnType<typeof localTeam>>}>({crew:async({},use)=>{
  const crew=await localTeam({extensions:[waiting]});try{await use(crew);}finally{await crew.close();}
}});
async function start(page:import('@playwright/test').Page,crew:Awaited<ReturnType<typeof localTeam>>) {
  await connectWorkspace(page,crew);await page.getByRole('button',{name:'Start conversation',exact:true}).click();
  await expect(page.getByLabel('Message',{exact:true})).toBeEnabled();
}

test('renders inert Markdown with useful code, tables and text export',async({page,crew},info)=>{
  const markdown='# A useful result\n\n| Item | State |\n| --- | --- |\n| Plan | Ready |\n\n```ts\nconst answer = 42;\n```\n\n[Read more](https://example.test/docs)\n[Unsafe](javascript:alert(1))\n![Beacon](https://example.test/beacon.png)\n<script>window.__unsafe = true</script>';
  crew.faux.setResponses([fauxAssistantMessage(markdown)]);
  const external:string[]=[];page.on('request',r=>{if(r.url().startsWith('https://example.test/'))external.push(r.url());});
  await start(page,crew);await page.getByLabel('Message',{exact:true}).fill('Make a plan');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('table')).toContainText('Ready');await expect(page.locator('.message code')).toContainText('const answer = 42;');
  expect(await page.evaluate(()=>Boolean((window as unknown as {__unsafe?:boolean}).__unsafe))).toBe(false);
  await expect(page.getByRole('link',{name:'Unsafe',exact:true})).toHaveCount(0);expect(external).toEqual([]);
  await page.getByRole('button',{name:'Copy response',exact:true}).click();await expect(page.getByText('Copied.',{exact:true})).toBeVisible();
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download Markdown',exact:true}).click();
  const file=await downloaded;expect(file.suggestedFilename()).toMatch(/\.md$/);expect(await readFile((await file.path())!,'utf8')).toBe(markdown);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('conversation-markdown.png'),fullPage:true});
});

test('preserves drafts on failure, offline, navigation and authentication repair',async({page,context,crew})=>{
  await start(page,crew);const selected=page.url();
  let fail=true;await page.route('**/api/v1/sessions/*/messages',async route=>fail?route.abort('failed'):route.continue());
  await page.getByLabel('Message',{exact:true}).fill('Keep this draft');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Connection lost');await expect(page.getByLabel('Message',{exact:true})).toHaveValue('Keep this draft');
  await context.setOffline(true);await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeDisabled();
  await context.setOffline(false);await navigate(page,'Knowledge');await navigate(page,'Conversations');
  await expect(page).toHaveURL(selected);await expect(page.getByLabel('Message',{exact:true})).toHaveValue('Keep this draft');
  let expire=true;await page.route('**/api/v1/snapshot',async route=>expire?route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:{message:'Session expired'}})}):route.continue());
  await crew.ctx.store.transact(tx=>tx.emit('fixture.expire',{}));await expect(page.getByLabel('Login secret')).toBeVisible();
  expire=false;const secret=await openBrowserSessions(crew.ctx).issueBootstrap();await page.getByLabel('Login secret').fill(secret);await page.getByRole('button',{name:'Connect to instance'}).click();
  await expect(page.getByLabel('Message',{exact:true})).toHaveValue('Keep this draft');fail=false;
  await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('log').getByText('Direct reply from Ada.',{exact:true})).toBeVisible();await expect(page.getByLabel('Message',{exact:true})).toHaveValue('');
  expect((await crew.runtime.snapshot(new URL(selected).hash.slice('#conversations/'.length))).messages.filter(m=>m.kind==='user')).toHaveLength(1);
});

test('does not jump away from older output and offers return to latest',async({page,crew})=>{
  crew.faux.setResponses([fauxAssistantMessage(Array.from({length:65},(_,i)=>`Paragraph ${i}: this is a detailed result to read.`).join('\n\n')),fauxAssistantMessage('A later result')]);
  await start(page,crew);await page.getByLabel('Message',{exact:true}).fill('Explain the result');await page.getByRole('button',{name:'Send message',exact:true}).click();
  const log=page.getByRole('log',{name:'Conversation output'});await expect(log).toContainText('Paragraph 64');
  await expect.poll(()=>log.evaluate(e=>e.scrollTop>0)).toBe(true);
  await log.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  await page.getByLabel('Message',{exact:true}).fill('One follow up');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(log).toContainText('A later result');
  expect(await log.evaluate(e=>e.scrollTop)).toBe(0);
  await navigate(page,'Tasks');await navigate(page,'Conversations');expect(await log.evaluate(e=>e.scrollTop)).toBe(0);
  await page.getByRole('button',{name:'Return to latest',exact:true}).click();
  await expect.poll(()=>log.evaluate(e=>e.scrollHeight-e.scrollTop-e.clientHeight)).toBeLessThan(8);
});

test('stops an active direct conversation through the actual durable runtime',async({page,crew},info)=>{
  crew.faux.setResponses([fauxAssistantMessage(fauxToolCall('wait_for_stop',{}),{stopReason:'toolUse'})]);
  await start(page,crew);await page.getByLabel('Message',{exact:true}).fill('Wait for my stop');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('button',{name:'Stop conversation',exact:true})).toBeEnabled();
  await expect(page.locator('.conversation-heading').getByRole('status')).toContainText('Working');
  await expect(page.locator('.conversation-heading .busy-spinner')).toBeVisible();
  if(info.project.name==='mobile'){
    await page.setViewportSize({width:390,height:560});
    const send=await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();
    const navigation=await page.getByRole('navigation',{name:'Mobile navigation'}).boundingBox();
    expect(send!.y+send!.height).toBeLessThan(navigation!.y);
  }
  await page.getByRole('button',{name:'Stop conversation',exact:true}).click();
  const id=new URL(page.url()).hash.slice('#conversations/'.length);
  await expect.poll(async()=>(await crew.runtime.snapshot(id)).status).toBe('cancelled');
  await expect.poll(async()=>(await crew.ctx.store.read<{cancellationSettled?:boolean}>('runtime-session',id))?.cancellationSettled).toBe(true);
  await expect(page.getByLabel('Message',{exact:true})).toBeDisabled();
  await expect(page.locator('.conversation-heading .busy-spinner')).toHaveCount(0);
});

test('selects an agent without creating a chat until Start conversation is pressed',async({page,crew})=>{
  await connectWorkspace(page,crew);
  const lin=page.getByRole('button',{name:'Lin Review',exact:true});await lin.click();
  await expect(lin).toHaveAttribute('aria-pressed','true');
  expect(await crew.ctx.store.list('runtime-session')).toHaveLength(0);
  await page.getByRole('button',{name:'Start conversation',exact:true}).click();
  await expect(page).toHaveURL(/#conversations\/[a-f0-9]+$/);
  const id=new URL(page.url()).hash.slice('#conversations/'.length);
  expect((await crew.runtime.snapshot(id)).session.agentId).toBe('agent-lin');
  await expect(page.locator('.conversation-heading')).toContainText('Started');
  await expect(page.locator('.conversation-heading time')).toHaveCount(2);
  await expect(page.locator('.conversation-heading').getByRole('status')).toContainText('Ready');
});

test('orders by persisted activity while retaining the open conversation and focused row',async({page,crew},info)=>{
  const a=await crew.runtime.createSession({requestId:'activity-a',agentId:'agent-ada'});
  await crew.runtime.submit({sessionId:a.id,requestId:'activity-a-1',text:'Plan the garden'});
  await expect.poll(async()=>(await crew.runtime.snapshot(a.id)).status).toBe('completed');
  const b=await crew.runtime.createSession({requestId:'activity-b',agentId:'agent-ada'});
  await crew.runtime.submit({sessionId:b.id,requestId:'activity-b-1',text:'Review the release'});
  await expect.poll(async()=>(await crew.runtime.snapshot(b.id)).status).toBe('completed');
  await connectWorkspace(page,crew);const list=page.getByRole('list',{name:'Recent conversations'});
  await expect(list.getByRole('button').first()).toContainText('Review the release');
  if(info.project.name==='desktop')await list.getByRole('button').filter({hasText:'Review the release'}).focus();
  await crew.runtime.submit({sessionId:a.id,requestId:'activity-a-2',text:'Add a herb bed'});
  await expect(list.getByRole('button').first()).toContainText('Plan the garden');
  if(info.project.name==='desktop'){
    await expect(list.getByRole('button').filter({hasText:'Review the release'})).toBeFocused();
    await expect(page.getByRole('log')).toContainText('Review the release');
    await expect(page.getByRole('log')).not.toContainText('Add a herb bed');
    await page.getByLabel('Message',{exact:true}).fill('Keep reading the release');
  }
  await navigate(page,'Knowledge');await navigate(page,'Conversations');
  await expect(list.getByRole('button').filter({hasText:'Review the release'})).toHaveAttribute('aria-current','true');
  if(info.project.name==='desktop'){
    await expect(page.getByRole('log')).toContainText('Review the release');
    await expect(page.getByLabel('Message',{exact:true})).toHaveValue('Keep reading the release');
  }else await expect(page).not.toHaveURL(/#conversations\//);
  await expect(list.locator('time')).toHaveCount(2);
  await list.getByRole('button').first().click();await expect(page.getByRole('log')).toContainText('Add a herb bed');
  await expect(page.locator('.conversation-heading')).toContainText('Plan the garden');
  await page.screenshot({path:info.outputPath('conversation-refinements.png'),fullPage:true,animations:'disabled'});
});

test('skill loading explicitly selects the intended conversation without borrowing its default',async({page,crew})=>{
  await crew.vault.propose({id:'selection-skill',path:'skills/selection.md',expectedRevision:null,actor:'fixture',content:'---\n'+JSON.stringify({type:'Skill',title:'Selection',description:'Keep the chosen context',lorecrew:{skill:{schemaVersion:1,name:'selection',scope:'global',status:'active',resources:[]}}})+'\n---\nKeep context.\n'});
  await crew.runtime.createSession({requestId:'selection-one',agentId:'agent-ada'});
  await crew.runtime.createSession({requestId:'selection-two',agentId:'agent-ada'});
  const records=await crew.ctx.store.list<import('../../src/runtime/types.js').SessionRecord>('runtime-session');
  const chosen=records[1]!.session;
  await crew.runtime.submit({sessionId:chosen.id,requestId:'selection-message',text:'The latest conversation'});
  await expect.poll(async()=>(await crew.runtime.snapshot(chosen.id)).status).toBe('completed');
  await connectWorkspace(page,crew);
  await navigate(page,'Skills');
  const inspection=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/skills/inspection');
  await page.getByRole('button',{name:/global\/selection Active/}).click();
  expect(new URL((await inspection).url()).searchParams.get('sessionId')).toBeNull();
  await expect(page.getByRole('button',{name:'Load for task',exact:true})).toBeDisabled();
  const selectedInspection=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/skills/inspection'&&new URL(r.url()).searchParams.get('sessionId')===chosen.id);
  await page.getByLabel('Trial / load context').selectOption(chosen.id);await selectedInspection;
  const load=page.waitForRequest(r=>new URL(r.url()).pathname==='/api/v1/skills/load');
  await page.getByRole('button',{name:'Load for task',exact:true}).click();
  expect((await load).postDataJSON().sessionId).toBe(chosen.id);
  await expect(page.getByText(/loaded and pinned to this task/)).toBeVisible();
  expect(await crew.ctx.store.list('skill-pin')).toMatchObject([{sessionId:chosen.id,qualifiedId:'global/selection'}]);
});

test('reports an unconfirmed task stop and offers a fresh retry',async({page,crew})=>{
  const task=await crew.runtime.team.createTask({requestId:'stop-ui',projectId:'project',leadAgentId:'agent-ada',objective:'A task to stop'});
  await connectWorkspace(page,crew);await page.goto(crew.url+'/#tasks/'+task.id);
  let attempts=0;await page.route('**/api/v1/tasks/*/cancel',async route=>{attempts++;if(attempts===1)await route.fulfill({contentType:'application/json',body:JSON.stringify({quiescent:false,reason:'Process identity remains uncertain'})});else await route.continue();});
  await page.getByRole('button',{name:'Stop task',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Process identity remains uncertain');
  await page.getByRole('button',{name:'Retry stop',exact:true}).click();await expect.poll(async()=>(await crew.runtime.team.getTask(task.id)).state).toBe('cancelled');
  expect(attempts).toBe(2);
});

test('keeps the phone composer above navigation when the viewport shrinks',async({page,crew},info)=>{
  test.skip(info.project.name!=='mobile','Narrow viewport keyboard reflow.');
  crew.faux.setResponses([fauxAssistantMessage(Array.from({length:30},()=> 'A detailed paragraph to read.').join('\n\n'))]);
  await start(page,crew);await page.getByLabel('Message',{exact:true}).fill('Plan a thoughtful week with space for focused work and a little time outdoors');await page.getByRole('button',{name:'Send message',exact:true}).click();
  await expect(page.getByRole('log')).toContainText('A detailed paragraph to read.');
  await page.getByRole('log').evaluate(element=>{element.scrollTop=0;element.dispatchEvent(new Event('scroll'));});
  await expect(page.getByRole('button',{name:'Return to latest',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:560});
  const field=await page.getByLabel('Message',{exact:true}).boundingBox();
  const send=await page.getByRole('button',{name:'Send message',exact:true}).boundingBox();
  expect(field!.y+field!.height).toBeLessThan(486);expect(send!.y+send!.height).toBeLessThan(486);
  const log=await page.getByRole('log').boundingBox();
  const latest=await page.getByRole('button',{name:'Return to latest',exact:true}).boundingBox();
  const detail=await page.locator('.conversation-detail').boundingBox();
  expect(log!.height).toBeGreaterThanOrEqual(52);
  expect(latest!.y).toBeGreaterThanOrEqual(log!.y);
  expect(send!.y+send!.height).toBeLessThan(detail!.y+detail!.height-4);
});

test('retains real unconfirmed stop state across navigation and reload until proven',async({page,crew})=>{
  const task=await crew.runtime.team.createTask({requestId:'persistent-stop',projectId:'project',leadAgentId:'agent-ada',objective:'Stop proof across pages'});
  const original=crew.supervisor.stopWorkspace.bind(crew.supervisor);
  crew.supervisor.stopWorkspace=async()=>({quiescent:false,reason:'Uncertain process fixture'});
  try {
    await connectWorkspace(page,crew);await page.goto(crew.url+'/#tasks/'+task.id);
    await page.getByRole('button',{name:'Stop task',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('process stop is unconfirmed');
    expect((await crew.runtime.team.getTask(task.id)).state).toBe('cancelled');
    await navigate(page,'Knowledge');await navigate(page,'Tasks');
    await expect(page.getByRole('button',{name:'Retry stop',exact:true})).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('process stop is unconfirmed');
    await page.reload();await expect(page.getByRole('button',{name:'Retry stop',exact:true})).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('process stop is unconfirmed');
    crew.supervisor.stopWorkspace=original;
    await page.getByRole('button',{name:'Retry stop',exact:true}).click();
    await expect(page.getByRole('button',{name:'Retry stop',exact:true})).toHaveCount(0);await expect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(async()=>(await crew.ctx.store.read<{cancellationSettled?:boolean}>('runtime-session',task.executingSessionId))?.cancellationSettled).toBe(true);
  }finally{crew.supervisor.stopWorkspace=original;}
});

test('preserves selected table text, table position and focused links during snapshot updates',async({page,crew})=>{
  const columns=Array.from({length:40},(_,i)=>'Column '+i);
  const markdown='| '+columns.join(' | ')+' |\n| '+columns.map(()=> '---').join(' | ')+' |\n| '+columns.map((_,i)=>i===0?'Selection':'Value').join(' | ')+' |\n\n[Reference](https://example.test/reference)';
  crew.faux.setResponses([fauxAssistantMessage(markdown),fauxAssistantMessage('First refresh marker'),fauxAssistantMessage('Second refresh marker')]);
  await start(page,crew);await page.getByLabel('Message',{exact:true}).fill('Show the table');await page.getByRole('button',{name:'Send message',exact:true}).click();
  const cell=page.getByRole('cell',{name:'Selection',exact:true});await expect(cell).toBeVisible();
  const table=page.getByRole('region',{name:'Response table'});
  await table.evaluate(e=>{e.scrollLeft=120;});
  await cell.evaluate(e=>{const range=document.createRange();range.selectNodeContents(e);const selection=window.getSelection();selection?.removeAllRanges();selection?.addRange(range);});
  expect(await page.evaluate(()=>window.getSelection()?.toString())).toBe('Selection');
  const id=new URL(page.url()).hash.slice('#conversations/'.length);
  await crew.runtime.submit({sessionId:id,requestId:'first-table-update',text:'Refresh one'});await expect(page.getByRole('log')).toContainText('First refresh marker');
  expect(await page.evaluate(()=>window.getSelection()?.toString())).toBe('Selection');expect(await table.evaluate(e=>e.scrollLeft)).toBe(120);
  const link=page.getByRole('link',{name:'Reference',exact:true});await link.focus();
  await crew.runtime.submit({sessionId:id,requestId:'second-table-update',text:'Refresh two'});await expect(page.getByRole('log')).toContainText('Second refresh marker');await expect(link).toBeFocused();
});
