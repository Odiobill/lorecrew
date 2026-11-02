import { expect, type Page } from '@playwright/test';
import type { localTeam } from './local-team.js';

export async function connectWorkspace(page:Page,crew:Pick<Awaited<ReturnType<typeof localTeam>>,'url'|'secret'>) {
  await page.goto(crew.url);
  await page.getByLabel('Login secret').fill(crew.secret);
  await page.getByRole('button',{name:'Connect to instance'}).click();
  await expect(page.getByTestId('instance-name')).toHaveText('Desktop');
  await expect(page.getByRole('status').first()).toContainText('Connected · local instance');
}

export async function navigate(page:Page,name:string) {
  const link=page.getByRole('navigation').getByRole('link',{name,exact:true});
  const more=page.getByRole('button',{name:'More',exact:true});
  await expect.poll(async()=>await link.isVisible()||await more.isVisible()).toBe(true);
  if(!await link.isVisible())await more.click();
  await link.click();
}
export async function chooseAppearance(page:Page,appearance:string){
 const previous=await page.evaluate(()=>location.hash);await page.evaluate(()=>{location.hash='#settings';});const group=page.getByRole('group',{name:'Appearance',exact:true});const label=appearance.replace(' theme','');await group.getByRole('button',{name:label.slice(0,1).toUpperCase()+label.slice(1),exact:true}).click();await expect(group.getByRole('button',{name:label.slice(0,1).toUpperCase()+label.slice(1),exact:true})).toHaveAttribute('aria-pressed','true');await page.evaluate(hash=>{location.hash=hash;},previous);
}
