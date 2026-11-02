import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { setTimeout as delay } from 'node:timers/promises';
import type { AuthOperationOptions, Credential, CredentialStore } from '@earendil-works/pi-ai';
import { AppError } from '../contracts/base.js';

/** Same file and lock name used by Pi. Tests/services can explicitly isolate it. */
export function credentialFilePath():string {
  return resolve(process.env.LORECREW_AUTH_FILE ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(),'.pi','agent'),'auth.json'));
}
export function credentialFingerprint(value:Credential|undefined):string {
  return createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
function credential(value:unknown):Credential|undefined {
  if(value===undefined)return undefined;
  if(!object(value))throw new AppError('INVALID_CREDENTIALS','Unsupported credential entry');
  if(value.type==='api_key' && (value.key===undefined||typeof value.key==='string') && (value.env===undefined||(object(value.env)&&Object.values(value.env).every(v=>typeof v==='string'))))return value as unknown as Credential;
  if(value.type==='oauth' && typeof value.access==='string' && typeof value.refresh==='string' && typeof value.expires==='number' && Number.isFinite(value.expires))return value as unknown as Credential;
  throw new AppError('INVALID_CREDENTIALS','Unsupported credential entry');
}
async function contents(path:string):Promise<Record<string,unknown>> {
  try {
    if(!(await lstat(path)).isFile())throw new Error('not a regular file');
    const value:unknown=JSON.parse(await readFile(path,'utf8'));
    if(!object(value))throw new Error('not an object');
    return value;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return {};
    throw new AppError('INVALID_CREDENTIALS','Credential file is invalid or cannot be read');
  }
}
async function persist(path:string,data:Record<string,unknown>,check:()=>void):Promise<void> {
  const temp=join(dirname(path),`.auth-${randomUUID()}.tmp`);
  try {
    const file=await open(temp,'wx',0o600);
    try{await file.writeFile(JSON.stringify(data,null,2)+'\n');await file.sync();}finally{await file.close();}
    check();await rename(temp,path);
    const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}
  }finally{await rm(temp,{force:true});}
}
export function openCredentialFile(path=credentialFilePath()):CredentialStore {
  async function locked<T>(work:(check:()=>void)=>Promise<T>,options?:AuthOperationOptions):Promise<T>{
    options?.signal?.throwIfAborted();
    await mkdir(dirname(path),{recursive:true,mode:0o700});
    // proper-lockfile's mkdir lock interoperates with Pi's auth.json.lock.
    // Its heartbeat protects long refresh operations from stale-lock takeover.
    let compromised=false;
    let release:()=>Promise<void>;const deadline=Date.now()+30_000;
    for(;;){
      options?.signal?.throwIfAborted();
      try{release=await lockfile.lock(path,{realpath:false,retries:0,stale:30_000,update:1000,onCompromised:()=>{compromised=true;}});break;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ELOCKED'||Date.now()>=deadline)throw error;await delay(50,undefined,options?.signal?{signal:options.signal}:{});}
    }
    try{const check=()=>{options?.signal?.throwIfAborted();if(compromised)throw new AppError('CREDENTIAL_LOCK_LOST','Credential file lock was lost');};check();const result=await work(check);if(compromised)throw new AppError('CREDENTIAL_LOCK_LOST','Credential file lock was lost');return result;}
    finally{await release();}
  }
  // Pi may truncate/write in place while holding the same lock. Read under
  // that lock too; a missing parent cannot have a concurrent lock holder.
  const reading=new WeakMap<AbortSignal,Promise<Record<string,unknown>>>();
  let unscopedRead:Promise<Record<string,unknown>>|undefined;
  function snapshot(options?:AuthOperationOptions):Promise<Record<string,unknown>>{
    const signal=options?.signal,prior=signal?reading.get(signal):unscopedRead;if(prior)return prior;
    const pending=(async()=>{
      try{await lstat(dirname(path));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {};throw error;}
      return locked(async()=>contents(path),options);
    })();
    if(signal)reading.set(signal,pending);else unscopedRead=pending;
    void pending.finally(()=>{if(signal)reading.delete(signal);else if(unscopedRead===pending)unscopedRead=undefined;}).catch(()=>{});
    return pending;
  }
  return {
    async read(id,options){options?.signal?.throwIfAborted();return structuredClone(credential((await snapshot(options))[id]));},
    async list(options){options?.signal?.throwIfAborted();const entries=await snapshot(options);return Object.entries(entries).flatMap(([providerId,value])=>{
      // Future/extension entries remain byte-for-value preserved, but do not
      // imply that a supported credential can be used by this pi-ai version.
      try{const known=credential(value);return known?[{providerId,type:known.type}]:[];}catch{return [];}
    });},
    modify(id,fn,options){return locked(async check=>{
      const data=await contents(path),current=credential(data[id]);
      const next=await fn(current);
      if(next!==undefined){
        credential(next);
        // A provider returns a complete canonical credential, not a patch.
        // Preserve extension metadata without resurrecting omitted key/env fields.
        const canonical=new Set(next.type==='api_key'?['type','key','env']:['type','access','refresh','expires']);
        const extras=current?.type===next.type?Object.fromEntries(Object.entries(current).filter(([field])=>!canonical.has(field))):{};
        data[id]={...extras,...next};
        await persist(path,data,check);
      }
      return credential(data[id]);
    },options);},
    delete(id,options){return locked(async check=>{const data=await contents(path);credential(data[id]);if(Object.hasOwn(data,id)){delete data[id];await persist(path,data,check);}},options);},
  };
}
