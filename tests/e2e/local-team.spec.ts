import { navigate } from '../helpers/browser-workspace.js';
import { test as base, expect } from '@playwright/test';
import { localTeam } from '../helpers/local-team.js';
const test=base.extend<{crew:Awaited<ReturnType<typeof localTeam>>;insecureOrigin:boolean}>({insecureOrigin:[false,{option:true}],crew:async({insecureOrigin},use)=>{const crew=await localTeam(insecureOrigin?{publicHostname:'lorecrew.test'}:{});try{await use(crew);}finally{await crew.close();}}});

test('local teamwork, keyboard decision, direct chat, diff and cursor recovery',async({page,context,crew},info)=>{
  await page.goto(crew.url+'/#tasks');
  await page.getByLabel('Login secret').fill(crew.secret);
  await page.getByRole('button',{name:'Connect to instance'}).click();
  await expect(page.getByTestId('instance-name')).toHaveText('Desktop');
  await page.getByLabel('Task objective').fill('Improve team greeting');
  await page.getByRole('button',{name:'Assign task',exact:true}).click();
  await expect(page.getByText('Waiting for your decision',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Inspect greeting',exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath(`${info.project.name}-decision.png`),fullPage:true});
  await page.getByRole('button',{name:'Inspect greeting',exact:true}).click();
  await page.getByRole('button',{name:'Inspect changes'}).click();
  await expect(page.getByTestId('diff')).toContainText('+Hello from the local team!');
  const answer=page.getByLabel('Your answer');await answer.focus();await page.keyboard.type('Use the friendly greeting');await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Send answer'})).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.getByText('Completed',{exact:true}).first()).toBeVisible();
  await expect.poll(async()=> (await crew.ctx.store.list<{state:string}>('team-task')).every(t=>t.state==='completed')).toBe(true);
  await navigate(page,'Conversations');
  await page.getByRole('button',{name:'Start conversation'}).click();
  await page.getByLabel('Message').fill('Hello Ada');await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByRole('log').getByText('Direct reply from Ada.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByTestId('instance-name')).toHaveText('Desktop');
  // Exercise an actual retention reset. The stored cursor is harmless metadata, never transcript data.
  await crew.ctx.store.transact(tx=>{for(let n=0;n<10_005;n++)tx.emit('fixture.retention',{n});});
  await page.evaluate(()=>sessionStorage.setItem('lorecrew:event-cursor','1'));
  const requests:string[]=[];
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/v1/snapshot')requests.push('snapshot');if(url.pathname==='/api/v1/events')requests.push('events:'+url.searchParams.get('after'));});
  const reset=page.waitForResponse(r=>{const url=new URL(r.url());return url.pathname==='/api/v1/events'&&url.searchParams.get('after')==='1';});
  await page.reload();const resetResponse=await reset;expect(resetResponse.headers()['content-type']).toContain('text/event-stream');
  await expect.poll(()=>requests.slice(requests.indexOf('events:1')+1).includes('snapshot')).toBe(true);
  await expect.poll(()=>page.evaluate(()=>Number(sessionStorage.getItem('lorecrew:event-cursor')))).toBeGreaterThan(10_000);
  await expect.poll(()=>requests.some(path=>path.startsWith('events:')&&Number(path.slice(7))>10_000)).toBe(true);
  await expect(page.locator('.connection[role=status]')).toContainText('Connected · local instance');
  await context.setOffline(true);await expect(page.locator('.connection[role=status]')).toContainText('Unavailable offline');
  await navigate(page,'Tasks');await expect(page.getByRole('button',{name:'Assign task',exact:true})).toBeDisabled();
  await context.setOffline(false);await expect(page.locator('.connection[role=status]')).toContainText('Connected · local instance');
  await page.screenshot({path:info.outputPath(`${info.project.name}-complete.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('browser close keeps server work and retry uses the same acknowledged command',async({page,context,crew})=>{
  await page.goto(crew.url+'/#tasks');await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();
  const keys:string[]=[];let lost=false;
  await page.route('**/api/v1/tasks',async route=>{if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']!);if(!lost){lost=true;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.getByLabel('Task objective').fill('Improve team greeting');await page.getByRole('button',{name:'Assign task',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Connection lost');
  await page.getByRole('button',{name:'Assign task',exact:true}).click();
  await expect(page.getByText('Waiting for your decision',{exact:true})).toBeVisible();
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);expect((await crew.ctx.store.list<{parentTaskId?:string}>('team-task')).filter(t=>!t.parentTaskId)).toHaveLength(1);
  await page.close();
  const reopened=await context.newPage();await reopened.goto(crew.url+'/#tasks');await reopened.getByRole('button',{name:'Improve team greeting',exact:true}).click();
  await expect(reopened.getByText('Waiting for your decision',{exact:true})).toBeVisible();
  await reopened.getByLabel('Your answer').fill('Use the friendly greeting');await reopened.getByRole('button',{name:'Send answer'}).click();
  await expect.poll(async()=> (await crew.ctx.store.list<{state:string}>('team-task')).every(t=>t.state==='completed')).toBe(true);
});

test('public assets preserve private-route boundaries and offline never replays API data',async({page,context,crew})=>{
  for(const path of ['/api/unknown','/auth/unknown','/%61pi/unknown','/%61uth/unknown','/assets/%2f..%2fpackage.json']) {
    const response=await context.request.get(crew.url+path);expect(response.status(),path).toBe(404);expect(response.headers()['content-type']).not.toContain('text/html');
  }
  const protectedRoute=await context.request.get(crew.url+'/%61pi/v1/snapshot');expect(protectedRoute.status()).toBe(401);expect(protectedRoute.headers()['content-type']).not.toContain('text/html');
  await page.goto(crew.url+'/#tasks');await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();await expect(page.getByTestId('instance-name')).toHaveText('Desktop');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.reload();await expect(page.getByTestId('instance-name')).toHaveText('Desktop');
  await expect.poll(async()=>page.evaluate(async()=>{const names=await caches.keys();const urls=await Promise.all(names.map(async name=>(await (await caches.open(name)).keys()).map(request=>new URL(request.url).pathname)));return urls.flat();})).toEqual(expect.arrayContaining([expect.stringMatching(/^\/assets\/.*\.js$/)]));
  const cached=await page.evaluate(async()=>{const urls=await Promise.all((await caches.keys()).map(async name=>(await (await caches.open(name)).keys()).map(request=>new URL(request.url).pathname)));return urls.flat();});
  expect(cached.length).toBeGreaterThan(0);for(const path of cached)expect(path).toMatch(/^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/);
  await context.setOffline(true);await page.reload();await expect(page.getByRole('heading',{name:'Unavailable offline'})).toBeVisible();
});


test.describe('explicit insecure LAN HTTP capability',()=>{
  test.use({insecureOrigin:true});
  test('mutations work when randomUUID is unavailable',async({page,crew})=>{
    await page.goto(crew.url+'/#tasks');
    expect(await page.evaluate(()=>({secure:isSecureContext,uuid:typeof crypto.randomUUID,random:typeof crypto.getRandomValues}))).toEqual({secure:false,uuid:'undefined',random:'function'});
    await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();
    await page.getByLabel('Task objective').fill('Improve team greeting');await page.getByRole('button',{name:'Assign task',exact:true}).click();
    await expect(page.getByText('Waiting for your decision',{exact:true})).toBeVisible();
    await page.getByLabel('Task guidance').fill('Keep the greeting concise');await page.getByRole('button',{name:'Send guidance'}).click();await expect(page.getByLabel('Task guidance')).toHaveValue('');
    await page.getByLabel('Your answer').fill('Use the friendly greeting');await page.getByRole('button',{name:'Send answer'}).click();await expect(page.getByText('Completed',{exact:true}).first()).toBeVisible();
    await navigate(page,'Conversations');await page.getByRole('button',{name:'Start conversation'}).click();
    await page.getByLabel('Message').fill('LAN HTTP direct message');await page.getByRole('button',{name:'Send message'}).click();await expect(page.getByRole('log').getByText('Direct reply from Ada.',{exact:true})).toBeVisible();
  });
});

test('acknowledged commands clear forms and snapshot retry only refreshes state',async({page,crew})=>{
  await page.goto(crew.url+'/#tasks');await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();
  await expect(page.locator('.connection[role=status]')).toContainText('Connected · local instance');
  let target='';let snapshotUnavailable=false;let readRecovery:Promise<void>|undefined;let releaseRead:(()=>void)|undefined;const posts:string[]=[];
  await page.route('**/api/v1/**',async route=>{
    const request=route.request();const path=new URL(request.url()).pathname;
    if(path==='/api/v1/snapshot'){if(snapshotUnavailable&&!readRecovery)return route.abort('failed');if(readRecovery)await readRecovery;const response=await route.fetch();return snapshotUnavailable?route.abort('failed'):route.fulfill({response});}
    if(request.method()==='POST'&&path===target){posts.push(path);const response=await route.fetch();expect(response.ok()).toBe(true);snapshotUnavailable=true;return route.fulfill({response});}
    return route.continue();
  });
  async function retrySnapshot(){
    await expect(page.getByRole('button',{name:'Refresh team state'})).toBeVisible();
    const count=posts.length;
    // Hold any automatic read until the actual retry click has finished dispatching.
    readRecovery=new Promise<void>(resolve=>{releaseRead=resolve;});
    await page.getByRole('button',{name:'Refresh team state'}).click();
    snapshotUnavailable=false;releaseRead!();releaseRead=undefined;readRecovery=undefined;
    await expect(page.getByRole('button',{name:'Refresh team state'})).toHaveCount(0);
    expect(posts).toHaveLength(count);
  }
  try {
  target='/api/v1/tasks';
  await page.getByLabel('Task objective').fill('Improve team greeting');await page.getByRole('button',{name:'Assign task',exact:true}).click();
  await expect(page.getByLabel('Task objective')).toHaveValue('');await retrySnapshot();
  await expect(page.getByText('Waiting for your decision',{exact:true})).toBeVisible();
  const root=(await crew.ctx.store.list<{id:string;parentTaskId?:string;executingSessionId:string}>('team-task')).find(task=>!task.parentTaskId)!;
  target=`/api/v1/tasks/${root.id}/steer`;
  await page.getByLabel('Task guidance').fill('Only one acknowledged guidance');await page.getByRole('button',{name:'Send guidance'}).click();
  await expect(page.getByLabel('Task guidance')).toHaveValue('');await retrySnapshot();
  const decision=(await crew.ctx.store.list<{id:string}>('team-decision'))[0]!;target=`/api/v1/decisions/${encodeURIComponent(decision.id)}/answer`;
  await page.getByLabel('Your answer').fill('Use the friendly greeting');await page.getByRole('button',{name:'Send answer'}).click();
  await expect(page.getByText('Answer sent.',{exact:true})).toBeVisible();await retrySnapshot();
  await expect.poll(async()=>(await crew.ctx.store.list<{state:string}>('team-task')).every(task=>task.state==='completed')).toBe(true);
  await navigate(page,'Conversations');target='';
  await page.getByRole('button',{name:'Start conversation'}).click();await expect(page.getByLabel('Message')).toBeEnabled();
  const sessions=await crew.ctx.store.list<{session:{id:string};input:{teamTaskId?:string}}>('runtime-session');const direct=sessions.find(session=>!session.input.teamTaskId)!;
  target=`/api/v1/sessions/${direct.session.id}/messages`;
  await page.getByLabel('Message').fill('Only one acknowledged direct message');await page.getByRole('button',{name:'Send message'}).click();
  await expect(page.getByLabel('Message')).toHaveValue('');await retrySnapshot();
  expect(posts).toEqual(['/api/v1/tasks',`/api/v1/tasks/${root.id}/steer`,`/api/v1/decisions/${encodeURIComponent(decision.id)}/answer`,`/api/v1/sessions/${direct.session.id}/messages`]);
  expect((await crew.ctx.store.list<{parentTaskId?:string}>('team-task')).filter(task=>!task.parentTaskId)).toHaveLength(1);
  expect((await crew.runtime.snapshot(root.executingSessionId)).messages.filter(message=>message.kind==='user'&&JSON.stringify(message.data).includes('Only one acknowledged guidance'))).toHaveLength(1);
  expect((await crew.runtime.snapshot(direct.session.id)).messages.filter(message=>message.kind==='user'&&JSON.stringify(message.data).includes('Only one acknowledged direct message'))).toHaveLength(1);
  } finally {
    // Drain intercepted HTTP reads before the server fixture closes its listener.
    snapshotUnavailable=false;releaseRead?.();readRecovery=undefined;
    await page.unrouteAll({behavior:'wait'});
    await page.close();
  }
});
