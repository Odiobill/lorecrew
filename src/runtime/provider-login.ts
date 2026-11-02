import { randomUUID } from 'node:crypto';
import type { AuthEvent, AuthPrompt, AuthType, CredentialStore } from '@earendil-works/pi-ai';
import { AppError } from '../contracts/base.js';
import { credentialFingerprint, openCredentialFile } from './provider-credentials.js';
import { stableId } from './admission.js';
import { openProviders,readCompatibleSettings, type ProviderOptions } from './providers.js';

export type LoginState='pending'|'prompt'|'success'|'error'|'cancelled'|'expired';
export interface LoginPrompt {id:string;type:'text'|'secret'|'select'|'manual_code';message:string;options?:Array<{id:string;label:string}>}
export interface LoginEvent {type:'info'|'auth_url'|'device_code'|'progress';message?:string;url?:string;userCode?:string;links?:Array<{url:string;label:string}>}
export interface LoginView {id:string;providerId:string;state:LoginState;expiresAt:number;events:LoginEvent[];prompt?:LoginPrompt;message?:string}
interface Entry {owner:string;view:LoginView;controller:AbortController;timer:ReturnType<typeof setTimeout>;reply?:{id:string;resolve:(value:string)=>void;reject:(error:Error)=>void;cleanup:()=>void}}
interface Options {stateDir:string;providerOptions?:ProviderOptions;onSaved:()=>Promise<void>;ownerActive?:(owner:string)=>Promise<boolean>;now?:()=>number;ttlMs?:number;limit?:number}
const safeText=(value:string)=>value.slice(0,2000);
function safeUrl(value:string):string|undefined {try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}}
function eventView(event:AuthEvent):LoginEvent|undefined {
 if(event.type==='auth_url'){const url=safeUrl(event.url);return url?{type:event.type,url,...event.instructions?{message:safeText(event.instructions)}:{}}:undefined;}
 if(event.type==='device_code'){const url=safeUrl(event.verificationUri);return url?{type:event.type,url,userCode:safeText(event.userCode)}:undefined;}
 return {type:event.type,message:safeText(event.message),...event.type==='info'&&event.links?{links:event.links.flatMap(link=>{const url=safeUrl(link.url);return url?[{url,label:safeText(link.label??'Open provider page')}]:[]}).slice(0,10)}:{}};
}
/** Transient browser interaction only. No answers, callbacks or provider errors are durable. */
export class ProviderLogins {
 private readonly entries=new Map<string,Entry>();
 private readonly current=new Map<string,string>();
 private closed=false;
 private readonly now:()=>number;
 private readonly ttl:number;
 constructor(private readonly options:Options){this.now=options.now??Date.now;this.ttl=options.ttlMs??10*60_000;}
 private active(entry:Entry):boolean{return !this.closed&&!entry.controller.signal.aborted&&this.current.get(entry.view.providerId)===entry.view.id&&entry.view.expiresAt>this.now();}
 private finish(entry:Entry,state:LoginState,message?:string){
  entry.view.state=state;delete entry.view.prompt;if(message)entry.view.message=message;
  entry.reply?.cleanup();entry.reply?.reject(new Error('Provider login cancelled'));delete entry.reply;
  clearTimeout(entry.timer);entry.controller.abort();
 }
 private find(owner:string,id:string):Entry {
  const entry=this.entries.get(id);if(!entry||entry.owner!==owner)throw new AppError('NOT_FOUND','Login not found');
  if(entry.view.expiresAt<=this.now()&&['pending','prompt'].includes(entry.view.state))this.finish(entry,'expired','Sign-in expired. Start again.');return entry;
 }
 get(owner:string,id:string):LoginView{return structuredClone(this.find(owner,id).view);}
 cancel(owner:string,id:string):LoginView {const entry=this.find(owner,id);if(['pending','prompt'].includes(entry.view.state))this.finish(entry,'cancelled','Sign-in cancelled.');return structuredClone(entry.view);}
 cancelOwner(owner:string):void{for(const entry of this.entries.values())if(entry.owner===owner&&['pending','prompt'].includes(entry.view.state))this.finish(entry,'cancelled');}
 close():void{this.closed=true;for(const entry of this.entries.values())this.finish(entry,'cancelled');this.entries.clear();this.current.clear();}
 async start(owner:string,providerId:string,type:AuthType):Promise<LoginView>{
  if(this.closed)throw new AppError('LOGIN_UNAVAILABLE','Provider login is unavailable');
  for(const [id,entry] of this.entries)if(entry.view.expiresAt<=this.now()){this.finish(entry,'expired');this.entries.delete(id);if(this.current.get(entry.view.providerId)===id)this.current.delete(entry.view.providerId);}
  if(this.entries.size>=(this.options.limit??100))throw new AppError('LOGIN_LIMIT','Too many sign-in attempts. Wait for an earlier attempt to expire.');
  const endpoint=providerId==='openai-compatible'?await readCompatibleSettings({stateDir:this.options.stateDir}):undefined;
  const endpointRevision=stableId(JSON.stringify(endpoint??null));
  const store=this.options.providerOptions?.credentials??openCredentialFile();
  const models=await openProviders(this.options.stateDir,{...this.options.providerOptions,credentials:store});
  const provider=models.getProvider(providerId);if(!provider)throw new AppError('UNKNOWN_PROVIDER','Only installed provider modules can be configured');
  if(!(type==='oauth'?provider.auth.oauth?.login:provider.auth.apiKey?.login))throw new AppError('INVALID_REQUEST','This sign-in method is unavailable');
  const initial=credentialFingerprint(await store.read(providerId));
  if(this.closed)throw new AppError('LOGIN_UNAVAILABLE','Provider login is unavailable');
  // Setup above awaits storage. Recheck at the allocation boundary so parallel
  // starts cannot all consume a capacity slot observed before those awaits.
  if(this.entries.size>=(this.options.limit??100))throw new AppError('LOGIN_LIMIT','Too many sign-in attempts. Wait for an earlier attempt to expire.');
  const previous=this.current.get(providerId);if(previous){const entry=this.entries.get(previous);if(entry&&['pending','prompt'].includes(entry.view.state))this.finish(entry,'cancelled','Replaced by a newer sign-in.');}
  const id=randomUUID(),controller=new AbortController();
  const entry:Entry={owner,controller,view:{id,providerId,state:'pending',expiresAt:this.now()+this.ttl,events:[]},timer:setTimeout(()=>{if(['pending','prompt'].includes(entry.view.state))this.finish(entry,'expired','Sign-in expired. Start again.');},this.ttl)};
  entry.timer.unref();this.entries.set(id,entry);this.current.set(providerId,id);
  // Models.login owns provider logic and persistence. This wrapper adds a CAS
  // inside the same file lock, so external refresh/replacement wins safely.
  const guarded:CredentialStore={...store,modify:(provider,fn,options)=>store.modify(provider,async current=>{
   if(!this.active(entry)||credentialFingerprint(current)!==initial||this.options.ownerActive&&!await this.options.ownerActive(owner))throw new Error('Sign-in superseded');
   const value=await fn(current);if(!this.active(entry))throw new Error('Sign-in superseded');
   if(providerId==='openai-compatible'){const currentEndpoint=await readCompatibleSettings({stateDir:this.options.stateDir});if(!endpoint||stableId(JSON.stringify(currentEndpoint??null))!==endpointRevision)throw new Error('Endpoint changed during sign-in');return value?{...value,lorecrewEndpoint:endpoint.baseUrl}:value;}
   return value;
  },options)};
  void (async()=>{
   try {
    const loginModels=await openProviders(this.options.stateDir,{...this.options.providerOptions,credentials:guarded});
    if(!this.active(entry))return;
    await loginModels.login(providerId,type,{signal:controller.signal,prompt:prompt=>this.prompt(entry,prompt),notify:event=>{if(this.active(entry)){const view=eventView(event);if(view){entry.view.events.push(view);entry.view.events=entry.view.events.slice(-20);}}}},{agentName:'Lorecrew'});
    if(!this.active(entry))return;
    await this.options.onSaved();if(this.active(entry)){entry.view.events=[];this.finish(entry,'success','Credentials saved.');}
   }catch{if(this.active(entry)){entry.view.events=[];this.finish(entry,'error','Sign-in failed or credentials changed. Start again.');}}
  })();
  return structuredClone(entry.view);
 }
 private prompt(entry:Entry,prompt:AuthPrompt):Promise<string>{
  if(!this.active(entry)||prompt.signal?.aborted)return Promise.reject(new Error('Provider login cancelled'));
  if(entry.reply)return Promise.reject(new Error('Concurrent login prompts are unsupported'));
  const id=randomUUID();entry.view.state='prompt';entry.view.prompt={id,type:prompt.type,message:safeText(prompt.message),...prompt.type==='select'?{options:prompt.options.map(o=>({id:o.id,label:safeText(o.label)})).slice(0,100)}:{}};
  return new Promise((resolve,reject)=>{
   const abort=()=>{if(entry.reply?.id===id){entry.reply.cleanup();delete entry.reply;delete entry.view.prompt;if(this.active(entry))entry.view.state='pending';reject(new Error('Provider prompt cancelled'));}};
   const cleanup=()=>{entry.controller.signal.removeEventListener('abort',abort);prompt.signal?.removeEventListener('abort',abort);};
   entry.reply={id,resolve,reject,cleanup};entry.controller.signal.addEventListener('abort',abort,{once:true});prompt.signal?.addEventListener('abort',abort,{once:true});
  });
 }
 async answer(owner:string,id:string,promptId:string,value:string):Promise<LoginView>{
  const entry=this.find(owner,id),reply=entry.reply;
  if(!this.active(entry)||entry.view.state!=='prompt'||reply?.id!==promptId)throw new AppError('LOGIN_STALE','Prompt is no longer active');
  if(entry.view.prompt?.type==='select'&&!entry.view.prompt.options?.some(o=>o.id===value))throw new AppError('INVALID_REQUEST','Choose one of the offered options');
  reply.cleanup();delete entry.reply;delete entry.view.prompt;entry.view.state='pending';reply.resolve(value);return structuredClone(entry.view);
 }
}
