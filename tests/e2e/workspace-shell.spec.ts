import { test as base, expect } from '@playwright/test';
import { localTeam } from '../helpers/local-team.js';
import { connectWorkspace, navigate } from '../helpers/browser-workspace.js';
const test=base.extend<{crew:Awaited<ReturnType<typeof localTeam>>}>({crew:async({},use)=>{
  const crew=await localTeam();try{await use(crew);}finally{await crew.close();}
}});

test('lands in conversations without creating work and switches persistent appearance',async({page,crew},info)=>{
  const commands:string[]=[];page.on('request',r=>{if(r.method()==='POST'&&!r.url().includes('/auth/'))commands.push(new URL(r.url()).pathname);});
  await connectWorkspace(page,crew);
  await expect(page.getByRole('heading',{name:'Conversations',exact:true})).toBeVisible();
  expect(commands).toEqual([]);
  await navigate(page,'Settings');await expect(page.locator('header').getByRole('combobox',{name:'Appearance'})).toHaveCount(0);
  await page.getByRole('group',{name:'Appearance',exact:true}).getByRole('button',{name:'Dark',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await expect(page.getByRole('status').first()).toContainText('Connected · local instance');
  await page.screenshot({path:info.outputPath('workspace-dark.png'),fullPage:true});
  await page.getByRole('group',{name:'Appearance',exact:true}).getByRole('button',{name:'Light',exact:true}).click();
  await page.screenshot({path:info.outputPath('workspace-light.png'),fullPage:true});
  await page.getByRole('group',{name:'Appearance',exact:true}).getByRole('button',{name:'System',exact:true}).click();await page.emulateMedia({colorScheme:'dark'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.emulateMedia({colorScheme:'light'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('keeps every existing destination reachable and recovers unknown links',async({page,crew})=>{
  await connectWorkspace(page,crew);
  for(const [name,heading] of [['Projects','Projects'],['Agents','Agents'],['Groups','Groups'],['Tasks','Tasks'],['Knowledge','Knowledge'],['Skills','Skills'],['Learning','Learning'],['Routines','Routines'],['Remote status','Last synchronized'],['Settings','Settings']]) {
    await navigate(page,name!);
    await expect(page.getByRole('heading',{name:heading!,exact:true}).first()).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.goto(crew.url+'/#does-not-exist');
  await expect(page.getByRole('heading',{name:'Page not found'})).toBeVisible();
  await page.getByRole('link',{name:'Go to conversations'}).click();
  await expect(page.getByRole('heading',{name:'Conversations',exact:true})).toBeVisible();
});

test('uses stable conversation links and reports missing entities honestly',async({page,crew})=>{
  await connectWorkspace(page,crew);
  await page.getByRole('button',{name:'Start conversation',exact:true}).click();
  await expect(page).toHaveURL(/#conversations\/[a-f0-9]+$/);
  const selected=page.url();
  await page.getByLabel('Message',{exact:true}).fill('A draft for this conversation');
  await navigate(page,'Tasks');await page.goBack();
  await expect(page).toHaveURL(selected);
  await expect(page.getByLabel('Message',{exact:true})).toHaveValue('A draft for this conversation');
  await page.reload();await expect(page).toHaveURL(selected);
  await page.goto(crew.url+'/#conversations/missing-session');
  await expect(page.getByRole('heading',{name:'Conversation not found'})).toBeVisible();
  await expect(page.getByLabel('Message',{exact:true})).toHaveCount(0);
});

test('mobile More supports keyboard dismissal and closes when reselecting a page',async({page,crew},info)=>{
  test.skip(info.project.name!=='mobile','The More panel is a narrow-screen navigation control.');
  await connectWorkspace(page,crew);const more=page.getByRole('button',{name:'More',exact:true});
  await more.click();
  await expect(page.getByRole('navigation',{name:'More destinations'}).getByRole('link',{name:'Projects',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');await expect(more).toBeFocused();await expect(more).toHaveAttribute('aria-expanded','false');
  await navigate(page,'Settings');await more.click();await page.getByRole('navigation',{name:'More destinations'}).getByRole('link',{name:'Settings',exact:true}).click();
  await expect(more).toHaveAttribute('aria-expanded','false');
});
test('appearance remains usable when browser preference storage is unavailable',async({page,crew})=>{
 await page.addInitScript(()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw new DOMException('Storage unavailable');}});});await connectWorkspace(page,crew);await navigate(page,'Settings');const group=page.getByRole('group',{name:'Appearance',exact:true});await group.getByRole('button',{name:'Dark',exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('html')).toHaveAttribute('data-theme','dark');await expect(group.getByRole('button',{name:'Dark',exact:true})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
