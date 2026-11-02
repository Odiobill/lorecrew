import {chromium,expect} from '@playwright/test';
import {localTeam} from './local-team.js';
import {connectWorkspace} from './browser-workspace.js';
import {mkdir} from 'node:fs/promises';
const crew=await localTeam();const browser=await chromium.launch({headless:true});
const output='test-results/references';await mkdir(output,{recursive:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await connectWorkspace(page,crew);await page.goto(crew.url+'/#agents/agent-ada');await expect(page.getByLabel('Agent name',{exact:true})).toBeEnabled();
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:width===390?844:1000});
  for(const theme of ['light','dark']){
   await page.getByLabel('Appearance',{exact:true}).selectOption(theme);
   for(const [kind,id] of [['agents','agent-ada'],['groups','group-engineering']]){
    await page.goto(crew.url+'/#'+kind+'/'+id);await expect(page.getByRole('heading',{name:kind==='agents'?'Agent details':'Group details'})).toBeVisible();await expect(page.getByLabel(kind==='agents'?'Agent name':'Group name',{exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${output}/m3-${kind}-${width}-${theme}.png`,fullPage:true});
   }
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.goto(crew.url+'/#agents/agent-ada');await page.getByLabel('Appearance',{exact:true}).selectOption('system');await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 // CSS document zoom exercises reflow, not native browser zoom controls.
 await page.evaluate(()=>document.documentElement.style.zoom='2');await page.screenshot({path:`${output}/m3-agents-zoom-reflow.png`,fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(()=>document.documentElement.style.zoom='1');await page.emulateMedia({colorScheme:'light',reducedMotion:'reduce'});await expect(page.locator('html')).toHaveAttribute('data-theme','light');await page.getByLabel('Agent name',{exact:true}).focus();await page.keyboard.press('Tab');await expect(page.getByLabel('Personality',{exact:true})).toBeFocused();
 await page.setViewportSize({width:390,height:844});await page.getByRole('link',{name:'Back to agents',exact:true}).click();await page.getByRole('button',{name:'More',exact:true}).click();await expect(page.getByRole('navigation',{name:'More destinations'}).getByRole('link',{name:'Agents',exact:true})).toBeFocused();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'More',exact:true})).toBeFocused();
 console.log('Team visual checks passed: 390/768/1440px, light/dark/system, reduced motion, keyboard and 200% document reflow.');
}finally{await browser.close();await crew.close();}
