import {createContext,useCallback,useContext,useEffect,useRef,useState,type RefObject} from 'react';
import {ApiError,type ApiClient} from '../api.js';
import type {InboxResultRef} from '../../src/attention/types.js';
import {revision} from '../../src/attention/revision.js';
type ReadContext={mark:(ref:InboxResultRef)=>void;retry:()=>void;error:string};
export const ResultReadContext=createContext<ReadContext>({mark:()=>{},retry:()=>{},error:''});
const same=(a:InboxResultRef,b:InboxResultRef)=>a.id===b.id&&a.revision===b.revision;
/** A tiny durable read intent only. No result text, secret or model mutation is queued. */
export function useResultReads(api:ApiClient,instanceId:string,enabled:boolean,online:boolean,onRead:()=>Promise<unknown>,onFailure:(e:unknown)=>void):ReadContext{
 const key='lorecrew:result-reads:'+instanceId,memory=useRef<InboxResultRef[]>([]),generation=useRef(0),inflight=useRef(new Set<string>()),confirmed=useRef(new Set<string>());
 const [error,setError]=useState('');
 const read=useCallback(()=>{try{const value:unknown=JSON.parse(localStorage.getItem(key)??'[]');if(Array.isArray(value))return value.filter((r):r is InboxResultRef=>!!r&&typeof r==='object'&&typeof r.id==='string'&&r.id.length<=256&&typeof r.revision==='string'&&r.revision.length<=128).slice(-1000);}catch{}return memory.current;},[key]);
 const write=useCallback((refs:InboxResultRef[])=>{memory.current=refs;try{if(refs.length)localStorage.setItem(key,JSON.stringify(refs));else localStorage.removeItem(key);}catch{/* The server still confirms the deterministic read request. */}},[key]);
 const flush=useCallback(async()=>{
  if(!enabled||!online||!instanceId)return;const current=generation.current;
  for(const ref of read()){
   const requestKey='read-'+revision(ref);if(inflight.current.has(requestKey))continue;inflight.current.add(requestKey);
   try{await api.operateWithKey('/inbox/seen',{id:ref.id,revision:ref.revision},requestKey,'PUT');if(current!==generation.current)return;confirmed.current.add(requestKey);write(read().filter(r=>!same(r,ref)));setError('');await onRead();}
   catch(e){if(current!==generation.current)return;setError(e instanceof Error?e.message:'Read could not be saved. It will retry.');if(e instanceof ApiError&&e.status===401)onFailure(e);}
   finally{inflight.current.delete(requestKey);}
  }
 },[api,enabled,online,instanceId,read,write,onRead,onFailure]);
 useEffect(()=>{generation.current++;memory.current=[];confirmed.current.clear();void flush();const timer=setInterval(()=>void flush(),2000);return()=>{generation.current++;clearInterval(timer);};},[flush]);
 const mark=useCallback((ref:InboxResultRef)=>{if(!enabled||!instanceId||confirmed.current.has('read-'+revision(ref)))return;const refs=read();if(!refs.some(r=>same(r,ref)))write([...refs,{id:ref.id,revision:ref.revision}]);void flush();},[enabled,instanceId,read,write,flush]);
 return {mark,error,retry:()=>void flush()};
}
/** Observe the captured body revision only after rendering in an active, visible, focused detail. */
export function useResultRead(ref:InboxResultRef|undefined,element:RefObject<HTMLElement|null>){
 const {mark}=useContext(ResultReadContext),sent=useRef(new Set<string>());
 useEffect(()=>{
  if(!ref)return;const captured={id:ref.id,revision:ref.revision},identity=revision(captured);let timer:ReturnType<typeof setTimeout>|undefined,stopped=false;
  const visible=()=>{const node=element.current;if(!node?.isConnected||document.visibilityState!=='visible'||!document.hasFocus()||!node.getClientRects().length)return false;for(let parent=node.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement&&!parent.open)return false;const box=node.getBoundingClientRect();return box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;};
  const check=()=>{if(timer)clearTimeout(timer);if(stopped||sent.current.has(identity)||!visible())return;timer=setTimeout(()=>{if(!stopped&&visible()){sent.current.add(identity);mark(captured);}},100);};
  const observer=new IntersectionObserver(check);if(element.current)observer.observe(element.current);
  window.addEventListener('focus',check);window.addEventListener('blur',check);window.addEventListener('scroll',check,true);window.addEventListener('resize',check);document.addEventListener('visibilitychange',check);document.addEventListener('toggle',check,true);check();
  return()=>{stopped=true;if(timer)clearTimeout(timer);observer.disconnect();window.removeEventListener('focus',check);window.removeEventListener('blur',check);window.removeEventListener('scroll',check,true);window.removeEventListener('resize',check);document.removeEventListener('visibilitychange',check);document.removeEventListener('toggle',check,true);};
 },[ref?.id,ref?.revision,element,mark]);
}
