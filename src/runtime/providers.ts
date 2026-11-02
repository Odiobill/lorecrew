import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createModels, type Models, type Provider } from '@earendil-works/pi-ai/models';
import type { Model,Api } from '@earendil-works/pi-ai';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { AppError } from '../contracts/base.js';
import { supportedThinkingLevels } from './thinking.js';
import type { ModelDescriptor } from './types.js';
import { openCredentialFile } from './provider-credentials.js';
import { hasCredentialCommand, resolveKeyConfig } from './provider-key-config.js';
import { compatibleProvider,compatibleProviderId,validateCompatible,type CompatibleSettings } from './compatible-provider.js';
export interface ProviderOptions {credentials?:CredentialStore;factories?:()=>Provider[]}
type Binding={module:string;credentialEnv?:string;compatible?:CompatibleSettings};
/** All installed pi-ai modules; providers.json retains optional legacy env references. */
export async function openProviders(stateDir:string,options:ProviderOptions={}):Promise<ReturnType<typeof createModels>> {
 const values=await bindings({stateDir});
 if(!Array.isArray(values))throw new AppError('INVALID_PROVIDERS','providers.json must contain a list of provider bindings');
 const config=values.find(b=>b?.module===compatibleProviderId)?.compatible;
 const providers=[...(options.factories??builtinProviders)(),compatibleProvider(config?validateCompatible(config):undefined)];
 if(!Array.isArray(values)||values.some(b=>!b||typeof b!=='object'||!providers.some(p=>p.id===b.module)||(b.credentialEnv!==undefined&&(typeof b.credentialEnv!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(b.credentialEnv)))))throw new AppError('INVALID_PROVIDERS','providers.json must contain installed modules and environment credential references');
 const models=createModels({credentials:options.credentials??openCredentialFile()});
 for(const provider of providers){
  const name=values.find(b=>b.module===provider.id)?.credentialEnv,apiKey=provider.auth.apiKey;
  if(!apiKey||provider.id===compatibleProviderId&&config?.auth==='none'){models.setProvider(provider);continue;}
  const overlay=(credential:Parameters<typeof apiKey.resolve>[0]['credential'])=>{
   // A key entered for another compatible endpoint must never travel to this URL.
   const current=provider.id===compatibleProviderId&&credential&&(credential as unknown as {lorecrewEndpoint?:string}).lorecrewEndpoint!==config?.baseUrl?undefined:credential;
   return current??(name&&process.env[name]?{type:'api_key' as const,key:process.env[name]}:undefined);
  };
  const check:NonNullable<typeof apiKey.check>=async input=>{
   if(name&&!input.credential&&!process.env[name])return undefined;
   const credential=overlay(input.credential),args={ctx:input.ctx,signal:input.signal,...credential?{credential}:{}};
   if(hasCredentialCommand(credential))return undefined;
   if(apiKey.check)return apiKey.check(args);
   // Builtin resolve functions do local config checks. Crucially this path
   // receives the raw configured value, so !commands cannot execute here.
   const result=await apiKey.resolve(args);return result?{type:'api_key',...result.source?{source:result.source}:{}}:undefined;
  };
  models.setProvider({...provider,auth:{...provider.auth,apiKey:{...apiKey,check,resolve:async input=>{
   if(name&&!input.credential&&!process.env[name])return undefined;
   const credential=await resolveKeyConfig(overlay(input.credential),input.signal);
   return apiKey.resolve({ctx:input.ctx,signal:input.signal,...credential?{credential}:{}});
  }}}});
 }
 return models;
}
export async function listModels(models:Models):Promise<ModelDescriptor[]> {
  const available=new Set((await models.getAvailable()).map(m=>`${m.provider}\0${m.id}`));
  return models.getModels().map(m=>({provider:m.provider,modelId:m.id,name:m.name,supportedThinkingLevels:supportedThinkingLevels(m),available:available.has(`${m.provider}\0${m.id}`)}));
}
/** Model continuations outside GenerationTask.beforeRequest (compaction and deferred polls). */
export function gateModelContinuations(models:Models,wait:(identity:{sessionId?:string;handleId?:string;signal?:AbortSignal})=>Promise<void|(()=>Promise<void>)|{model:Model<Api>;leave?:()=>Promise<void>}>):Models {
  return new Proxy(models,{get(target,key){
    if(key==='streamSimple')return (...args:Parameters<Models['streamSimple']>)=>{
      const options=args[2];const opened=(async()=>{const permit=await wait({...options?.sessionId?{sessionId:options.sessionId}:{},...options?.signal?{signal:options.signal}:{}});const leave=typeof permit==='function'?permit:permit?.leave;if(permit&&typeof permit!=='function')args[0]=permit.model;try{return {stream:target.streamSimple(...args),leave};}catch(error){if(leave)await leave();throw error;}})();
      const result=opened.then(async({stream,leave})=>{try{return await stream.result();}finally{if(leave)await leave();}});void result.catch(()=>{});
      return {async *[Symbol.asyncIterator](){const {stream}=await opened;yield* stream;},result:()=>result} as unknown as ReturnType<Models['streamSimple']>;
    };
    if(key==='completeSimple')return async(...args:Parameters<Models['completeSimple']>)=>{
      const options=args[2];const permit=await wait({...options?.sessionId?{sessionId:options.sessionId}:{},...options?.signal?{signal:options.signal}:{}});
      const leave=typeof permit==='function'?permit:permit?.leave;if(permit&&typeof permit!=='function')args[0]=permit.model;try{return await target.completeSimple(...args);}finally{if(leave)await leave();}
    };
    if(key==='fetchDeferred')return async(...args:Parameters<Models['fetchDeferred']>)=>{
      const permit=await wait({handleId:args[1].id,...args[2]?.signal?{signal:args[2].signal}:{}});
      const leave=typeof permit==='function'?permit:permit?.leave;if(permit&&typeof permit!=='function')args[0]=permit.model;try{return await target.fetchDeferred(...args);}finally{if(leave)await leave();}
    };
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
}

// The file is the configuration authority; control records are mutation receipts only.
import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { InstanceContext } from '../instance/open.js';
import { stableId } from './admission.js';

const providerQueues=new WeakMap<InstanceContext,Promise<unknown>>();
async function bindings(ctx:Pick<InstanceContext,'stateDir'>):Promise<Binding[]>{try{return JSON.parse(await readFile(join(ctx.stateDir,'providers.json'),'utf8')) as Binding[];}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return [];}}
function providerId(id:string){if(id!==compatibleProviderId&&!builtinProviders().some(p=>p.id===id))throw new AppError('UNKNOWN_PROVIDER','Only installed provider modules can be configured');}
export async function readProviderSettings(ctx:Pick<InstanceContext,'stateDir'>,id:string,options:ProviderOptions={}){
 const models=await openProviders(ctx.stateDir,options),provider=models.getProvider(id);if(!provider)throw new AppError('UNKNOWN_PROVIDER','Only installed provider modules can be configured');
 const value=(await bindings(ctx)).find(b=>b.module===id);
 return {id,name:provider.name,...value?.credentialEnv?{credentialEnv:value.credentialEnv}:{},...value?.compatible?{compatible:value.compatible}:{},revision:stableId(JSON.stringify(value??null)),available:!!await models.checkAuth(id),methods:[...provider.auth.apiKey?.login?[{type:'api_key' as const,label:provider.auth.apiKey.name}]:[],...provider.auth.oauth?[{type:'oauth' as const,label:provider.auth.oauth.loginLabel??provider.auth.oauth.name}]:[]]};
}
export async function listProviderSettings(stateDir:string,options:ProviderOptions={}){
 const models=await openProviders(stateDir,options),values=await bindings({stateDir}),signal=new AbortController().signal;
 return Promise.all(models.getProviders().map(async provider=>{const value=values.find(b=>b.module===provider.id);return {id:provider.id,name:provider.name,...value?.credentialEnv?{credentialEnv:value.credentialEnv}:{},...value?.compatible?{compatible:value.compatible}:{},revision:stableId(JSON.stringify(value??null)),available:!!await models.checkAuth(provider.id,{signal}),methods:[...provider.auth.apiKey?.login?[{type:'api_key' as const,label:provider.auth.apiKey.name}]:[],...provider.auth.oauth?[{type:'oauth' as const,label:provider.auth.oauth.loginLabel??provider.auth.oauth.name}]:[]]};}));
}
function saveBinding(ctx:InstanceContext,id:string,expectedRevision:string,requestId:string,fingerprint:string,make:(old:Binding|undefined)=>Binding){
 const work=(providerQueues.get(ctx)??Promise.resolve()).then(async()=>{
  providerId(id);
  const values=await bindings(ctx),old=values.find(b=>b.module===id),next=make(old);
  const receipt=await ctx.store.read<{fingerprint?:string}>('provider-setting-receipt',requestId);
  if(receipt){if(receipt.fingerprint&&receipt.fingerprint!==fingerprint)throw new AppError('REQUEST_CONFLICT','Provider request key names different settings.');return;}
  const pending=await ctx.store.read<{next?:Binding;fingerprint?:string}>('provider-setting-intent',requestId);
  if(pending?.fingerprint&&pending.fingerprint!==fingerprint)throw new AppError('REQUEST_CONFLICT','Provider request key names different settings.');
  if(!pending&&stableId(JSON.stringify(old??null))!==expectedRevision)throw new AppError('REVISION_CONFLICT','Provider settings changed');
  if(pending&&JSON.stringify(old)!==JSON.stringify(next)&&stableId(JSON.stringify(old??null))!==expectedRevision)throw new AppError('REVISION_CONFLICT','Provider settings changed during recovery');
  await ctx.store.transact(tx=>tx.put('provider-setting-intent',requestId,{id,next,fingerprint}));
  const output=[...values.filter(b=>b.module!==id),next],temp=join(ctx.stateDir,`.providers-${randomUUID()}.tmp`);const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(output,null,2)+'\n');await file.sync();}finally{await file.close();}await rename(temp,join(ctx.stateDir,'providers.json'));const dir=await open(ctx.stateDir,'r');try{await dir.sync();}finally{await dir.close();}
  await ctx.store.transact(tx=>{tx.put('provider-setting-receipt',requestId,{id,fingerprint});tx.delete('provider-setting-intent',requestId);tx.emit('provider.configured',{id});});
 });providerQueues.set(ctx,work.catch(()=>{}));return work;
}
export function saveProviderSettings(ctx:InstanceContext,id:string,input:{credentialEnv:string;expectedRevision:string},requestId:string){return saveBinding(ctx,id,input.expectedRevision,requestId,stableId('environment',id,input.credentialEnv,input.expectedRevision),old=>({...old,module:id,credentialEnv:input.credentialEnv}));}
export async function saveCompatibleSettings(ctx:InstanceContext,input:CompatibleSettings&{expectedRevision:string},requestId:string){const {expectedRevision,...fields}=input;const compatible=validateCompatible(fields);return saveBinding(ctx,compatibleProviderId,expectedRevision,requestId,stableId('compatible',JSON.stringify(compatible),expectedRevision),old=>({module:compatibleProviderId,...old?.credentialEnv&&old.compatible?.baseUrl===compatible.baseUrl?{credentialEnv:old.credentialEnv}:{},compatible}));}

/** Configuration-only read: never opens credentials or contacts the endpoint. */
export async function readCompatibleSettings(ctx:Pick<InstanceContext,'stateDir'>):Promise<CompatibleSettings|undefined>{const value=(await bindings(ctx)).find(b=>b.module===compatibleProviderId)?.compatible;return value?validateCompatible(value):undefined;}
