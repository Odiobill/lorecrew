import {observeProjectCatalog} from '../projects/catalog-observation.js';
import {withProjectEntry,assertProjectEntryAvailable} from '../projects/entry-coordination.js';
import {openProjectWorkflows} from '../projects/workflows.js';
import {assertSetupCreationReservation,assertSetupReservation} from './service.js';
import type {ProjectSelection} from '../projects/workflow-types.js';
import {basename,join,dirname} from 'node:path';
import {lstat,realpath} from 'node:fs/promises';
import type {InstanceContext} from '../instance/open.js';
import type {GitClient} from '../git/client.js';
import type {Ownership,Assignment} from '../projects/types.js';
import type {ProjectBinding} from '../workspaces/types.js';
import {AppError} from '../contracts/base.js';
import {assertRestoredExecutionAllowed} from '../instance/recovery.js';
import {canonicalRepositoryKey} from '../projects/registry.js';
import {openSetupProjects} from './projects.js';
import {openSetupOwnership} from './ownership.js';
import {directory,pathExists,projectPathAllowed} from './folders.js';
import {openRepositories} from '../repositories/service.js';
import {inputHash} from '../repositories/inspect.js';
import {readVaultIdentity} from '../repositories/identity.js';
import {ensureLocalAuthority} from '../projects/authority-domain.js';
import {openProjectCatalog} from '../projects/catalog.js';
import {openVault} from '../vault/write.js';
import {validateRemote} from '../repositories/create.js';
import type {RepositoryRef} from '../repositories/types.js';
import type {ProjectPreview,ProjectWorkflowInput,ProjectWorkflowPending,ProjectWorkflowResult,ProjectSetupOptions} from './types.js';
interface RootIdentity {dev:number;ino:number;uid:number}
interface Intent {projectId:string;title:string;path:string;mode:ProjectWorkflowInput['mode'];input:ProjectWorkflowInput;requestId:string;phase:ProjectWorkflowPending['phase'];repositoryKey:string;kind:'git';root?:RootIdentity;commonDir?:string;result?:ProjectWorkflowResult;diagnostic?:string}
const logicalKey=(ctx:InstanceContext,id:string)=>`fork:local/${ctx.instanceId}/${id}`;
function id(value:string){if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value))throw new AppError('INVALID_PROJECT','Invalid project identity');}
function folderName(value:string){if(typeof value!=='string'||value!==value.trim()||!value||value.length>80||/[\\/:\0-\x1f<>"|?*]/.test(value)||value.startsWith('.')||value.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))throw new AppError('INVALID_REQUEST','Use one ordinary folder name');return value;}
export function openProjectWorkflow(options:{ctx:InstanceContext;git:GitClient;ownership:Ownership}){
 const {ctx,git}=options,repositories=openRepositories({state:ctx,git}),projects=openSetupProjects({...options,strictPath:true}),catalog=openProjectCatalog({ctx,vault:openVault(ctx),repositories});
 const serial=<T>(fn:()=>Promise<T>):Promise<T>=>withProjectEntry(ctx.store,fn);
 const persist=(intent:Intent)=>ctx.store.transact(tx=>tx.put('setup-project-workflow',intent.projectId,intent));
 async function inspected(path:string){if(!projectPathAllowed(ctx,path))throw new AppError('INVALID_PROJECT_PATH','Projects must be separate from the vault and private operational state');const view=await repositories.inspect(path);if(view.kind!=='git'||!view.snapshot?.head||!view.snapshot.branch)throw new AppError('INVALID_GIT_PROJECT','Select an actual Git repository root with a usable initial commit; plain projects require stopped conversion');if(view.snapshot.busy)throw new AppError('REPOSITORY_BUSY','Resolve the native Git operation before connecting');const vault=await repositories.inspect(ctx.vaultDir);if(vault.snapshot?.commonDir===view.snapshot.commonDir)throw new AppError('INVALID_PROJECT_PATH','The vault cannot also be a project');return view as typeof view&{snapshot:NonNullable<typeof view.snapshot>};}
 async function preview(input:{projectId:string;path:string;repositoryKey?:string}):Promise<ProjectPreview>{id(input.projectId);const view=await inspected(input.path);const remote=(await projects.inspectProject({path:view.path})).suggestedRepositoryKey;const repositoryKey=input.repositoryKey?canonicalRepositoryKey(input.repositoryKey):remote??logicalKey(ctx,input.projectId);return {path:view.path,kind:'git',repositoryKey,title:basename(view.path)||'Project',token:inputHash({path:view.path,snapshot:view.snapshot,repositoryKey})};}
 async function bound(path:string){const view=await inspected(path);for(const binding of await ctx.store.list<ProjectBinding>('project-binding')){const other=await repositories.inspect(binding.path);if(other.snapshot?.commonDir!==view.snapshot.commonDir)continue;const state=await projects.readiness(binding.projectId);if(state==='unavailable')throw new AppError('NOT_OWNER','This repository has an unavailable or fenced saved owner');const grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',binding.projectId);const meta=await ctx.store.read<{title:string}>('project-metadata',binding.projectId);return {projectId:binding.projectId,title:meta?.title??binding.projectId,path:binding.path,repositoryKey:grant!.assignment.repositoryKey,kind:'git' as const,state:state==='ready'?'ready' as const:'claimed_unbound' as const,reused:true};}return undefined;}
 async function finish(intent:Intent):Promise<ProjectWorkflowResult>{await assertRestoredExecutionAllowed(ctx);try{
  await assertProjectEntryAvailable(ctx,{family:'legacy',operationId:intent.requestId,projectId:intent.projectId,path:intent.path,repositoryKey:intent.repositoryKey,...intent.commonDir?{commonDir:intent.commonDir}:{}});
  // Authority is confirmed before any destination write, including a foreign clone's new IDs.
  await ensureLocalAuthority(ctx,await readVaultIdentity(ctx.vaultDir),intent.requestId+':authority');
  const repo:RepositoryRef={kind:'project',id:intent.projectId,path:intent.path};
  if(intent.phase==='planned'&&intent.mode!=='existing'){
   const input=intent.input;if(input.mode==='new')await repositories.create({repo,parentPath:dirname(intent.path),folderName:basename(intent.path),scaffold:[{path:'README.md',content:'# '+intent.title+'\n'}]},intent.requestId+':create');
   else if(input.mode==='clone'){await repositories.clone({repo,url:input.url,parentPath:dirname(intent.path),folderName:basename(intent.path)},intent.requestId+':clone');const view=await repositories.inspect(intent.path);if(view.snapshot?.head===null)await repositories.create({repo,parentPath:dirname(intent.path),folderName:basename(intent.path),scaffold:[{path:'README.md',content:'# '+intent.title+'\n'}]},intent.requestId+':empty');}
  }
  const view=await inspected(intent.path),info=await lstat(intent.path),root={dev:info.dev,ino:info.ino,uid:info.uid};
  if(intent.root&&inputHash(intent.root)!==inputHash(root)||intent.commonDir&&intent.commonDir!==view.snapshot.commonDir)throw new AppError('PROJECT_FOLDER_CHANGED','The original repository target changed; preserve and restore it before retrying');
  intent.root??=root;intent.commonDir??=view.snapshot.commonDir;
  for(const other of await ctx.store.list<Intent>('setup-project-workflow'))if(other.projectId!==intent.projectId&&(other.path===intent.path||other.commonDir===intent.commonDir)&&other.result?.state!=='ready')throw new AppError('PROJECT_PATH_CONFLICT','This repository already has a pending connection; resume its saved identity');
  const existing=await bound(intent.path);if(existing&&existing.projectId!==intent.projectId){intent.result=existing;intent.phase='connected';await persist(intent);return existing;}
  if(intent.phase==='planned'||intent.phase==='folder'){intent.phase='connecting';await persist(intent);}
  const portable=await catalog.register({projectId:intent.projectId,title:intent.title,repositoryAliases:[intent.repositoryKey]},intent.requestId+':catalog');if(portable.projectId!==intent.projectId)throw new AppError('PROJECT_LINK_REQUIRED','This repository alias already belongs to another project; explicitly link its checkout');
  const result=await projects.connectProject({projectId:intent.projectId,title:intent.title,path:intent.path,repositoryKey:intent.repositoryKey},intent.requestId);
  intent.result={...result,title:intent.title,path:intent.path,repositoryKey:intent.repositoryKey,kind:'git'};intent.phase='connected';delete intent.diagnostic;await persist(intent);return intent.result;
 }catch(error){intent.diagnostic=error instanceof AppError?error.message:'Connection interrupted; original repository and saved evidence retained';await persist(intent);throw error;}}
 async function connect(input:ProjectWorkflowInput,requestId:string):Promise<ProjectWorkflowResult>{return serial(async()=>{await assertRestoredExecutionAllowed(ctx);id(input.projectId);if(!input.title?.trim()||input.title.length>1000)throw new AppError('INVALID_REQUEST','Enter a project title');
  const prior=await ctx.store.read<Intent>('setup-project-workflow',input.projectId);if(prior){if(inputHash(prior.input)!==inputHash(input))throw new AppError('REQUEST_CONFLICT','Resume the saved original project choices');return finish(prior);}
  let path:string,repositoryKey:string,root:RootIdentity|undefined,commonDir:string|undefined;
  if(input.mode==='existing'){const p=await preview({projectId:input.projectId,path:input.path,repositoryKey:input.repositoryKey});if(p.token!==input.previewToken)throw new AppError('REVISION_CONFLICT','Review the changed repository before connecting');await assertProjectEntryAvailable(ctx,{family:'legacy',operationId:requestId,projectId:input.projectId,path:p.path,repositoryKey:p.repositoryKey,commonDir:(await inspected(p.path)).snapshot.commonDir});const existing=await bound(p.path);if(existing)return existing;path=p.path;repositoryKey=p.repositoryKey;const info=await lstat(path);root={dev:info.dev,ino:info.ino,uid:info.uid};commonDir=(await inspected(path)).snapshot.commonDir;
  }else if(input.mode==='new'||input.mode==='clone'){const parent=await directory(input.parentPath);path=join(parent,folderName(input.folderName));if(!projectPathAllowed(ctx,path))throw new AppError('INVALID_PROJECT_PATH','The new project overlaps operational state');if(await pathExists(path))throw new AppError('PROJECT_PATH_EXISTS','Choose the existing repository explicitly or use a different name');if(input.mode==='clone'){validateRemote(input.url);try{repositoryKey=canonicalRepositoryKey(input.url);}catch{repositoryKey='fork:clone/'+inputHash(input.url);}}else repositoryKey=logicalKey(ctx,input.projectId);
  }else throw new AppError('INVALID_REQUEST','Choose open, create or clone Git project');
  await assertProjectEntryAvailable(ctx,{family:'legacy',operationId:requestId,projectId:input.projectId,path,repositoryKey,...commonDir?{commonDir}:{}});
  const linked=(await catalog.list()).find(record=>record.projectId!==input.projectId&&record.repositoryAliases.includes(repositoryKey));if(linked)throw new AppError('PROJECT_LINK_REQUIRED','This repository is already registered; reuse its saved project identity or explicitly repair its checkout linkage',{projectId:linked.projectId});
  for(const saved of await ctx.store.list<Intent>('setup-project-workflow'))if(saved.projectId!==input.projectId&&(saved.path===path||commonDir&&saved.commonDir===commonDir)&&saved.result?.state!=='ready')throw new AppError('PROJECT_PATH_CONFLICT','Resume the existing repository connection before creating another identity');
  const intent:Intent={projectId:input.projectId,title:input.title.trim(),path,repositoryKey,kind:'git',mode:input.mode,input,requestId,phase:'planned',...root?{root}:{},...commonDir?{commonDir}:{}};await persist(intent);await ctx.store.transact(tx=>tx.put('project-metadata',intent.projectId,{title:intent.title}));return finish(intent);
 });}
 const resume=(projectId:string,_input:{useExisting?:boolean}={})=>serial(async()=>{const intent=await ctx.store.read<Intent>('setup-project-workflow',projectId);if(!intent)throw new AppError('NOT_FOUND','Saved connection not found');return finish(intent);});
 async function setupOptions():Promise<ProjectSetupOptions>{const portable=(await observeProjectCatalog(ctx.vaultDir)).entries;const items:ProjectSetupOptions['projects']=[],pending:ProjectSetupOptions['pending']=[];for(const grant of await ctx.store.list<{assignment:Assignment}>('assignment-grants'))if(grant.assignment.ownerId===ctx.instanceId){const projectId=grant.assignment.projectId,binding=await ctx.store.read<ProjectBinding>('project-binding',projectId),meta=await ctx.store.read<{title:string}>('project-metadata',projectId);items.push({projectId,title:portable.find(p=>p.projectId===projectId)?.title??meta?.title??projectId,...binding?{path:binding.path}:{},repositoryKey:grant.assignment.repositoryKey,state:await projects.readiness(projectId) as 'ready'|'claimed_unbound'|'unavailable'});}for(const intent of await ctx.store.list<Intent>('setup-project-workflow')){if(intent.result?.state==='ready'&&await projects.readiness(intent.result.projectId)==='ready')continue;pending.push({projectId:intent.projectId,title:intent.title,path:intent.path,mode:intent.mode,phase:intent.phase,canAdoptExisting:false,...intent.diagnostic?{diagnostic:intent.diagnostic}:{}});}return {ownership:await openSetupOwnership(options).read(),defaultPath:dirname(ctx.vaultDir),projects:items,pending};}
 const general=openProjectWorkflows(options);
 // Existing setup journals retain their original implementation and native IDs.
 // New shared UI entries use the same service as Projects, behind setup fences.
 const entry={...general,async confirm(input:{selection:ProjectSelection;expectedPreviewRevision:string},operationId:string){await assertSetupCreationReservation(ctx,'project',operationId,input.selection.mode==='catalog-clone'?'setup-project-'+operationId:input.selection.projectId);return general.confirm(input,operationId);},async resume(operationId:string,requestKey:string){const saved=await general.operation(operationId);await assertSetupReservation(ctx,['project'],requestKey,saved.projectId);return general.resume(operationId);}};
 return {preview,connect,resume,options:setupOptions,entry};
}
