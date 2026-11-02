import { test,expect } from '@playwright/test';
import { localTeam } from '../helpers/local-team.js';
import { connectWorkspace } from '../helpers/browser-workspace.js';
test('existing vault browses freely; missing credentials suspend deliberate use until explicit continuation',async({page})=>{
 const crew=await localTeam();try{let ready=false;await page.route('**/api/v1/agents/*/readiness',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({response,json:{...data,model:{provider:'openai',modelId:'test-model'},state:ready?'ready':'missing_credentials'}});});
 await connectWorkspace(page,crew);await expect(page.getByRole('dialog')).toHaveCount(0);const before=(await crew.ctx.store.list('runtime-session')).length;
 await page.getByRole('button',{name:'Start conversation',exact:true}).click();const repair=page.getByRole('dialog',{name:'Connect this agent'});await expect(repair).toBeVisible();await expect(repair.getByLabel('Provider',{exact:true})).toHaveValue('openai');expect((await crew.ctx.store.list('runtime-session')).length).toBe(before);await repair.getByRole('button',{name:'Cancel action',exact:true}).click();await expect(repair).toHaveCount(0);expect((await crew.ctx.store.list('runtime-session')).length).toBe(before);
 await page.getByRole('button',{name:'Start conversation',exact:true}).click();await expect(repair).toBeVisible();ready=true;await repair.getByRole('button',{name:'Check connection',exact:true}).click();await expect(repair.getByRole('button',{name:'Continue action',exact:true})).toBeEnabled();expect((await crew.ctx.store.list('runtime-session')).length).toBe(before);await repair.getByRole('button',{name:'Continue action',exact:true}).click();await expect(page.getByLabel('Message',{exact:true})).toBeVisible();expect((await crew.ctx.store.list('runtime-session')).length).toBe(before+1);
 }finally{await crew.close();}
});
