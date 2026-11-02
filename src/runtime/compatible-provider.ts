import { createProvider } from '@earendil-works/pi-ai/models';
import { envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { AppError } from '../contracts/base.js';
export const compatibleProviderId='openai-compatible';
export interface CompatibleSettings {baseUrl:string;modelId:string;auth:'api_key'|'none';contextWindow:number;maxTokens:number}
export function validateCompatible(value:unknown):CompatibleSettings {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('INVALID_REQUEST','Enter compatible endpoint settings.');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['baseUrl','modelId','auth','contextWindow','maxTokens'].includes(k)))throw new AppError('INVALID_REQUEST','Endpoint settings cannot contain credentials or arbitrary options.');
 let url:URL;try{url=new URL(String(v.baseUrl));}catch{throw new AppError('INVALID_REQUEST','Enter an HTTP or HTTPS API base URL.');}
 if(typeof v.baseUrl!=='string'||v.baseUrl.trim()!==v.baseUrl||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/[?#\s]/.test(v.baseUrl))throw new AppError('INVALID_REQUEST','Use an HTTP or HTTPS API base URL without credentials, query parameters or fragments.');
 if(typeof v.modelId!=='string'||!v.modelId.trim()||v.modelId!==v.modelId.trim()||v.modelId.length>256||/^(?:\/|~|[A-Za-z]:|file:)/.test(v.modelId)||/[\\\0\r\n]/.test(v.modelId)||v.modelId.split('/').some(p=>p==='.'||p==='..'))throw new AppError('INVALID_REQUEST','Enter the model identifier served by your endpoint.');
 if(!['api_key','none'].includes(String(v.auth))||!Number.isSafeInteger(v.contextWindow)||Number(v.contextWindow)<1024||Number(v.contextWindow)>2_000_000||!Number.isSafeInteger(v.maxTokens)||Number(v.maxTokens)<1||Number(v.maxTokens)>Number(v.contextWindow))throw new AppError('INVALID_REQUEST','Choose authentication and valid context/output token limits.');
 return {baseUrl:url.href.replace(/\/$/,''),modelId:v.modelId,auth:v.auth as CompatibleSettings['auth'],contextWindow:v.contextWindow as number,maxTokens:v.maxTokens as number};
}
export function compatibleProvider(config?:CompatibleSettings){
 const keyed=envApiKeyAuth('OpenAI-Compatible API key',[]),wire=openAICompletionsApi();
 // Pi AI 1.4.0's adapter requires a client key even for keyless servers.
 // Keep the placeholder in memory and explicitly remove its SDK auth header.
 const current=(model:Parameters<typeof wire.stream>[0])=>{
  // A durable beforeRequest hook can pause between descriptor lookup and auth resolution.
  // Never pair a stale descriptor with this provider generation's credentials.
  if(!config||model.provider!==compatibleProviderId||model.id!==config.modelId||model.baseUrl!==config.baseUrl||model.contextWindow!==config.contextWindow||model.maxTokens!==config.maxTokens)throw new AppError('PROVIDER_CHANGED','Endpoint configuration changed before dispatch. Start again with the current model selection.');
 };
 const api={
  stream:(...args:Parameters<typeof wire.stream>)=>{current(args[0]);return wire.stream(args[0],args[1],config?.auth==='none'?{...args[2],apiKey:'lorecrew-keyless',headers:{...args[2]?.headers,authorization:null}}:args[2]);},
  streamSimple:(...args:Parameters<typeof wire.streamSimple>)=>{current(args[0]);return wire.streamSimple(args[0],args[1],config?.auth==='none'?{...args[2],apiKey:'lorecrew-keyless',headers:{...args[2]?.headers,authorization:null}}:args[2]);},
 };
 return createProvider({id:compatibleProviderId,name:'OpenAI-Compatible',...config?{baseUrl:config.baseUrl}:{},auth:{apiKey:config?.auth==='none'?{name:'No API key',resolve:async()=>({auth:{}})}:{...keyed,resolve:async input=>config?keyed.resolve(input):undefined}},models:config?[{id:config.modelId,name:config.modelId,api:'openai-completions' as const,provider:compatibleProviderId,baseUrl:config.baseUrl,reasoning:false,input:['text' as const],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:config.contextWindow,maxTokens:config.maxTokens,compat:{supportsDeveloperRole:false,supportsReasoningEffort:false,maxTokensField:'max_tokens' as const}}]:[],api});
}
