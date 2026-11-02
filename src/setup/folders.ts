import { lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { StateContext } from '../instance/state.js';
import { dirname,isAbsolute,join,relative,sep } from 'node:path';
import type { InstanceContext } from '../instance/open.js';
import type { GitClient } from '../git/client.js';
import type { HostFolderListing } from './types.js';
import { AppError } from '../contracts/base.js';
export const within=(root:string,path:string)=>{const r=relative(root,path);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);};
export function projectPathAllowed(ctx:Pick<StateContext,'stateDir'>&{vaultDir?:string},path:string):boolean{return !within(ctx.stateDir,path)&&!within(path,ctx.stateDir)&&(!ctx.vaultDir||!within(ctx.vaultDir,path)&&!within(path,ctx.vaultDir));}
export async function directory(path:string):Promise<string>{try{const actual=await realpath(path);if(!(await lstat(actual)).isDirectory())throw Error();return actual;}catch{throw new AppError('INVALID_PROJECT_PATH','Choose an existing directory on the instance host.');}}
export async function pathExists(path:string){try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
export async function listHostFolders(ctx:StateContext&{vaultDir?:string},input:{path?:string;cursor?:string}):Promise<HostFolderListing>{
 const path=await directory(input.path??(ctx.vaultDir?dirname(ctx.vaultDir):homedir()));
 if(within(ctx.stateDir,path))throw new AppError('FORBIDDEN','Operational state folders are not available in the project browser.');
 const names=(await readdir(path,{withFileTypes:true})).filter(d=>d.isDirectory()&&!d.name.startsWith('.')&&!within(ctx.stateDir,join(path,d.name))).map(d=>d.name).sort();
 const after=names.filter(name=>input.cursor===undefined||name>input.cursor),page=after.slice(0,100);
 return {path,parent:dirname(path)===path?null:dirname(path),selectable:projectPathAllowed(ctx,path),items:page.map(name=>({name,path:join(path,name)})),...after.length>100?{nextCursor:page.at(-1)!}:{}};
}
export interface FolderEvidence {dev:number;ino:number}
export interface FolderIntent {projectId:string;title:string;path:string;nonce:string;directory?:FolderEvidence;adoptedExisting?:boolean}
const markerName='.lorecrew-setup-owner.json';
export async function prepareNewFolder(ctx:InstanceContext,intent:FolderIntent,persist:()=>Promise<void>):Promise<void>{
 if(!projectPathAllowed(ctx,intent.path))throw new AppError('INVALID_PROJECT_PATH','A project cannot contain or be inside Lorecrew operational state.');
 if(intent.adoptedExisting){await directory(intent.path);return;}
 let info=await pathExists(intent.path);const marker=join(intent.path,markerName),expected=JSON.stringify({projectId:intent.projectId,nonce:intent.nonce});
 if(intent.directory){if(!info?.isDirectory()||info.isSymbolicLink()||info.dev!==intent.directory.dev||info.ino!==intent.directory.ino||await realpath(intent.path)!==intent.path)throw new AppError('PROJECT_FOLDER_CHANGED','The created folder changed. Resume only after restoring it, or select it explicitly as an existing folder.');return;}
 if(info){
  if(!info.isDirectory()||info.isSymbolicLink())throw new AppError('PROJECT_PATH_EXISTS','The selected project name already exists. Existing content was left unchanged.');
  let owner:string;try{owner=await readFile(marker,'utf8');}catch{throw new AppError('PROJECT_FOLDER_UNCERTAIN','A folder exists after interrupted creation. Use existing folder explicitly to connect it without initializing or overwriting its contents.');}
  if(owner!==expected)throw new AppError('PROJECT_FOLDER_UNCERTAIN','The existing folder belongs to another operation. Its contents were left unchanged.');
 }else{
  try{await mkdir(intent.path,{mode:0o700});}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new AppError('PROJECT_PATH_EXISTS','A folder with this name appeared. Existing content was left unchanged.');throw e;}
  const file=await open(marker,'wx',0o600);try{await file.writeFile(expected);await file.sync();}finally{await file.close();}
  for(const path of [intent.path,dirname(intent.path)]){const handle=await open(path,'r');try{await handle.sync();}finally{await handle.close();}}
  info=await lstat(intent.path);
 }
 intent.directory={dev:info!.dev,ino:info!.ino};await persist();
}
export async function initializeProjectGit(ctx:InstanceContext,git:GitClient,intent:FolderIntent):Promise<void>{
 const hooks=await mkdtemp(join(ctx.stateDir,'staging','empty-hooks-'));
 const run=async(args:string[])=>{const result=await git.run(intent.path,['-c','core.fsmonitor=false','-c',`core.hooksPath=${hooks}`,...args]);if(result.exitCode)throw new AppError('GIT_FAILED','Project Git initialization could not be completed. Existing files were retained; resume the connection to retry.');return result.stdout.trim();};
 try{
  const metadata=await pathExists(join(intent.path,'.git'));if(metadata&&(!metadata.isDirectory()||metadata.isSymbolicLink()))throw new AppError('INVALID_GIT_PROJECT','The new Git metadata path changed. Existing content was retained.');
  await run(['init','--template=','--initial-branch=main']);
  if((await git.run(intent.path,['rev-parse','--verify','HEAD'])).exitCode===0)return;
  const readme=`# ${intent.title}\n\nCreated with Lorecrew.\n`,path=join(intent.path,'README.md');
  try{const file=await open(path,'wx',0o644);try{await file.writeFile(readme);await file.sync();}finally{await file.close();}}
  catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;if(await readFile(path,'utf8')!==readme)throw new AppError('PROJECT_FOLDER_CHANGED','README.md changed during initialization. It was not overwritten.');}
  const blob=await run(['hash-object','-w','--no-filters','README.md']);await run(['read-tree','--empty']);await run(['update-index','--add','--cacheinfo',`100644,${blob},README.md`]);const tree=await run(['write-tree']);const commit=await run(['-c','user.name=Lorecrew','-c','user.email=lorecrew@localhost','-c','commit.gpgSign=false','commit-tree',tree,'-m','Initialize project']);await run(['update-ref','refs/heads/main',commit,'0000000000000000000000000000000000000000']);
 }finally{await rm(hooks,{recursive:true,force:true});}
}
export async function removeFolderMarker(intent:FolderIntent):Promise<void>{const marker=join(intent.path,markerName);try{if(await readFile(marker,'utf8')===JSON.stringify({projectId:intent.projectId,nonce:intent.nonce}))await rm(marker);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
