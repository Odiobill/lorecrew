import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as credentials from '../../src/runtime/provider-credentials.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'credentials-'));roots.push(root);const path=join(root,'pi','agent','auth.json');return {root,path,store:credentials.openCredentialFile(path)};}
it('implements a file CredentialStore',()=>{expect(credentials.openCredentialFile).toBeTypeOf('function');});
it('preserves unrelated providers and extra credential fields with restrictive durable writes',async()=>{
 const {path,store}=await fixture();await store.modify('openai',async()=>({type:'api_key',key:'fake-key'}));
 expect((await stat(path)).mode&0o777).toBe(0o600);expect((await stat(join(path,'..'))).mode&0o777).toBe(0o700);
 const data={other:{type:'future',custom:{preserve:true}},openai:{type:'api_key',key:'old',extra:'preserve'}};await writeFile(path,JSON.stringify(data));
 await store.modify('openai',async current=>({...current!,key:'new'}));expect(JSON.parse(await readFile(path,'utf8'))).toEqual({...data,openai:{...data.openai,key:'new'}});
 expect(await store.list()).toEqual([{providerId:'openai',type:'api_key'}]);
});
it('fails closed for malformed/unknown selected credentials without returning file content',async()=>{
 const {path,store}=await fixture();await mkdir(join(path,'..'),{recursive:true});const bad='{"secret":"fake-private-contents"';await writeFile(path,bad);
 await expect(store.read('openai')).rejects.toThrow('Credential file is invalid');await expect(store.modify('openai',async()=>({type:'api_key',key:'new'}))).rejects.toThrow('Credential file is invalid');expect(await readFile(path,'utf8')).toBe(bad);
 await writeFile(path,'{"openai":{"type":"future","secret":"fake-private-contents"}}');await expect(store.modify('openai',async()=>({type:'api_key',key:'new'}))).rejects.toThrow('Unsupported credential');
});
it('serializes independent writers, refresh and replacement without losing entries',async()=>{
 const {path,store}=await fixture();const second=credentials.openCredentialFile(path);
 await Promise.all(Array.from({length:12},(_,i)=>(i%2?store:second).modify('provider-'+i,async()=>({type:'api_key',key:'fake-'+i}))));expect(await store.list()).toHaveLength(12);
 await store.modify('oauth',async()=>({type:'oauth',access:'old',refresh:'old-refresh',expires:0}));
 let release!:()=>void;const wait=new Promise<void>(r=>release=r);let started!:()=>void;const ready=new Promise<void>(r=>started=r);
 const refresh=store.modify('oauth',async current=>{started();await wait;return {...current!,access:'refreshed'};});await ready;
 const replace=second.modify('oauth',async()=>({type:'api_key',key:'replacement'}));release();await Promise.all([refresh,replace]);expect(await store.read('oauth')).toEqual({type:'api_key',key:'replacement'});
});
it('does not execute command keys during read or enumeration',async()=>{const {store}=await fixture();await store.modify('openai',async()=>({type:'api_key',key:'!touch /must-never-execute'}));expect(await store.read('openai')).toMatchObject({key:'!touch /must-never-execute'});expect(await store.list()).toHaveLength(1);});

it('interoperates with the Pi mkdir lock across real Node processes',async()=>{
 const {path,store}=await fixture();const {spawn}=await import('node:child_process');
 const worker=async(index:number)=>new Promise<void>((resolve,reject)=>{const code=`import {openCredentialFile} from './src/runtime/provider-credentials.ts';await openCredentialFile(process.argv[1]).modify('child-'+process.argv[2],async()=>({type:'api_key',key:'fake-child'}));`;const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',code,path,String(index)],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:join(path,'..')}});let error='';child.stderr.on('data',d=>error+=d);child.on('error',reject);child.on('close',status=>status===0?resolve():reject(Error(error)));});
 await Promise.all([worker(1),worker(2),worker(3),store.modify('parent',async()=>({type:'api_key',key:'fake-parent'}))]);expect((await store.list()).map(e=>e.providerId).sort()).toEqual(['child-1','child-2','child-3','parent']);
});

it('cancels lock waits promptly without publishing a replacement',async()=>{
 const {path,store}=await fixture();await store.modify('openai',async()=>({type:'api_key',key:'old'}));const lockfile=(await import('proper-lockfile')).default;const release=await lockfile.lock(path,{realpath:false});
 try{const controller=new AbortController();const waiting=store.modify('openai',async()=>({type:'api_key',key:'new'}),{signal:controller.signal});setTimeout(()=>controller.abort(),10);await expect(Promise.race([waiting,new Promise((_,reject)=>setTimeout(()=>reject(Error('lock wait did not cancel promptly')),200))])).rejects.toThrow(/abort/i);}finally{await release();}expect(await store.read('openai')).toMatchObject({key:'old'});
});
it('does not commit after the shared lock is compromised',async()=>{
 const {path,store}=await fixture();await store.modify('openai',async()=>({type:'api_key',key:'old'}));await expect(store.modify('openai',async()=>{await rm(path+'.lock',{recursive:true,force:true});await new Promise(r=>setTimeout(r,1200));return {type:'api_key',key:'must-not-publish'};})).rejects.toThrow();expect(await store.read('openai')).toMatchObject({key:'old'});
});

it('waits for Pi-compatible in-place writers before reading or listing the shared file',async()=>{
 const {path,store}=await fixture();await store.modify('openai',async()=>({type:'api_key',key:'old'}));const lockfile=(await import('proper-lockfile')).default;const release=await lockfile.lock(path,{realpath:false});
 await writeFile(path,'');let settled=false;const read=store.read('openai').then(value=>{settled=true;return value;});const list=store.list();void read.catch(()=>{});void list.catch(()=>{});await new Promise(r=>setTimeout(r,60));expect(settled).toBe(false);
 await writeFile(path,'{"openai":{"type":"api_key","key":"pi-written"}}');await release();expect(await read).toMatchObject({key:'pi-written'});expect(await list).toEqual([{providerId:'openai',type:'api_key'}]);
});
