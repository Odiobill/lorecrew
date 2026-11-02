import {lstat,realpath,readdir} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AppError} from '../contracts/base.js';
import type {StateContext} from '../instance/state.js';
import {attachVault} from '../instance/open.js';
import {readConfig} from '../instance/config.js';
import {validateStatePlacement} from '../instance/placement.js';
import {stableId} from '../runtime/admission.js';
import {within} from './folders.js';
import {INITIAL_VAULT_INDEX} from '../vault/start.js';
import {openVault} from '../vault/write.js';
import {openSetupEntry} from './entry.js';
import {GitClient} from '../git/client.js';
import {openRepositories} from '../repositories/service.js';
import {planVaultIdentity,readVaultIdentity} from '../repositories/identity.js';
import {validateRemote} from '../repositories/create.js';
import {inputHash} from '../repositories/inspect.js';
import type {VaultIdentity} from '../repositories/types.js';
import type {StartupView,VaultChoice,VaultPreview} from './types.js';
type AcceptedChoice=VaultChoice|{kind:'default'};
interface Identity {dev:number;ino:number;uid:number}
interface Placement {path:string;parent:string;parentIdentity:Identity;targetIdentity?:Identity;kind:'new'|'existing';repositoryRevision?:string}
interface Intent extends Placement {id:string;requestId:string;choice:AcceptedChoice;previewToken:string;expectedRevision:string;phase:'reserved'|'folder'|'bound'|'scaffold'|'ready';directory?:Identity;identity?:VaultIdentity;starter?:boolean;cloneCompleted?:boolean;diagnostic?:string;diagnosticCode?:string}
const identity=(info:{dev:number;ino:number;uid:number}):Identity=>({dev:info.dev,ino:info.ino,uid:info.uid});
const same=(a:Identity,b:Identity)=>a.dev===b.dev&&a.ino===b.ino&&a.uid===b.uid;
async function exists(path:string){try{return await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}}
const queues=new WeakMap<object,Promise<unknown>>();
export function openVaultInitialization(state:StateContext){
 const git=new GitClient(),repositories=openRepositories({state,git});
 const serial=<T>(fn:()=>Promise<T>)=>{const result=(queues.get(state.store)??Promise.resolve()).then(fn);queues.set(state.store,result.catch(()=>{}));return result;};
 const intent=()=>state.store.read<Intent>('vault-initialization','current');
 async function view():Promise<StartupView>{
  const current=await intent(),config=await readConfig(state.stateDir);if(config&&config.instanceId!==state.instanceId)throw new AppError('INVALID_CONFIG','Vault binding identity changed');
  let phase:StartupView['phase']=current&&(current.phase!=='ready'||current.diagnostic!==undefined)?'initializing':config?'ready':'vault_required';let diagnostic=current?.diagnostic;
  if(state.store.repositoryFormat()!==2||(await state.store.list<{state:string}>('repository-migration')).some(m=>m.state!=='completed')||current?.diagnosticCode==='MIGRATION_REQUIRED'){phase='migration_required';diagnostic??='Stop this instance and run lorecrew repository migrate --inspect. Existing data and execution evidence are preserved.';}
  if(config&&!current&&phase==='ready'){const inspected=await repositories.inspect(config.vaultDir);if(inspected.kind!=='git'||!await readVaultIdentity(config.vaultDir).catch(()=>undefined)){phase='migration_required';diagnostic='This bound legacy vault needs an explicit stopped Git/identity conversion. Run lorecrew repository migrate --inspect.';}}
  return {instanceId:state.instanceId,phase,revision:stableId(state.instanceId,config?.vaultDir??'',current?.id??'',current?.phase??'',phase),defaultVaultDir:'',...(current?{vaultDir:current.path}:config?{vaultDir:config.vaultDir}:{}),...(diagnostic?{diagnostic}:{})};
 }
 async function placement(choice:AcceptedChoice):Promise<Placement>{
  if(choice.kind==='default')throw new AppError('CHOOSE_VAULT_FOLDER','Choose a folder on the instance host. Refresh an older cached client; there is no default vault.');
  let path:string;if(choice.kind==='existing'){if(!isAbsolute(choice.path))throw new AppError('INVALID_VAULT_DIR','Use an absolute folder path on the instance host');path=choice.path;}
  else if(choice.kind==='new'||choice.kind==='clone'){if(!isAbsolute(choice.parentPath)||!choice.folderName.trim()||choice.folderName!==choice.folderName.trim()||choice.folderName.length>255||/[\\/\0]/.test(choice.folderName)||['.','..'].includes(choice.folderName))throw new AppError('INVALID_VAULT_DIR','Choose an existing absolute parent and one ordinary folder name');if(choice.kind==='clone')validateRemote(choice.url);path=join(choice.parentPath,choice.folderName);}
  else throw new AppError('INVALID_REQUEST','Choose an existing folder, create a vault, or clone a vault');
  const raw=await exists(path);if(choice.kind==='existing'&&!raw)throw new AppError('INVALID_VAULT_DIR','The selected existing vault directory is missing');if(choice.kind==='new'&&raw)throw new AppError('VAULT_PATH_EXISTS','A folder already exists; review it as an existing vault');if(raw&&(!raw.isDirectory()||raw.isSymbolicLink()))throw new AppError('INVALID_VAULT_DIR','Select a real directory, not a symlink or special file');
  const parent=await realpath(dirname(path)),parentInfo=await lstat(parent);path=join(parent,basename(path));await validateStatePlacement({stateDir:state.stateDir,vaultDir:path}).catch(e=>{if(e instanceof AppError)throw new AppError('INVALID_VAULT_DIR',e.message);throw e;});if(within(state.stateDir,path)||within(path,state.stateDir))throw new AppError('INVALID_VAULT_DIR','Vault and private state must be separate');for(const binding of await state.store.list<{path:string}>('project-binding'))if(within(binding.path,path)||within(path,binding.path))throw new AppError('INVALID_VAULT_DIR','Vault selection cannot overlap a registered project');
  const inspected=await repositories.inspect(path);if(inspected.kind==='invalid_git')throw new AppError('INVALID_VAULT_DIR','Select an actual Git root; malformed, nested, detached or bare metadata requires repair');
  if(choice.kind==='clone'){if(raw&&(await readdir(path)).length)throw new AppError('VAULT_PATH_EXISTS','Clone needs a new or explicitly empty destination');}
  else if(inspected.kind==='plain')throw new AppError('MIGRATION_REQUIRED','Existing non-Git content is preserved. Use the explicit stopped repository migration.');
  else if(inspected.kind==='git'&&inspected.snapshot?.head){await readVaultIdentity(path).catch(()=>{throw new AppError('NOT_A_VAULT','This Git repository has no recognized vault identity; its content was preserved');});}
  if(!raw&&(await git.run(parent,['rev-parse','--show-toplevel'])).exitCode===0)throw new AppError('INVALID_VAULT_DIR','Create the vault outside another Git repository');
  const target=await exists(path);return {path,parent,parentIdentity:identity(parentInfo),kind:target?'existing':'new',...(target?{targetIdentity:identity(target)}:{}),...(inspected.snapshot?{repositoryRevision:inputHash(inspected.snapshot)}:{})};
 }
 async function preview(choice:AcceptedChoice):Promise<VaultPreview>{const current=await view(),target=await placement(choice);return {path:target.path,kind:target.kind,revision:current.revision,token:stableId(state.instanceId,JSON.stringify(choice),JSON.stringify(target),current.revision)};}
 const persist=(value:Intent)=>state.store.transact(tx=>tx.put('vault-initialization','current',value));
 async function revalidate(current:Intent){const config=await readConfig(state.stateDir);if(config&&config.vaultDir!==current.path||['bound','scaffold','ready'].includes(current.phase)&&!config)throw new AppError('INVALID_CONFIG','The committed vault binding differs from its saved initialization intent; restore the original binding');if(await realpath(current.parent)!==current.parent||!same(identity(await lstat(current.parent)),current.parentIdentity))throw new AppError('VAULT_FOLDER_CHANGED','The selected parent directory changed');const target=await exists(current.path),expected=current.directory??current.targetIdentity;if(expected&&(!target?.isDirectory()||target.isSymbolicLink()||!same(identity(target),expected)||await realpath(current.path)!==current.path))throw new AppError('VAULT_FOLDER_CHANGED','The selected vault directory changed; existing bytes were preserved');await validateStatePlacement({stateDir:state.stateDir,vaultDir:current.path});}
 async function validateBound(path:string){if((await repositories.inspect(path)).kind!=='git')throw new AppError('MIGRATION_REQUIRED','This bound vault requires stopped Git conversion');return readVaultIdentity(path).catch(()=>{throw new AppError('MIGRATION_REQUIRED','This bound vault requires stopped identity adoption');});}
 async function finish(current:Intent):Promise<StartupView>{try{
  await revalidate(current);if(current.phase==='ready'){const actual=await validateBound(current.path);if(current.identity&&inputHash(actual)!==inputHash(current.identity))throw new AppError('VAULT_FOLDER_CHANGED','The selected vault identity changed');delete current.diagnostic;delete current.diagnosticCode;await persist(current);return view();}
  if(current.phase==='reserved'){
   if(current.choice.kind==='clone'&&!current.cloneCompleted){await repositories.clone({repo:{kind:'vault',id:current.id,path:current.path},url:current.choice.url,parentPath:current.parent,folderName:basename(current.path)},current.requestId+':clone');current.cloneCompleted=true;current.directory=identity(await lstat(current.path));await persist(current);}
   const inspected=await repositories.inspect(current.path);
   if(current.starter===true&&current.identity||inspected.kind==='empty'||inspected.kind==='git'&&inspected.snapshot?.head===null){
    current.identity??=await planVaultIdentity(state,current.path,current.requestId+':identity');current.starter=true;await persist(current);
    await repositories.create({repo:{kind:'vault',id:current.identity.vaultId,path:current.path},parentPath:current.parent,folderName:basename(current.path),scaffold:[{path:'index.md',content:INITIAL_VAULT_INDEX},{path:'.lorecrew/vault.json',content:JSON.stringify(current.identity)+'\n'}]},current.requestId+':create');
   }else{current.identity=await validateBound(current.path);current.starter??=false;}
   current.directory=identity(await lstat(current.path));current.phase='folder';await persist(current);
  }
  await revalidate(current);await validateBound(current.path);const ctx=await attachVault(state,current.path);
  if(current.phase==='folder'){await state.store.transact(tx=>{const old=tx.get<{path:string}>('setup-entry','current');if(old&&old.path!==current.path)throw new AppError('VAULT_MISMATCH','Setup provenance belongs to another vault');if(!old)tx.put('setup-entry','current',{path:current.path,starterRequired:current.starter===true,completed:false,kind:current.starter?'new':'existing_incomplete'});});current.phase='bound';await persist(current);}
  if(current.phase==='bound'){await openSetupEntry({ctx,vault:openVault(ctx)}).read(false);current.phase='scaffold';await persist(current);}
  current.phase='ready';delete current.diagnostic;delete current.diagnosticCode;await persist(current);return view();
 }catch(error){current.diagnostic=error instanceof AppError?error.message:'Vault initialization was interrupted; the original destination and receipts were retained';current.diagnosticCode=error instanceof AppError?error.code:'INITIALIZATION_INTERRUPTED';await persist(current);throw error;}}
 async function confirm(input:{choice:AcceptedChoice;previewToken:string;expectedRevision:string},requestId:string):Promise<StartupView>{return serial(async()=>{if(!requestId.trim())throw new AppError('INVALID_REQUEST','A stable request ID is required');const current=await intent();if(current?.requestId===requestId){if(!isDeepStrictEqual(current.choice,input.choice)||current.previewToken!==input.previewToken||current.expectedRevision!==input.expectedRevision)throw new AppError('REQUEST_CONFLICT','This request ID names different vault choices');return finish(current);}const currentView=await view();if(currentView.revision!==input.expectedRevision||currentView.phase!=='vault_required')throw new AppError('REVISION_CONFLICT','Another tab selected a vault; reload saved startup status');let target:Placement;try{target=await placement(input.choice);}catch(e){if(e instanceof AppError&&e.code==='VAULT_PATH_EXISTS')throw new AppError('REVISION_CONFLICT','A target appeared after preview; review it explicitly');throw e;}if(stableId(state.instanceId,JSON.stringify(input.choice),JSON.stringify(target),currentView.revision)!==input.previewToken)throw new AppError('REVISION_CONFLICT','The selected directory changed since preview');const next:Intent={...target,...input,id:randomUUID(),requestId,phase:'reserved'};await persist(next);return finish(next);});}
 async function reconcile():Promise<StartupView>{return serial(async()=>{if(state.store.repositoryFormat()!==2)return view();const current=await intent();if(!current)return view();try{return await finish(current);}catch{return view();}});}
 return {view,preview,confirm,reconcile};
}
