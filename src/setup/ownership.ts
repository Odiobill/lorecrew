import { lstat,mkdir,open,readFile,readdir,rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InstanceContext } from '../instance/open.js';
import type { GitClient } from '../git/client.js';
import { AppError } from '../contracts/base.js';
import { stableId } from '../runtime/admission.js';
import { initFleet,resolveRemote } from '../projects/ownership.js';
import { assertRestoredExecutionAllowed } from '../instance/recovery.js';
export interface OwnershipSetupInput {mode:'standalone'|'shared';remote?:string;expectedRevision:string}
interface Intent {mode:'standalone'|'shared';remote:string;nonce:string;phase:'pending'|'ready'}
export interface OwnershipSetupView {state:'unconfigured'|'pending'|'ready';mode?:'standalone'|'shared'|'configured';remote?:string;revision:string}
const queues=new WeakMap<InstanceContext,Promise<unknown>>();
function validateRemote(value:string,named=true):void{
 if(!value||value!==value.trim()||/[\r\n\0]/.test(value)||value.startsWith('-'))throw new AppError('INVALID_REMOTE','Enter a credential-free shared Git remote or absolute host repository path.');
 if(isAbsolute(value))return;
 if(named&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))return;
 if(/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value))return;
 let url:URL;try{url=new URL(value);}catch{throw new AppError('INVALID_REMOTE','Use an HTTP(S)/SSH Git URL, an absolute repository path, or an existing Git remote name.');}
 if(!['http:','https:','ssh:'].includes(url.protocol)||url.password||url.search||url.hash||/[?#\s]/.test(value)||url.username&&(url.protocol!=='ssh:'||!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(url.username)))throw new AppError('INVALID_REMOTE','Shared remote URLs cannot contain credentials, query strings, fragments or remote-helper schemes.');
}
function publicRemote(remote:string):{remote?:string}{try{validateRemote(remote,false);return {remote};}catch{return {};}}
async function checked(git:GitClient,cwd:string,args:string[]){if((await git.run(cwd,args)).exitCode)throw new AppError('GIT_FAILED','Cannot prepare the assignment repository. Check host Git access and permissions.');}
async function exists(path:string){try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
export function openSetupOwnership({ctx,git}:{ctx:InstanceContext;git:GitClient}){
 async function read():Promise<OwnershipSetupView>{
  const [binding,intent]=await Promise.all([ctx.store.read<{remote:string}>('fleet','assignments'),ctx.store.read<Intent>('setup-ownership','current')]);
  const revision=stableId(JSON.stringify(binding??null),JSON.stringify(intent??null));
  if(binding)return {state:'ready',mode:intent?.remote===binding.remote?intent.mode:'configured',...publicRemote(binding.remote),revision};
  return intent?{state:'pending',mode:intent.mode,...publicRemote(intent.remote),revision}:{state:'unconfigured',revision};
 }
 function configure(input:OwnershipSetupInput,_requestId:string):Promise<OwnershipSetupView>{
  const work=(queues.get(ctx)??Promise.resolve()).then(async()=>{
   await assertRestoredExecutionAllowed(ctx);
   if(!input||!['standalone','shared'].includes(input.mode)||typeof input.expectedRevision!=='string'||Object.keys(input).some(k=>!['mode','remote','expectedRevision'].includes(k))||input.mode==='standalone'&&input.remote!==undefined)throw new AppError('INVALID_REQUEST','Choose standalone or shared ownership setup.');
   let remote=join(ctx.stateDir,'assignments.git');
   if(input.mode==='shared'){if(typeof input.remote!=='string')throw new AppError('INVALID_REQUEST','Enter the shared assignment remote.');validateRemote(input.remote);remote=await resolveRemote(ctx,git,input.remote);validateRemote(remote,false);}
   const previous=await ctx.store.read<Intent>('setup-ownership','current'),binding=await ctx.store.read<{remote:string}>('fleet','assignments');
   if(binding){if(binding.remote!==remote)throw new AppError('FLEET_MISMATCH','This instance already has an assignment repository. Its authority cannot be replaced by setup.');return read();}
   if(!previous&&input.mode==='standalone'&&await exists(remote))throw new AppError('PROJECT_PATH_EXISTS','The reserved assignment repository path already exists. Existing content was left unchanged.');
   const before=await read();
   const intent=await ctx.store.transact(tx=>{
    const old=tx.get<Intent>('setup-ownership','current');
    if(old){if(old.mode!==input.mode||old.remote!==remote)throw new AppError('REVISION_CONFLICT','Another ownership choice is pending. Resume the saved choice.');return old;}
    if(before.revision!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Ownership setup changed in another tab. Reload saved progress.');
    const next:Intent={mode:input.mode,remote,nonce:randomUUID(),phase:'pending'};tx.put('setup-ownership','current',next);return next;
   });
   if(intent.mode==='standalone'){
    try{await mkdir(remote,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
    const metadata=await lstat(remote);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw new AppError('PROJECT_PATH_EXISTS','The assignment repository path changed. Existing content was left unchanged.');
    const markerName='lorecrew-setup-owner.json',scratchName=`.lorecrew-setup-owner.${intent.nonce}.pending`,marker=join(remote,markerName),scratch=join(remote,scratchName),expected=JSON.stringify({nonce:intent.nonce,instanceId:ctx.instanceId});
    async function markerText(path:string){const info=await exists(path);if(!info)return undefined;if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>Buffer.byteLength(expected))throw new AppError('PROJECT_PATH_EXISTS','The assignment marker changed. Existing content was left unchanged.');return readFile(path,'utf8');}
    const current=await markerText(marker);
    if(current!==expected){
     // Only journal-owned partial metadata in an otherwise empty reserved directory is recoverable.
     const names=await readdir(remote),partial=await markerText(scratch);
     if(names.some(name=>name!==markerName&&name!==scratchName)||current!==undefined&&!expected.startsWith(current)||partial!==undefined&&!expected.startsWith(partial))throw new AppError('PROJECT_PATH_EXISTS','An incomplete assignment repository has unknown content. It was left unchanged.');
     const file=await open(scratch,constants.O_WRONLY|constants.O_CREAT|constants.O_TRUNC|constants.O_NOFOLLOW,0o600);try{await file.writeFile(expected);await file.sync();}finally{await file.close();}
     await rename(scratch,marker);const folder=await open(remote,'r');try{await folder.sync();}finally{await folder.close();}
    }
    await checked(git,ctx.stateDir,['init','--bare','--template=','--initial-branch=main',remote]);
    await checked(git,remote,['config','receive.denyNonFastForwards','true']);await checked(git,remote,['config','receive.denyDeletes','true']);
   }
   await initFleet(ctx,git,remote);
   await ctx.store.transact(tx=>{tx.put('setup-ownership','current',{...intent,phase:'ready'});tx.emit('ownership.configured',{mode:intent.mode});});return read();
  });queues.set(ctx,work.catch(()=>{}));return work;
 }
 return {read,configure};
}
