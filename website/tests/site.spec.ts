import {test,expect} from '@playwright/test';
test('workflow tabs support pointer and keyboard without network model calls',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const requests:string[]=[];page.on('request',r=>requests.push(r.url()));
 await page.goto('./');
 await page.getByRole('tab',{name:'Personal assistance'}).click();
 await expect(page.getByRole('tabpanel')).toContainText('no coding project');
 await page.getByRole('tab',{name:'Personal assistance'}).press('ArrowLeft');
 await expect(page.getByRole('tab',{name:'Build software'})).toBeFocused();
 await expect(page.getByRole('tabpanel')).toContainText('Project workspace');
 expect(errors).toEqual([]);expect(requests.every(u=>new URL(u).origin===new URL(page.url()).origin)).toBe(true);
});
test('local search finds relevant guides, handles no matches and restores focus',async({page},info)=>{
 await page.goto('./');
 if(info.project.name==='mobile')await page.getByRole('button',{name:'Open navigation'}).click();
 const trigger=page.locator('.search-trigger');await trigger.click();
 const input=page.getByRole('searchbox',{name:'Search documentation'});await expect(input).toBeFocused();
 await input.fill('project ownership');
 await expect(page.locator('#search-results a').first()).toContainText('Projects');
 await input.fill('zzzzzzzzzzzz');await expect(page.locator('#search-results')).toContainText('No matching guides');
 await input.press('Escape');await expect(page.getByRole('dialog')).not.toBeVisible();await expect(trigger).toBeFocused();
 await page.keyboard.press('Control+k');await expect(input).toBeFocused();
 await input.fill('backup');await page.locator('#search-results a').first().click();
 await expect(page).toHaveURL(/\/lorecrew\/docs\/backup-and-recovery\/$/);await expect(page.locator('h1')).toHaveText('Backup and recovery');
});
test('copy reports success and honest clipboard failure',async({page,context})=>{
 await context.grantPermissions(['clipboard-read','clipboard-write']);await page.goto('./');
 await page.getByRole('button',{name:'Copy setup commands'}).click();await expect(page.getByRole('status')).toHaveText('Setup commands copied.');
 expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('git clone https://github.com/Odiobill/lorecrew.git');
 await page.evaluate(()=>Object.defineProperty(navigator.clipboard,'writeText',{value:()=>Promise.reject(new Error('Denied'))}));
 await page.getByRole('button',{name:'Copy setup commands'}).click();await expect(page.getByRole('status')).toContainText('Copy was blocked');
});
test('responsive navigation, guides and FAQ remain usable without overflow',async({page},info)=>{
 await page.goto('./');
 if(info.project.name==='mobile'){
  const menu=page.locator('.menu-toggle');await expect(menu).toHaveAccessibleName('Open navigation');await menu.click();await expect(menu).toHaveAttribute('aria-expanded','true');
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Documentation'}).click();
 }else await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Documentation'}).click();
 await page.getByRole('link',{name:/Projects/}).first().click();await expect(page.locator('h1')).toHaveText('Projects');
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.goto('./');await page.getByText('Does every model run locally?',{exact:false}).click();
 await expect(page.locator('details[open]')).toContainText('remote provider');
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('home.png'),fullPage:true});
});
test('reading and navigation work without JavaScript',async({browser,baseURL})=>{
 const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}});const page=await context.newPage();
 await page.goto(baseURL!);await expect(page.locator('h1')).toContainText('Build a crew.');
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('link',{name:'Documentation'}).click();
 await page.getByRole('link',{name:/Getting started/}).first().click();await expect(page.locator('h1')).toHaveText('Getting started');
 await expect(page.getByRole('navigation',{name:'Guide navigation'})).toBeVisible();
 await context.close();
});
test('reduced motion preserves content and tablet layout',async({page})=>{
 await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:768,height:1024});await page.goto('./');
 expect(await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto');
 await expect(page.getByRole('heading',{name:/Independent hosts/})).toBeVisible();
 await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
