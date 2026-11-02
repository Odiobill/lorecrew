import { AppError } from '../../contracts/base.js';
export interface GitHubReader {get(path:string,signal:AbortSignal):Promise<unknown>}
const MAX_JSON=2_097_152;
/** Fixed public origin, no inherited auth, cookies, redirects or download URLs. */
export const publicGitHub:GitHubReader={async get(path,signal){
 if(!/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:$|\/(?:commits\/[^?#]+|git\/(?:trees|blobs)\/[a-f0-9]{40}(?:\?recursive=1)?))$/.test(path))throw new AppError('UNSAFE_SOURCE','Invalid GitHub object request');
 const url='https://api.github.com'+path;let response:Response;
 try{response=await fetch(url,{method:'GET',redirect:'error',credentials:'omit',headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'Lorecrew'},signal});}catch(error){if(signal.aborted)throw new AppError('SOURCE_TIMEOUT','GitHub timed out; retry or choose a narrower folder');throw new AppError('SOURCE_UNAVAILABLE','Public GitHub request failed; retry explicitly');}
 if(response.url!==url||response.redirected)throw new AppError('UNSAFE_SOURCE','Unexpected GitHub response URL');
 if(!response.ok){await response.body?.cancel();throw new AppError('SOURCE_UNAVAILABLE',`GitHub returned HTTP ${response.status}.${response.headers.get('retry-after')?' Retry after '+response.headers.get('retry-after')+'.':''} Check the public repository/ref or retry later.`);}
 const reader=response.body?.getReader();if(!reader)throw new AppError('SOURCE_UNAVAILABLE','Empty GitHub response');let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_JSON)throw new AppError('SOURCE_LIMIT','GitHub JSON exceeds 2 MiB; choose a narrower source');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{throw new AppError('INVALID_SOURCE','GitHub returned malformed JSON');}
}};
export function githubAction(reader:GitHubReader){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60_000);let count=0;
 return {async get(path:string){
  if(++count>48)throw new AppError('SOURCE_LIMIT','48-request action budget exceeded; choose a narrower source');
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15_000)]);let rejectAbort:()=>void=()=>{};
  try{return await Promise.race([reader.get(path,signal),new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new AppError('SOURCE_TIMEOUT','GitHub timed out; retry or choose a narrower source'));if(signal.aborted)rejectAbort();else signal.addEventListener('abort',rejectAbort,{once:true});})]);}
  catch(error){if(signal.aborted)throw new AppError('SOURCE_TIMEOUT','GitHub timed out; retry or choose a narrower source');throw error;}
  finally{signal.removeEventListener('abort',rejectAbort);}
 },close(){clearTimeout(timer);controller.abort();}};
}
export function sourceObject(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('INVALID_SOURCE','Invalid GitHub object');return value as Record<string,unknown>;}
export function gitId(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{40}$/.test(value))throw new AppError('INVALID_SOURCE','GitHub object ID is invalid');return value;}
