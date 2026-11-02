/** Historical version1 writer fixture from1a6814a; never imported by application code. */
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError, encodeJson } from '../../../src/contracts/base.js';
import { redact } from '../../../src/export/redact.js';
import { component } from '../../../src/export/history.js';
import type { PublicationBatch, RedactionPolicy } from '../../../src/export/types.js';
import { CONTRIBUTION_PREFIX, FETCHED_CONTRIBUTION_PREFIX, FETCHED_SHARED_REF, SHARED_REF } from '../../../src/git/refs.js';
import { containsCredentials } from '../../../src/vault/indexes.js';
import { parseConcept, revisionOf, validatePath } from '../../../src/vault/parse.js';
import type { Contribution, ContentReference, SyncOptions } from '../../../src/sync/types.js';
export const hash=(text:string|null)=>text===null?null:revisionOf(text);
const fail=(message:string)=>new AppError('INVALID_CONTRIBUTION',message);
export function assertPublicationSafe(value:unknown,policy:RedactionPolicy={}):void {
  const held=(item:unknown):boolean=>typeof item==='string'?redact(item,policy).held:Array.isArray(item)?item.some(held):!!item&&typeof item==='object'?Object.entries(item).some(([key,value])=>held(key)||held(value)):false;
  if(held(value))throw new AppError('PUBLICATION_HELD','Automatic publication held: possible_secret. Original local content is retained.');
}
export function validateBatch(batch:PublicationBatch,origin:string):void {
  encodeJson(batch);
  if(!batch||typeof batch.id!=='string'||!batch.id.trim()||batch.originId!==origin||!Number.isFinite(Date.parse(batch.createdAt))||!Array.isArray(batch.files)||!batch.files.length||!(batch.baseRevision===null||/^[0-9a-f]{40,64}$/.test(batch.baseRevision)))throw fail('Invalid immutable publication batch');
  if(batch.actor!==undefined&&(typeof batch.actor!=='string'||!/^human:owner$|^(?:user|agent|process|schedule-owner):[^\s]+$/.test(batch.actor)))throw fail('Invalid publication actor');
  const paths=new Set<string>();
  for(const file of batch.files){
    validatePath(file.path);
    if(paths.has(file.path)||!(file.baseHash===null||/^[0-9a-f]{64}$/.test(file.baseHash))||!(file.content===null||typeof file.content==='string'))throw fail('Invalid file manifest');paths.add(file.path);
    if(file.path.startsWith('proposals/sync/')||file.path==='catalogs/sync/index.md'||/^(?:\.lorecrew|lorecrew|assignments|control)(?:\/|\.)/.test(file.path))throw fail('Reserved synchronization or assignment path');
    const parts=file.path.split('/');
    if(['history','status','devices'].includes(parts[0]!)){const owner=parts[0]==='devices'?parts[1]?.replace(/\.md$/,''):parts[1];if(owner!==component(origin))throw fail('Origin-owned path belongs to another instance');}
    if(['agents','projects'].includes(parts[0]!)&&parts.length>2&&parts[1]!==component(origin))throw fail('Origin-owned projection belongs to another instance');
    if(file.content!==null){
      const concept=parseConcept(file.path,file.content);const ext=concept.metadata.lorecrew;
      if(/^(?:Assignment|Ownership|OwnershipGrant|Control)$/i.test(String(concept.metadata.type)))throw fail('Executable assignment records cannot enter knowledge');
      if(ext&&typeof ext==='object'&&!Array.isArray(ext)){
        if(ext.originId!==undefined&&ext.originId!==origin)throw fail('Document origin differs from contribution owner');
        if(['ownerId','generation','transitionId','ownerInstanceId','assignment','assignments'].some(key=>ext[key]!==undefined))throw fail('Executable assignment fields cannot enter knowledge');
      }
      if(['TaskStatus','AgentStatus','ProjectStatus','Device','History'].includes(String(concept.metadata.type))&&(!ext||typeof ext!=='object'||Array.isArray(ext)||ext.originId!==origin))throw fail('Reported projections require their origin');
      if(containsCredentials(concept.metadata.lorecrew))throw fail('Portable configuration contains credentials');
      if(/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(file.content))throw fail('Unresolved merge markers');
    }
  }
}
export class StagingRepository {
 readonly cwd:string; endpoint='';
 private objects=new Map<string,string>();private objectBytes=0;
 private remember(key:string,value:string){if(value.length>2_000_000)return;const old=this.objects.get(key);if(old!==undefined)this.objectBytes-=old.length;this.objects.delete(key);this.objects.set(key,value);this.objectBytes+=value.length;while(this.objectBytes>4_000_000||this.objects.size>256){const first=this.objects.keys().next().value!;this.objectBytes-=this.objects.get(first)!.length;this.objects.delete(first);}}
 constructor(readonly options:SyncOptions){this.cwd=join(options.ctx.stateDir,'staging','sync');}
 async run(args:string[]):Promise<string>{const r=await this.options.git.run(this.cwd,args);if(r.exitCode!==0)throw new AppError('SYNC_GIT','Git synchronization could not be confirmed');return r.stdout;}
 async init(){
  const {ctx,git,remote}=this.options;
  if(!remote||remote.startsWith('-')||remote.startsWith('ext::')||/[\r\n\0]/.test(remote))throw new AppError('INVALID_REMOTE','Invalid synchronization remote');
  const named=await git.run(ctx.vaultDir,['remote','get-url',remote]);const url=named.exitCode===0?named.stdout.trim():remote;
  this.endpoint=!isAbsolute(url)&&!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url)&&!/^[^/]+@[^/:]+:/.test(url)?resolve(ctx.vaultDir,url):url;
  if(this.endpoint.startsWith('-')||this.endpoint.startsWith('ext::')||/[\r\n\0]/.test(this.endpoint))throw new AppError('INVALID_REMOTE','Invalid synchronization endpoint');
  await ctx.store.transact(tx=>{const previous=tx.get<{remote:string}>('fleet','knowledge');if(previous&&previous.remote!==this.endpoint)throw new AppError('FLEET_MISMATCH','Knowledge remote differs from established binding');tx.put('fleet','knowledge',{remote:this.endpoint});});
  await mkdir(this.cwd,{recursive:true,mode:0o700});await this.run(['init','--quiet']);
 }
 async fetch():Promise<{head:string|null;branches:Array<{origin:string;head:string}>}>{
  const advertised=await this.run(['ls-remote','--heads',this.endpoint,SHARED_REF]);
  await this.run(['fetch','--no-tags','--no-write-fetch-head','--prune',this.endpoint,...advertised.trim()?[`+${SHARED_REF}:${FETCHED_SHARED_REF}`]:[],`+${CONTRIBUTION_PREFIX}*:${FETCHED_CONTRIBUTION_PREFIX}*`]);
  const head=advertised.trim()?(await this.run(['rev-parse',FETCHED_SHARED_REF])).trim():null;
  const refs=(await this.run(['for-each-ref','--format=%(refname) %(objectname)',FETCHED_CONTRIBUTION_PREFIX])).trim();
  return {head,branches:refs?refs.split('\n').map(line=>{const [ref,head]=line.split(' ');return {origin:ref!.slice(FETCHED_CONTRIBUTION_PREFIX.length),head:head!};}):[]};
 }
 async text(commit:string|null,path:string):Promise<string|null>{
  if(commit===null)return null;
  const key=`text:${commit}:${path}`;const cached=this.objects.get(key);if(cached!==undefined)return JSON.parse(cached) as string|null;
  const entry=await this.run(['ls-tree',commit,'--',path]);if(!entry){this.remember(key,'null');return null;}
  if(!/^100(?:644|755) blob /.test(entry))throw fail('Only ordinary files are accepted');
  const value=await this.run(['show',`${commit}:${path}`]);this.remember(key,JSON.stringify(value));return value;
 }
 async tree(commit:string|null):Promise<Map<string,string>>{
  const files=new Map<string,string>();if(commit===null)return files;
  const key=`tree:${commit}`;const cached=this.objects.get(key);if(cached!==undefined)return new Map(JSON.parse(cached));
  const list=await this.run(['ls-tree','-rlz',commit]);
  const entries=list.split('\0').filter(Boolean).map(entry=>{const match=/^100(?:644|755) blob ([0-9a-f]+) +([0-9]+)\t([\s\S]+)$/.exec(entry);if(!match)throw fail('Only ordinary files are accepted');return {hash:match[1]!,size:Number(match[2]),path:match[3]!};});
  for(let offset=0;offset<entries.length;offset+=128){const group=entries.slice(offset,offset+128);const bytes=Buffer.from(await this.run(['show',...group.map(e=>e.hash)]));let cursor=0;for(const entry of group){files.set(entry.path,bytes.subarray(cursor,cursor+entry.size).toString());cursor+=entry.size;}if(cursor!==bytes.length)throw fail('Invalid batched object read');}
  this.remember(key,JSON.stringify([...files]));return files;
 }
 async commit(parent:string|null,files:Map<string,string>,message:unknown):Promise<string>{
  // Only the service-owned index and object database change. Live vault Git is read-only.
  await this.run(parent?['read-tree',parent]:['read-tree','--empty']);
  const old=await this.tree(parent);
  for(const path of old.keys())if(!files.has(path))await this.run(['update-index','--force-remove','--',path]);
  for(const [path,text] of files){if(old.get(path)===text)continue;await writeFile(join(this.cwd,'candidate-blob'),text);const blob=(await this.run(['hash-object','-w','candidate-blob'])).trim();await this.run(['update-index','--add','--cacheinfo',`100644,${blob},${path}`]);}
  const tree=(await this.run(['write-tree'])).trim();return (await this.run(['-c','user.name=Lorecrew','-c','user.email=lorecrew@localhost','commit-tree',tree,...parent?['-p',parent]:[],'-m',JSON.stringify(message)])).trim();
 }
 async push(commit:string,ref:string){await this.options.git.run(this.cwd,['push',this.endpoint,`${commit}:${ref}`]).catch(()=>undefined);}
 async metadata(commit:string):Promise<unknown>{try{const saved=await this.options.ctx.store.read<{value:string}>('sync-git-metadata-v1',commit);const value=saved?.value??await this.run(['show','-s','--format=%B',commit]);if(!saved)await this.options.ctx.store.transact(tx=>tx.put('sync-git-metadata-v1',commit,{value}));return JSON.parse(value);}catch(error){if(error instanceof SyntaxError)return undefined;throw error;}}
 async contributions(branches:Array<{origin:string;head:string}>,shared:string|null,accepted=new Set<string>(),requestedId?:string):Promise<Contribution[]>{
  interface BatchMetadata {id:string;commit:string;baseRevision:string|null;identity:string;sequence:number}
  interface BranchState {head:string;shared:string|null;sequence:number}
  const all:Contribution[]=[];const identities=new Map<string,string>();
  for(const branch of [...branches].sort((a,b)=>a.origin.localeCompare(b.origin))){
    const kind=`sync-branch-batches-v3:${branch.origin}`;const paths=`sync-branch-paths-v3:${branch.origin}`;
    let state=await this.options.ctx.store.read<BranchState>('sync-branch-state-v3',branch.origin);
    if(!state||state.head!==branch.head&&(await this.options.git.run(this.cwd,['merge-base','--is-ancestor',state.head,branch.head])).exitCode!==0){
      const ids=await this.options.ctx.store.keys(kind),pathIds=await this.options.ctx.store.keys(paths);
      await this.options.ctx.store.transact(tx=>{tx.delete('sync-branch-state-v3',branch.origin);for(const id of ids)tx.delete(kind,id);for(const path of pathIds)tx.delete(paths,path);});state=undefined;
    }
    let metadata=await this.options.ctx.store.list<BatchMetadata>(kind);
    const established=state?.shared!==null&&state?.shared!==undefined&&shared!==null&&(state.shared===shared||(await this.options.git.run(this.cwd,['merge-base','--is-ancestor',state.shared,shared])).exitCode===0);
    if(!established)for(const base of new Set(metadata.flatMap(item=>item.baseRevision?[item.baseRevision]:[]))){if(shared===null||(await this.options.git.run(this.cwd,['merge-base','--is-ancestor',base,shared])).exitCode!==0)throw fail('Publication base is not established shared ancestry');}
    for(const item of metadata){const known=identities.get(item.id);if(known!==undefined&&known!==item.identity)throw fail('Batch ID was reused with different content');identities.set(item.id,item.identity);}
    const rows=state?.head===branch.head?[]:(await this.run(['rev-list','--first-parent','--reverse','--parents',branch.head,...state?[`^${state.head}`]:[]])).trim().split('\n').filter(Boolean);
    let sequence=state?.sequence??0;
    for(const row of rows){const [commit,...parents]=row.split(' ');const message=await this.metadata(commit!) as {format?:string;batch?:PublicationBatch}|undefined;
      if(message?.format==='lorecrew-contribution-v1'){
        const batch=message.batch!;validateBatch(batch,branch.origin);const identity=revisionOf(JSON.stringify(batch));const known=identities.get(batch.id);
        if(known!==undefined&&known!==identity)throw fail('Batch ID was reused with different content');
        const item=await this.describe(batch,shared);item.commit=commit!;
        if(parents.length>1)throw fail('Contribution commits must have one parent');const before=await this.tree(parents[0]??null),after=await this.tree(commit!);
        for(const file of batch.files){if(file.content===null)before.delete(file.path);else before.set(file.path,file.content);}
        if(before.size!==after.size||[...before].some(([path,text])=>after.get(path)!==text))throw fail('Contribution tree differs from immutable manifest');
        if(known===undefined){const summary:BatchMetadata={id:batch.id,commit:commit!,baseRevision:batch.baseRevision,identity,sequence:++sequence};
          await this.options.ctx.store.transact(tx=>{tx.put('sync-branch-state-v3',branch.origin,{head:commit,shared,sequence});tx.put('sync-validated-commit',`v3:${branch.origin}:${commit}`,item);tx.put(kind,String(sequence).padStart(16,'0'),summary);for(const file of batch.files)tx.put(paths,file.path,{commit,batchId:batch.id,hash:hash(file.content)});});metadata.push(summary);identities.set(batch.id,identity);
        }
      }
      state={head:commit!,shared,sequence};await this.options.ctx.store.transact(tx=>tx.put('sync-branch-state-v3',branch.origin,state));
    }
    // Only compact indexes are revisited. Accepted historical manifests and
    // transcript bodies are not deserialized on idle or one-file update passes.
    const included=new Set<string>();for(const summary of metadata)if((!accepted.has(summary.id)||summary.id===requestedId)&&!included.has(summary.id)){const item=await this.options.ctx.store.read<Contribution>('sync-validated-commit',`v3:${branch.origin}:${summary.commit}`);if(!item){await this.options.ctx.store.transact(tx=>tx.delete('sync-branch-state-v3',branch.origin));return this.contributions(branches,shared,accepted,requestedId);}all.push(item);included.add(summary.id);}
    await this.options.ctx.store.transact(tx=>tx.put('sync-branch-state-v3',branch.origin,{head:branch.head,shared,sequence}));
  }
  return all;
 }
 async describe(batch:PublicationBatch,shared:string|null):Promise<Contribution>{
  if(batch.baseRevision!==null){if(shared===null||(await this.options.git.run(this.cwd,['merge-base','--is-ancestor',batch.baseRevision,shared])).exitCode!==0)throw fail('Publication base is not established shared ancestry');}
  const bases:Record<string,ContentReference>={};const dependencies=new Set<string>();
  for(const file of batch.files){
    // contributions() advances this index only after validating each manifest.
    // It retains the latest predecessor even when that batch is already accepted.
    const indexed=await this.options.ctx.store.read<{commit:string;batchId:string;hash:string|null}>(`sync-branch-paths-v3:${batch.originId}`,file.path);
    if(indexed&&indexed.hash===file.baseHash){bases[file.path]={hash:file.baseHash,commit:indexed.commit,path:file.path};dependencies.add(indexed.batchId);}
    else{const base=await this.text(batch.baseRevision,file.path);if(hash(base)!==file.baseHash)throw fail('Source hash does not name shared bytes or preceding contribution');bases[file.path]={hash:file.baseHash,commit:batch.baseRevision,path:file.path};}
    const old=await this.text(bases[file.path]!.commit,file.path);
    if(old!==null){if(file.path.startsWith('history/')&&!file.path.endsWith('/index.md')&&file.content!==old)throw fail('History segments are immutable');const ext=parseConcept(file.path,old).metadata.lorecrew;if(ext&&typeof ext==='object'&&!Array.isArray(ext)&&ext.originId!==undefined&&ext.originId!==batch.originId)throw fail('Existing document is owned by another origin');}
  }return {batch,commit:'',bases,dependencies:[...dependencies]};
 }
}
