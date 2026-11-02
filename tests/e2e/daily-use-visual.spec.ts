import { chooseAppearance } from '../helpers/browser-workspace.js';
import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {dailyPreview} from '../helpers/daily-preview.js';
import {connectWorkspace,navigate} from '../helpers/browser-workspace.js';
test('built M5 visual matrix, keyboard navigation, reduced motion and CSS 200% reflow',async({page},info)=>{
 test.skip(info.project.name==='mobile','This matrix explicitly includes all three viewport widths.');
 const crew=await dailyPreview();try{
  await connectWorkspace(page,crew);await navigate(page,'Inbox');const directory=resolve('test-results/references');await mkdir(directory,{recursive:true});
  for(const width of [390,768,1440])for(const theme of ['light','dark','system']){
   await page.setViewportSize({width,height:width===390?844:1000});await page.emulateMedia({colorScheme:theme==='system'?'dark':'light',reducedMotion:'reduce'});await chooseAppearance(page,theme);
   await expect(page.getByRole('heading',{name:'Inbox',exact:true})).toBeVisible();await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(a=>Number.isFinite(a.effect?.getComputedTiming().endTime)).map(a=>a.finished.catch(()=>{})));});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:resolve(directory,`m5-inbox-${width}-${theme}.png`),fullPage:true});
  }
  for(const [name,route] of [['routines','Routines'],['learning','Learning']] as const)for(const width of [390,768,1440]){
   await page.setViewportSize({width,height:width===390?844:1000});await navigate(page,route);await expect(page.getByRole('heading',{name:route,exact:true})).toBeVisible();
   if(name==='routines'){await page.getByRole('button',{name:'Edit daily-review',exact:true}).click();await expect(page.getByLabel('IANA timezone')).toHaveValue('Europe/Rome');}
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:resolve(directory,`m5-${name}-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Install & updates',exact:true}).click();await page.screenshot({path:resolve(directory,'m5-install-phone.png'),fullPage:true});await page.getByRole('button',{name:'Install & updates',exact:true}).click();
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.style.zoom='2');await navigate(page,'Inbox');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:resolve(directory,'m5-css-200-percent.png'),fullPage:true});await page.evaluate(()=>document.documentElement.style.zoom='');
  await navigate(page,'Routines');await page.getByRole('button',{name:'Cancel edit',exact:true}).click();
  // Fresh document, then only keyboard input through navigation and the editor.
  await page.goto(crew.url+'/#inbox');await expect(page.getByRole('heading',{name:'Inbox',exact:true})).toBeVisible();
  for(let i=0;i<40;i++){await page.keyboard.press('Tab');if(await page.evaluate(()=>document.activeElement?.getAttribute('href')==='#routines'))break;}
  await expect(page.getByRole('navigation',{name:'Main'}).getByRole('link',{name:'Routines',exact:true})).toBeFocused();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Routines',exact:true})).toBeVisible();await page.keyboard.press('Tab');await expect(page.getByLabel('Schedule ID')).toBeFocused();await page.keyboard.type('keyboard-routine');await expect(page.getByLabel('Schedule ID')).toHaveValue('keyboard-routine');await page.screenshot({path:resolve(directory,'m5-keyboard.png'),fullPage:true});
 }finally{await crew.close();}
});
