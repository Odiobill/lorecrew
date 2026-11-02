import { navigate } from '../helpers/browser-workspace.js';
import { test as base, expect } from '@playwright/test';
import { localTeam } from '../helpers/local-team.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const test=base.extend<{crew:Awaited<ReturnType<typeof localTeam>>}>({crew:async({},use)=>{const crew=await localTeam();try{await use(crew);}finally{await crew.close();}}});
test('masked provider entry, replacement and provider-owned browser OAuth persist through the actual service',async({page,crew},info)=>{
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();await navigate(page,'Settings');
 const panel=page.getByRole('region',{name:'Provider credentials'});await expect(panel).toBeVisible();await expect(page.getByRole('status').first()).toContainText('Connected · local instance',{timeout:20_000});await expect(panel.getByLabel('Provider',{exact:true})).toBeEnabled();await panel.getByLabel('Provider',{exact:true}).selectOption('openai');
 await panel.getByRole('button',{name:'Add API key'}).click();const key=panel.getByLabel('Enter OpenAI API key',{exact:true});await expect(key).toHaveAttribute('type','password');await key.fill('fake-browser-first-key');await panel.getByRole('button',{name:'Continue',exact:true}).click();await expect(panel.getByText('Credentials saved.',{exact:true})).toBeVisible();
 expect(JSON.parse(await readFile(join(crew.ctx.stateDir,'test-auth.json'),'utf8')).openai.key).toBe('fake-browser-first-key');await panel.getByRole('button',{name:'Replace API key'}).click();await expect(key).toHaveValue('');await key.fill('fake-browser-second-key');await panel.getByRole('button',{name:'Continue',exact:true}).click();await expect(panel.getByText('Credentials saved.',{exact:true})).toBeVisible();expect(JSON.parse(await readFile(join(crew.ctx.stateDir,'test-auth.json'),'utf8')).openai.key).toBe('fake-browser-second-key');
 await panel.getByRole('button',{name:'Sign in with browser'}).click();await expect(panel.getByRole('link',{name:'Open sign-in page'})).toHaveAttribute('href',/https:\/\/example.test\/authorize/);await expect(panel.getByText('FAKE-CODE',{exact:true})).toBeVisible();await panel.getByLabel('Paste callback URL').fill('https://localhost/callback?code=fake-browser-code');await panel.getByRole('button',{name:'Continue',exact:true}).click();await panel.getByLabel('Choose account').selectOption('personal');await panel.getByRole('button',{name:'Continue',exact:true}).click();await expect(panel.getByLabel('Confirm sign-in code')).toHaveAttribute('type','password');await panel.getByLabel('Confirm sign-in code').fill('fake-browser-confirmation');await panel.getByRole('button',{name:'Continue',exact:true}).click();await expect(panel.getByText('Credentials saved.',{exact:true})).toBeVisible();
 expect(JSON.parse(await readFile(join(crew.ctx.stateDir,'test-auth.json'),'utf8')).openai).toMatchObject({type:'oauth',access:'scripted-private-access'});expect(JSON.stringify(await crew.ctx.store.list('api-request'))).not.toMatch(/fake-browser|scripted-private|example.test/);
 expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toMatch(/fake-browser|scripted-private/);await expect(panel.locator('input[type="password"]')).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`${info.project.name}-providers.png`),fullPage:true});
});

test('changing provider clears secret drafts and cancelled browser sign-in leaves credentials unavailable',async({page,crew})=>{
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();await navigate(page,'Settings');const panel=page.getByRole('region',{name:'Provider credentials'});await panel.getByLabel('Provider',{exact:true}).selectOption('openai');await panel.getByRole('button',{name:'Add API key'}).click();await panel.getByLabel('Enter OpenAI API key').fill('fake-unsent-draft');await panel.getByLabel('Provider',{exact:true}).selectOption('anthropic');await expect(panel.locator('input[type="password"]')).toHaveCount(0);await panel.getByLabel('Provider',{exact:true}).selectOption('openai');await panel.getByRole('button',{name:'Sign in with browser'}).click();await expect(panel.getByLabel('Paste callback URL')).toBeVisible();await panel.getByRole('button',{name:'Cancel sign-in'}).click();await expect(panel.getByText('Sign-in cancelled.',{exact:true})).toBeVisible();await expect(panel.getByText('Credential unavailable',{exact:true})).toBeVisible();
});

async function openProvidersPanel(page:import('@playwright/test').Page,crew:Awaited<ReturnType<typeof localTeam>>){
 await page.goto(crew.url);await page.getByLabel('Login secret').fill(crew.secret);await page.getByRole('button',{name:'Connect to instance'}).click();await navigate(page,'Settings');
 const panel=page.getByRole('region',{name:'Provider credentials'});await expect(panel.getByLabel('Provider',{exact:true})).toBeEnabled();return panel;
}

test('native Copilot and Bedrock text prompts permit blank defaults without contacting a provider',async({page,crew})=>{
 const panel=await openProvidersPanel(page,crew);await panel.getByLabel('Provider',{exact:true}).selectOption('github-copilot');await panel.getByRole('button',{name:'GitHub Copilot',exact:true}).click();
 // The native Copilot flow cannot contact GitHub until this first prompt is answered.
 await expect(panel.getByLabel('GitHub Enterprise URL/domain (blank for github.com)')).toHaveValue('');await expect(panel.getByRole('button',{name:'Continue',exact:true})).toBeEnabled();await panel.getByRole('button',{name:'Cancel sign-in'}).click();
 await panel.getByLabel('Provider',{exact:true}).selectOption('amazon-bedrock');await panel.getByRole('button',{name:'Add API key'}).click();await panel.getByLabel('Select Amazon Bedrock authentication method:').selectOption('credential-chain');await panel.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(panel.getByLabel('Configure AWS credentials, then press Enter to continue')).toHaveValue('');await panel.getByRole('button',{name:'Continue',exact:true}).click();await expect(panel.getByText('Credentials saved.',{exact:true})).toBeVisible();
 expect(JSON.parse(await readFile(join(crew.ctx.stateDir,'test-auth.json'),'utf8'))['amazon-bedrock']).toEqual({type:'api_key'});
});

for(const fault of ['status','metadata'] as const)test(`provider login recovers after one ${fault} failure without secret re-entry`,async({page,crew})=>{
 const panel=await openProvidersPanel(page,crew);await panel.getByRole('button',{name:'Add API key'}).click();await panel.getByLabel('Enter OpenAI API key').fill('fake-recovery-key');
 let failed=false,answers=0;page.on('request',request=>{if(request.method()==='POST'&&/\/provider-logins\/[^/]+\/answer$/.test(new URL(request.url()).pathname))answers++;});
 const pattern=fault==='status'?'**/api/v1/provider-logins/*':'**/api/v1/providers/openai';
 await page.route(pattern,async route=>{if(!failed&&route.request().method()==='GET'){failed=true;const response=await route.fetch();await route.fulfill({response,status:503,json:{error:{code:'TRANSIENT_TEST_FAILURE',message:'Temporary connection failure'}}});}else await route.continue();});
 await panel.getByRole('button',{name:'Continue',exact:true}).click();await expect(panel.getByText('Credentials saved.',{exact:true})).toBeVisible();expect(failed).toBe(true);expect(answers).toBe(1);expect(JSON.parse(await readFile(join(crew.ctx.stateDir,'test-auth.json'),'utf8')).openai.key).toBe('fake-recovery-key');await expect(panel.locator('input[type="password"]')).toHaveCount(0);await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('late environment-save responses cannot change the newly selected provider or next login target',async({page,crew})=>{
 const panel=await openProvidersPanel(page,crew);let release!:()=>void,reached!:()=>void;const held=new Promise<void>(resolve=>release=resolve),received=new Promise<void>(resolve=>reached=resolve);
 await page.route('**/api/v1/providers/openai',async route=>{if(route.request().method()==='PUT'){const response=await route.fetch();reached();await held;await route.fulfill({response});}else await route.continue();});
 await panel.getByText('Advanced · environment reference',{exact:true}).click();await panel.getByLabel('Credential environment variable').fill('FAKE_OPENAI_REFERENCE');await panel.getByRole('button',{name:'Save provider reference'}).click();await received;await panel.getByLabel('Provider',{exact:true}).selectOption('anthropic');await expect(panel.getByRole('button',{name:'Add API key'})).toBeEnabled();
 const delivered=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname==='/api/v1/providers/openai');release();await delivered;
 await expect(panel.getByLabel('Provider',{exact:true})).toHaveValue('anthropic');await expect(panel.getByLabel('Credential environment variable')).toHaveValue('');await expect(panel.getByText('Provider reference saved.',{exact:true})).toHaveCount(0);
 const started=page.waitForRequest(request=>request.method()==='POST'&&/\/providers\/[^/]+\/login$/.test(new URL(request.url()).pathname));await panel.getByRole('button',{name:'Add API key'}).click();expect(new URL((await started).url()).pathname).toBe('/api/v1/providers/anthropic/login');await expect(panel.getByLabel('Enter Anthropic API key')).toBeVisible();await panel.getByRole('button',{name:'Cancel sign-in'}).click();
});
