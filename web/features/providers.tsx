import { useEffect, useRef, useState } from 'react';
import type { Static } from 'typebox';
import type { ProviderSchema, ProviderLoginSchema } from '../../src/api/schemas.js';
import { CompatibleEndpoint } from './compatible-endpoint.js';
import { ApiError, type ApiClient } from '../api.js';
type Provider=Static<typeof ProviderSchema>;type Login=Static<typeof ProviderLoginSchema>;
const active=(login:Login|undefined)=>login&&['pending','prompt'].includes(login.state);
function safeUrl(value:string|undefined):string|undefined{if(!value)return;try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return;}}
export function ProviderPanel({api,disabled,refresh,onSelectProvider,initialProvider,fixedProvider}:{api:ApiClient;disabled:boolean;refresh:()=>Promise<unknown>;onSelectProvider?:(id:string)=>void;initialProvider?:string;fixedProvider?:string}){
 const [catalog,setCatalog]=useState<Provider[]>([]),[selected,setSelected]=useState(fixedProvider??initialProvider??'openai'),[provider,setProvider]=useState<Provider>(),[login,setLogin]=useState<Login>(),[answer,setAnswer]=useState(''),[environment,setEnvironment]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const generation=useRef(0),loginRef=useRef<Login|undefined>(undefined);loginRef.current=login;
 const fail=(error:unknown)=>setError(error instanceof Error?error.message:'Provider setup could not be completed.');
 useEffect(()=>{let mounted=true;void api.operations<Provider[]>('/providers').then(items=>{if(mounted){setCatalog(items);if(!fixedProvider&&!initialProvider&&!items.some(p=>p.id==='openai'))setSelected(items[0]?.id??'');}}).catch(e=>{if(mounted)fail(e);});return()=>{mounted=false;};},[api]);
 useEffect(()=>{
  const id=++generation.current;setProvider(undefined);setLogin(undefined);setAnswer('');setEnvironment('');setError('');setNotice('');setBusy(false);
  void api.operations<Provider>('/providers/'+encodeURIComponent(selected)).then(value=>{if(id===generation.current){setProvider(value);setEnvironment(value.credentialEnv??'');}}).catch(e=>{if(id===generation.current)fail(e);});
  return()=>{generation.current++;const prior=loginRef.current;if(active(prior))void api.providerAction('/provider-logins/'+prior!.id+'/cancel',{}).catch(()=>{});};
 },[api,selected]);
 useEffect(()=>{setAnswer('');},[login?.prompt?.id]);
 useEffect(()=>{
  if(!active(login)||disabled)return;
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>;
  const id=generation.current;
  const isCurrent=()=>!stopped&&id===generation.current;
  const schedule=()=>{timer=setTimeout(()=>void poll(),500);};
  async function poll(){
   let retry=true;
   try{
    const value=await api.operations<Login>('/provider-logins/'+login!.id);
    if(!isCurrent())return;
    if(value.state==='success'){
     const metadata=await api.operations<Provider>('/providers/'+encodeURIComponent(selected));
     if(!isCurrent())return;
     setProvider(metadata);setLogin(value);setError('');retry=false;
     await refresh();
    }else{
     setLogin(value);setError('');retry=!!active(value);
    }
   }catch(error){
    if(!isCurrent())return;
    fail(error);
    if(error instanceof ApiError&&[401,403,404].includes(error.status)){
     retry=false;
     const terminal={...login!,state:'error' as const,message:'Sign-in is no longer available. Start again.'};
     delete terminal.prompt;setLogin(terminal);
    }
   }finally{
    // A recoverable status/metadata failure must not strand a submitted login.
    if(retry&&isCurrent())schedule();
   }
  }
  schedule();
  return()=>{stopped=true;clearTimeout(timer);};
 },[api,login,disabled,selected,refresh]);
 async function start(type:'api_key'|'oauth'){
  if(!provider)return;const id=generation.current;setAnswer('');setLogin(undefined);setError('');setNotice('');setBusy(true);
  try{const value=await api.providerAction<Login>('/providers/'+encodeURIComponent(provider.id)+'/login',{type});if(id===generation.current)setLogin(value);else if(active(value))void api.providerAction('/provider-logins/'+value.id+'/cancel',{}).catch(()=>{});}catch(e){if(id===generation.current)fail(e);}finally{if(id===generation.current)setBusy(false);}
 }
 async function submit(){
  if(!login?.prompt)return;const id=generation.current,promptId=login.prompt.id,value=answer;setAnswer('');setBusy(true);setError('');
  try{const next=await api.providerAction<Login>('/provider-logins/'+login.id+'/answer',{promptId,value});if(id===generation.current)setLogin(next);}catch(e){if(id===generation.current)fail(e);}finally{if(id===generation.current)setBusy(false);}
 }
 async function cancel(){if(!login)return;const id=generation.current;setAnswer('');setBusy(true);try{const value=await api.providerAction<Login>('/provider-logins/'+login.id+'/cancel',{});if(id===generation.current)setLogin(value);}catch(e){if(id===generation.current)fail(e);}finally{if(id===generation.current)setBusy(false);}}
 async function saveEnvironment(){
  if(!provider)return;
  const id=generation.current;
  setBusy(true);setError('');setNotice('');
  try{
   const value=await api.operate<Provider>('/providers/'+provider.id,{credentialEnv:environment,expectedRevision:provider.revision},'PUT');
   if(id!==generation.current)return;
   setProvider(value);setNotice('Provider reference saved.');
   await refresh();
  }catch(error){if(id===generation.current)fail(error);}
  finally{if(id===generation.current)setBusy(false);}
 }
 const locked=disabled||busy;const metadataGeneration=generation.current;
 return <section className="panel" aria-label="Provider credentials"><h2>Provider credentials</h2>{error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}<label htmlFor="provider-selection">Provider</label><select id="provider-selection" value={selected} disabled={disabled||!!fixedProvider} onChange={e=>{setSelected(e.target.value);onSelectProvider?.(e.target.value);}}>{!catalog.some(p=>p.id===selected)&&<option value={selected}>{selected}</option>}{catalog.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select>{provider&&<>{provider.id==='openai-compatible'&&<CompatibleEndpoint api={api} provider={provider} disabled={locked||!!active(login)} onSaved={async value=>{if(metadataGeneration!==generation.current)return;setProvider(value);await refresh();}}/>}<p>{provider.compatible?.auth==='none'?'No API key required':provider.available?'Credential available':'Credential unavailable'}</p><p className="muted">{provider.compatible?.auth==='none'?'No credentials are sent to this endpoint.':'Credentials are shared with Pi on the instance host. Existing values stay private.'}</p>{!active(login)&&<div className="operation-row">{provider.methods.map(method=><button key={method.type} disabled={locked} onClick={()=>void start(method.type)}>{method.type==='api_key'?(provider.available?'Replace API key':'Add API key'):method.label}</button>)}{!provider.methods.length&&provider.compatible?.auth!=='none'&&<p className="muted">This provider uses credentials configured in the service environment.</p>}</div>}{login&&<div aria-live="polite">{login.events.map((event,index)=><div key={index}>{event.message&&<p>{event.message}</p>}{safeUrl(event.url)&&<p><a href={safeUrl(event.url)} target="_blank" rel="noopener noreferrer">{event.type==='auth_url'?'Open sign-in page':'Open verification page'}</a></p>}{event.userCode&&<p>Device code: <strong>{event.userCode}</strong></p>}{event.links?.map(link=>safeUrl(link.url)&&<p key={link.url}><a href={safeUrl(link.url)} target="_blank" rel="noopener noreferrer">{link.label}</a></p>)}</div>)}{login.message&&<p role="status">{login.message}</p>}{active(login)&&<>{login.prompt?<form onSubmit={e=>{e.preventDefault();void submit();}}><label>{login.prompt.message}{login.prompt.type==='select'?<select disabled={locked} value={answer} onChange={e=>setAnswer(e.target.value)}><option value="">Select an option</option>{login.prompt.options?.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}</select>:<input type={['secret','manual_code'].includes(login.prompt.type)?'password':'text'} value={answer} autoComplete="off" spellCheck={false} disabled={locked} onChange={e=>setAnswer(e.target.value)}/>}</label><button disabled={locked||(!answer&&login.prompt.type!=='text')} type="submit">Continue</button></form>:<p role="status">Waiting for provider…</p>}<button className="secondary" disabled={locked} onClick={()=>void cancel()}>Cancel sign-in</button></>}</div>}{provider.compatible?.auth!=='none'&&<details><summary>Advanced · environment reference</summary><label>Credential environment variable<input value={environment} disabled={locked||!!active(login)} onChange={e=>setEnvironment(e.target.value)} placeholder="MY_PROVIDER_API_KEY" autoComplete="off"/></label><p className="muted">Use a variable name configured for the service. Stored Pi credentials take precedence.</p><button disabled={locked||!!active(login)||!environment} onClick={()=>void saveEnvironment()}>Save provider reference</button></details>}</>}</section>;
}
