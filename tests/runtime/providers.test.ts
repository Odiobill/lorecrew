import { afterEach, expect, it } from 'vitest';
import { temporaryInstance } from '../helpers/temp.js';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openCredentialFile } from '../../src/runtime/provider-credentials.js';
import { openProviders, listProviderSettings } from '../../src/runtime/providers.js';
const cleanups:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanups.splice(0))await close();});
it('registers every installed builtin and advertises provider-owned login methods',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);const credentials=openCredentialFile(join(f.root,'auth.json'));const options={credentials};const models=await openProviders(f.paths.stateDir,options);
 expect(models.getProviders().map(p=>p.id)).toEqual([...builtinProviders().map(p=>p.id),'openai-compatible']);const catalog=await listProviderSettings(f.paths.stateDir,options);expect(catalog).toHaveLength(builtinProviders().length+1);
 for(const p of builtinProviders())expect(catalog.find(x=>x.id===p.id)?.methods).toEqual([...p.auth.apiKey?.login?[{type:'api_key',label:p.auth.apiKey.name}]:[],...p.auth.oauth?[{type:'oauth',label:p.auth.oauth.loginLabel??p.auth.oauth.name}]:[]]);
});
it('uses stored credentials before legacy environment references and keeps OAuth status side-effect-free',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);await writeFile(join(f.root,'providers.json'),'[]');await import('node:fs/promises').then(fs=>fs.mkdir(f.paths.stateDir,{recursive:true}));
 await writeFile(join(f.paths.stateDir,'providers.json'),'[{"module":"openai","credentialEnv":"CUSTOM_TEST_KEY"}]');process.env.CUSTOM_TEST_KEY='env-key';
 try{const credentials=openCredentialFile(join(f.root,'auth.json'));await credentials.modify('openai',async()=>({type:'api_key',key:'stored-key'}));await credentials.modify('openai-codex',async()=>({type:'oauth',access:'expired',refresh:'do-not-refresh',expires:0}));const models=await openProviders(f.paths.stateDir,{credentials});expect(await models.getAuth('openai')).toMatchObject({auth:{apiKey:'stored-key'}});expect(await models.checkAuth('openai-codex')).toMatchObject({type:'oauth'});expect((await models.getAvailable('openai-codex')).length).toBeGreaterThan(0);expect(await credentials.read('openai-codex')).toMatchObject({access:'expired'});await credentials.delete('openai');expect(await models.getAuth('openai')).toMatchObject({auth:{apiKey:'env-key'}});}finally{delete process.env.CUSTOM_TEST_KEY;}
});

it('rejects configured commands without executing or advertising them as usable auth',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);const credentials=openCredentialFile(join(f.root,'auth.json')),marker=join(f.root,'must-not-execute');const configured=`!touch '${marker}'; printf fake-key`;
 await credentials.modify('openai',async()=>({type:'api_key',key:configured}));const models=await openProviders(f.paths.stateDir,{credentials});
 expect(await models.checkAuth('openai')).toBeUndefined();expect(await models.getAvailable('openai')).toHaveLength(0);await expect(models.getAuth('openai')).rejects.toThrow();
 const fs=await import('node:fs/promises');await expect(fs.stat(marker)).rejects.toMatchObject({code:'ENOENT'});expect(await credentials.read('openai')).toMatchObject({key:configured});
 process.env.LORECREW_FAKE_CONFIG_KEY='fake-env-key';try{await credentials.modify('openai',async()=>({type:'api_key',key:'LORECREW_FAKE_CONFIG_KEY'}));expect(await models.getAuth('openai')).toMatchObject({auth:{apiKey:'fake-env-key'}});}finally{delete process.env.LORECREW_FAKE_CONFIG_KEY;}
});

it('serializes provider-owned OAuth refresh through the shared store and checks status without refresh',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);const credentials=openCredentialFile(join(f.root,'auth.json'));await credentials.modify('openai',async()=>({type:'oauth',access:'old',refresh:'old-refresh',expires:0,providerExtra:'retain'}));let refreshes=0;const base=builtinProviders().find(p=>p.id==='openai')!;const provider={...base,auth:{oauth:{name:'scripted',login:async()=>{throw Error('not logging in');},refresh:async()=>{refreshes++;await new Promise(r=>setTimeout(r,20));return {type:'oauth' as const,access:'fake-refreshed',refresh:'fake-rotated',expires:Date.now()+3600_000};},toAuth:async(credential:{access:string})=>({apiKey:credential.access})}}};
 const models=await openProviders(f.paths.stateDir,{credentials,factories:()=>[provider]});expect(await models.checkAuth('openai')).toMatchObject({type:'oauth'});await models.getAvailable();expect(refreshes).toBe(0);const results=await Promise.all([models.getAuth('openai'),models.getAuth('openai')]);expect(results).toEqual([expect.objectContaining({auth:{apiKey:'fake-refreshed'}}),expect.objectContaining({auth:{apiKey:'fake-refreshed'}})]);expect(refreshes).toBe(1);expect(await credentials.read('openai')).toMatchObject({refresh:'fake-rotated',providerExtra:'retain'});
});

it('keeps an unset explicit environment reference unavailable while stored credentials take precedence',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);const fs=await import('node:fs/promises');await fs.mkdir(f.paths.stateDir,{recursive:true});await fs.writeFile(join(f.paths.stateDir,'providers.json'),'[{"module":"openai","credentialEnv":"LORECREW_FAKE_UNSET_REFERENCE"}]');
 const credentials=openCredentialFile(join(f.root,'auth.json'));process.env.OPENAI_API_KEY='fake-builtin-key';delete process.env.LORECREW_FAKE_UNSET_REFERENCE;
 try{const models=await openProviders(f.paths.stateDir,{credentials});expect(await models.checkAuth('openai')).toBeUndefined();expect(await models.getAuth('openai')).toBeUndefined();expect(models.getProvider('openai')!.auth.oauth).toBeDefined();await credentials.modify('openai',async()=>({type:'api_key',key:'fake-stored-key'}));expect(await models.getAuth('openai')).toMatchObject({auth:{apiKey:'fake-stored-key'}});}finally{delete process.env.OPENAI_API_KEY;}
});
