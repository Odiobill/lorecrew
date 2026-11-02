import {withProjectEntry,assertProjectEntryAvailable} from './entry-coordination.js';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {lstat,open,realpath} from 'node:fs/promises';
import type {InstanceContext} from '../instance/open.js';
import type {GitClient} from '../git/client.js';
import type {Ownership,Assignment} from './types.js';
import type {ProjectBinding} from '../workspaces/types.js';
import type {CheckoutAssociation} from './checkout-types.js';
import type {ProjectFlowOperation,ProjectFlowPreview,ProjectSelection} from './workflow-types.js';
import type {RepositorySnapshot} from '../repositories/types.js';
import {AppError} from '../contracts/base.js';
import {assertRestoredExecutionAllowed} from '../instance/recovery.js';
import {directory,pathExists,projectPathAllowed} from '../setup/folders.js';
import {openRepositories} from '../repositories/service.js';
import {inspectRepository,inputHash} from '../repositories/inspect.js';
import {safeRepositoryPath} from '../repositories/checkpoint.js';
import {assertRepositoryChildrenStopped} from '../repositories/git.js';
import {readVaultIdentity,type OriginJournal} from '../repositories/identity.js';
import {readAuthorityMarker} from '../repositories/authority-marker.js';
import {assertAuthorityDomain,ensureLocalAuthority,authorityScope,type AuthorityScope} from './authority-domain.js';
import {observeProjectCatalog,observeProjectCatalogExcluding,type CatalogObservation} from './catalog-observation.js';
import {openProjectCatalog,type ProjectCatalogEntry} from './catalog.js';
import {openVault} from '../vault/write.js';
import {reviewProjectSource,projectSourceAlias} from './clone-sources.js';
import {openProjectCheckouts} from './checkouts.js';
import {requestId as assertRequestId,stableId} from '../runtime/admission.js';
type Root={dev:number;ino:number;uid:number};
type Analysis={preview:ProjectFlowPreview;repositoryKey:string;root?:Root;snapshot?:RepositorySnapshot;parent?:{path:string;root:Root};authorityToken?:string};
interface Intent {version:1;operationId:string;selectionHash:string;preview:ProjectFlowPreview;analysis:Analysis;vaultDir:string;vaultId:string;phase:Exclude<ProjectFlowOperation['phase'],'blocked'>;catalogExpectedRevision:string;catalogExceptRevision:string;catalogStarted?:true;catalogReceipt?:ProjectCatalogEntry;claimReceipt?:Assignment;scope?:AuthorityScope;repositoryRoot?:Root;repositoryCommonDir?:string;associationInput?:{association:Omit<CheckoutAssociation,'operationId'|'revision'>;expectedRevision:string|null};associationReceipt?:CheckoutAssociation;bindingStarted?:true;result?:ProjectFlowOperation['result'];diagnostic?:ProjectFlowOperation['diagnostic']}
const rootOf=(info:{dev:number;ino:number;uid:number}):Root=>({dev:info.dev,ino:info.ino,uid:info.uid});
function validId(id:string){if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(id))throw new AppError('INVALID_PROJECT','Use a safe project identity.');}
function folderName(value:string){if(typeof value!=='string'||value!==value.trim()||!value||value.length>80||/[\/\\:\0-\x1f<>"|?*]/.test(value)||value.startsWith('.')||value.endsWith('.')||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))throw new AppError('INVALID_REQUEST','Use one ordinary folder name.');return value;}
function selectionOf(input:ProjectSelection):ProjectSelection {
 validId(input.projectId);
 if(input.mode==='new'||input.mode==='existing'){if(typeof input.title!=='string'||!input.title.trim()||input.title.length>1000)throw new AppError('INVALID_REQUEST','Enter a project title.');}
 if(input.mode==='new')return {mode:'new',projectId:input.projectId,title:input.title.trim(),parentPath:input.parentPath,folderName:folderName(input.folderName)};
 if(input.mode==='existing'){if(input.catalogProjectId)validId(input.catalogProjectId);return {mode:'existing',projectId:input.projectId,title:input.title.trim(),path:input.path,...input.catalogProjectId?{catalogProjectId:input.catalogProjectId}:{},...input.acknowledgeOpaque?{acknowledgeOpaque:true}:{}};}
 if(input.mode==='catalog-clone')return {mode:input.mode,projectId:input.projectId,url:input.url,parentPath:input.parentPath,folderName:folderName(input.folderName),...input.acknowledgeOpaque?{acknowledgeOpaque:true}:{}};
 throw new AppError('INVALID_REQUEST','Choose create, add existing repository or clone from vault.');
}
export function openProjectWorkflows({ctx,git,ownership}:{ctx:InstanceContext;git:GitClient;ownership:Ownership}){
 const repositories=openRepositories({state:ctx,git}),catalog=openProjectCatalog({ctx,vault:openVault(ctx),repositories}),checkouts=openProjectCheckouts({ctx,git,ownership});
 const serial=<T>(work:()=>Promise<T>):Promise<T>=>withProjectEntry(ctx.store,work);
 const persist=(intent:Intent)=>ctx.store.transact(tx=>{tx.put('project-flow',intent.operationId,intent);tx.emit('project.workflow_changed',{projectId:intent.preview.projectId,operationId:intent.operationId});});
 const project=(intent:Intent):ProjectFlowOperation=>({operationId:intent.operationId,projectId:intent.preview.projectId,phase:intent.diagnostic?'blocked':intent.phase,...intent.result?{result:intent.result}:{},...intent.diagnostic?{diagnostic:intent.diagnostic}:{}});
 async function root(path:string){if(await realpath(path)!==path||!projectPathAllowed(ctx,path))throw new AppError('INVALID_PROJECT_PATH','Select a separate canonical Git root.');const view=await inspectRepository(git,path);if(view.kind!=='git'||!view.snapshot?.head||!view.snapshot.branch)throw new AppError('INVALID_GIT_PROJECT','Select a Git repository root with a usable initial commit.');if(view.snapshot.busy)throw new AppError('REPOSITORY_BUSY','Resolve the native Git operation before continuing.');return {path,root:rootOf(await lstat(path)),snapshot:view.snapshot};}
 async function eligibility(){
  const identity=await readVaultIdentity(ctx.vaultDir),binding=await ctx.store.read<{mode:string;epoch:number;domainId:string}>('authority-binding','current'),bootstrap=await ctx.store.read<{state:string}>('authority-bootstrap','current');
  if(binding&&(binding.mode==='shared'||bootstrap?.state==='ready'))return inputHash(await assertAuthorityDomain(ctx));
  const origin=await ctx.store.read<OriginJournal>('vault-origin',identity.vaultId);
  if(identity.originInstanceId!==ctx.instanceId||!origin||origin.path!==ctx.vaultDir||inputHash(origin.identity)!==inputHash(identity))throw new AppError('AUTHORITY_NOT_LOCAL','This vault clone can associate recorded projects, but cannot create new execution authority.');
  const history=await git.run(ctx.vaultDir,['--no-optional-locks','-c','core.hooksPath=/dev/null','log','--all','--max-count=1','--format=%H','--','.lorecrew/authority.json']);
  if(await readAuthorityMarker(ctx.vaultDir)||history.exitCode||history.stdout.trim())throw new AppError('AUTHORITY_RETIRED','Restore the confirmed current authority before registering another project.');
  return inputHash({identity,binding:binding??null,bootstrap:bootstrap??null});
 }
 async function aliases(path:string){const result=await git.run(path,['config','--get-regexp','^remote\\..*\\.url$']);const values=new Set<string>();if(result.exitCode!==0&&result.exitCode!==1)throw new AppError('INVALID_GIT_PROJECT','Repository remotes could not be inspected.');for(const line of result.stdout.split('\n')){let url=line.replace(/^\S+\s+/,'').trim();if(!url)continue;try{const parsed=new URL(url);parsed.username='';parsed.password='';parsed.search='';parsed.hash='';url=parsed.href;}catch{/* scp syntax stays local to canonicalization */}const alias=projectSourceAlias(url);if(alias)values.add(alias);}return [...values].sort();}
 async function analyze(selection:ProjectSelection,operationId:string):Promise<Analysis>{
  const observed=await observeProjectCatalog(ctx.vaultDir);let projectId=selection.projectId,title='',path='',registration:'new'|'recorded'='new',identity:ProjectFlowPreview['identity']={kind:'new'},repositoryKey='',placement:Pick<Analysis,'root'|'snapshot'|'parent'>={};
  if(selection.mode==='new'||selection.mode==='catalog-clone'){
   if(selection.mode==='new'&&observed.entries.some(e=>e.projectId===projectId))throw new AppError('PROJECT_CONFLICT','This identity already names a recorded project.');
   const parent=await directory(selection.parentPath);path=join(parent,selection.folderName);if(!projectPathAllowed(ctx,path))throw new AppError('INVALID_PROJECT_PATH','The destination overlaps operational state.');if(await pathExists(path))throw new AppError('PROJECT_PATH_EXISTS','Choose an empty new destination or add the existing repository explicitly.');if((await git.run(parent,['rev-parse','--show-toplevel'])).exitCode===0)throw new AppError('INVALID_DESTINATION','Create the repository outside another Git repository.');
   if(selection.mode==='new'){title=selection.title;repositoryKey=`fork:local/${ctx.instanceId}/${projectId}`;}else{const entry=observed.entries.find(e=>e.projectId===projectId);if(!entry)throw new AppError('PROJECT_CATALOG_REPAIR','Select a valid recorded project.');const source=reviewProjectSource(entry,selection.url,!!selection.acknowledgeOpaque);title=entry.title;registration='recorded';repositoryKey=source.alias??entry.repositoryAliases[0]??`fork:local/${ctx.instanceId}/${projectId}`;identity=source.alias?{kind:'alias',alias:source.alias}:{kind:'operator_assertion'};}placement.parent={path:parent,root:rootOf(await lstat(parent))};
  }else{
   const inspected=await root(selection.path);path=inspected.path;placement={root:inspected.root,snapshot:inspected.snapshot};const knownAliases=await aliases(path),matches=new Set(observed.entries.filter(e=>e.repositoryAliases.some(a=>knownAliases.includes(a))).map(e=>e.projectId));
   for(const a of await ctx.store.list<CheckoutAssociation>('project-checkout'))if(a.commonDir===inspected.snapshot.commonDir)matches.add(a.projectId);
   for(const b of await ctx.store.list<ProjectBinding>('project-binding'))if((b.commonDir??(await inspectRepository(git,b.path)).snapshot?.commonDir)===inspected.snapshot.commonDir)matches.add(b.projectId);
   if(matches.size>1)throw new AppError('AMBIGUOUS_REPOSITORY','Repository evidence names multiple projects; repair the ambiguity first.');
   const inferred=[...matches][0];if(selection.catalogProjectId&&inferred&&selection.catalogProjectId!==inferred)throw new AppError('PROJECT_SOURCE_MISMATCH','The existing repository belongs to a different recorded project.');
   const selected=selection.catalogProjectId??inferred,entry=observed.entries.find(e=>e.projectId===selected);
   if(selected&&!entry)throw new AppError('PROJECT_CATALOG_REPAIR','The saved repository identity has no valid portable record.');
   if(entry){
    if(knownAliases.some(a=>!entry.repositoryAliases.includes(a)))throw new AppError('PROJECT_SOURCE_MISMATCH','A recognized repository source differs from this project.');
    const matched=knownAliases.find(a=>entry.repositoryAliases.includes(a));if(!matched&&!inferred&&!selection.acknowledgeOpaque)throw new AppError('OPAQUE_SOURCE_ACK_REQUIRED','Confirm that this opaque repository belongs to the selected recorded project.');
    projectId=entry.projectId;title=entry.title;registration='recorded';repositoryKey=matched??entry.repositoryAliases[0]??`fork:local/${ctx.instanceId}/${projectId}`;identity=matched?{kind:'alias',alias:matched}:{kind:'operator_assertion'};
   }else{if(observed.entries.some(e=>e.projectId===projectId))throw new AppError('PROJECT_CONFLICT','Select the existing project explicitly rather than replacing its identity.');title=selection.title;if(knownAliases.length>1)throw new AppError('AMBIGUOUS_REPOSITORY','Review multiple recognized repository aliases explicitly.');repositoryKey=knownAliases[0]??`fork:local/${ctx.instanceId}/${projectId}`;identity={kind:'new'};}
  }
  await assertProjectEntryAvailable(ctx,{family:'general',operationId,projectId,path,repositoryKey,...placement.snapshot?{commonDir:placement.snapshot.commonDir}:{}});
  if(observed.blockedProjectIds.includes(projectId))throw new AppError('AMBIGUOUS_REPOSITORY','Repair this project catalog before changing its checkout.');
  const authorityToken=registration==='new'?await eligibility():undefined;if(registration==='new')await catalog.list();
  const checkout=await checkouts.observe(projectId),binding=await ctx.store.read<ProjectBinding>('project-binding',projectId);
  if(binding?.used&&binding.path!==path)throw new AppError('BINDING_IN_USE','The original used project checkout cannot move.');
  const fields={operationId,selection,projectId,title,registration,path,catalogRevision:observed.revision,checkoutRevision:checkout.revision,bindingRevision:binding?stableId(binding.projectId,binding.path):null,identity};
  const preview:ProjectFlowPreview={...fields,revision:inputHash({fields,placement,authorityToken})};
  for(const pending of await ctx.store.list<Intent>('project-flow'))if(pending.operationId!==operationId&&pending.vaultDir===ctx.vaultDir&&pending.phase!=='completed'&&(pending.preview.projectId===projectId||pending.preview.path===path||placement.snapshot?.commonDir&&(pending.repositoryCommonDir??pending.analysis.snapshot?.commonDir)===placement.snapshot.commonDir||pending.analysis.repositoryKey===repositoryKey))throw new AppError('PROJECT_OPERATION_PENDING','Resume the original project operation before starting another entry for this identity or repository.');
  return {preview,repositoryKey,...placement,...authorityToken?{authorityToken}:{}};
 }
 async function preview(input:ProjectSelection,operationId:string):Promise<ProjectFlowPreview>{assertRequestId(operationId);const selection=selectionOf(input),saved=await ctx.store.read<Intent>('project-flow',operationId);if(saved){if(saved.selectionHash!==inputHash(selection))throw new AppError('REQUEST_CONFLICT','This operation already names different frozen choices.');return saved.preview;}return (await analyze(selection,operationId)).preview;}
 async function catalogCurrent(intent:Intent):Promise<CatalogObservation>{
  const observed=await observeProjectCatalog(ctx.vaultDir);if(observed.revision===intent.catalogExpectedRevision)return observed;
  // A native catalog rename can precede its control receipt. Recognize only the
  // exact planned new record, with every other raw inventory condition unchanged.
  if(intent.catalogStarted&&intent.preview.registration==='new'&&!observed.blockedProjectIds.includes(intent.preview.projectId)){
   const expected=JSON.stringify({version:1,projectId:intent.preview.projectId,title:intent.preview.title,repositoryAliases:[intent.analysis.repositoryKey]})+'\n',length=Buffer.byteLength(expected);
   let same=false;try{const file=await open(await safeRepositoryPath(ctx.vaultDir,'.lorecrew/projects/'+intent.preview.projectId+'.json'),constants.O_RDONLY|(constants.O_NOFOLLOW??0));try{const info=await file.stat();if(info.isFile()&&info.size===length){const buffer=Buffer.alloc(length+1),read=await file.read(buffer,0,buffer.length,0);same=read.bytesRead===length&&buffer.subarray(0,length).toString('utf8')===expected;}}finally{await file.close();}}catch{/* Missing or substituted own record is never accepted. */}
   if(same&&(await observeProjectCatalogExcluding(ctx.vaultDir,intent.preview.projectId)).revision===intent.catalogExceptRevision){intent.catalogExpectedRevision=observed.revision;await persist(intent);return observed;}
  }
  throw new AppError('REVISION_CONFLICT','The reviewed project catalog changed. Preserve the original operation and review the change.');
 }
 async function scopeCurrent(intent:Intent){const binding=await assertAuthorityDomain(ctx),scope=authorityScope(binding);if(intent.scope&&inputHash(intent.scope)!==inputHash(scope))throw new AppError('AUTHORITY_RETIRED','The original operation authority was retired.');return scope;}
 async function finish(intent:Intent):Promise<ProjectFlowOperation>{
  if(intent.phase==='completed')return project(intent);
  try{
   await assertRestoredExecutionAllowed(ctx);if(ctx.vaultDir!==intent.vaultDir||(await readVaultIdentity(ctx.vaultDir)).vaultId!==intent.vaultId)throw new AppError('VAULT_CHANGED','Resume this operation only against its original vault.');
   await assertProjectEntryAvailable(ctx,{family:'general',operationId:intent.operationId,projectId:intent.preview.projectId,path:intent.preview.path,repositoryKey:intent.analysis.repositoryKey,...intent.repositoryCommonDir??intent.analysis.snapshot?.commonDir?{commonDir:intent.repositoryCommonDir??intent.analysis.snapshot!.commonDir}:{}});
   await catalogCurrent(intent);
   if(intent.preview.registration==='new'){
    await eligibility();await ensureLocalAuthority(ctx,await readVaultIdentity(ctx.vaultDir),intent.operationId+':authority');intent.scope=await scopeCurrent(intent);await persist(intent);
   }
   const selection=intent.preview.selection,projectId=intent.preview.projectId;
   if(intent.phase==='planned'){
    if(selection.mode==='new'||selection.mode==='catalog-clone'){
     const parent=intent.analysis.parent!;if(await realpath(selection.parentPath)!==parent.path||inputHash(rootOf(await lstat(parent.path)))!==inputHash(parent.root))throw new AppError('PROJECT_FOLDER_CHANGED','The original parent directory changed.');
     if(selection.mode==='catalog-clone')await repositories.clone({repo:{kind:'project',id:projectId,path:intent.preview.path},url:selection.url,parentPath:parent.path,folderName:selection.folderName},intent.operationId+':repository');
     else{await scopeCurrent(intent);await repositories.create({repo:{kind:'project',id:projectId,path:intent.preview.path},parentPath:parent.path,folderName:selection.folderName,scaffold:[{path:'README.md',content:'# '+intent.preview.title+'\n'}]},intent.operationId+':repository');}
    }
    const inspected=await root(intent.preview.path);if(intent.analysis.root&&(inputHash(inspected.root)!==inputHash(intent.analysis.root)||inputHash(inspected.snapshot)!==inputHash(intent.analysis.snapshot)))throw new AppError('REPOSITORY_CHANGED','The reviewed existing repository changed before association.');
    intent.repositoryRoot=inspected.root;intent.repositoryCommonDir=inspected.snapshot.commonDir;intent.phase='repository';delete intent.diagnostic;await persist(intent);
   }
   const inspected=await root(intent.preview.path);if(inputHash(inspected.root)!==inputHash(intent.repositoryRoot)||inspected.snapshot.commonDir!==intent.repositoryCommonDir)throw new AppError('PROJECT_FOLDER_CHANGED','The original repository target changed.');
   await assertRepositoryChildrenStopped(ctx);await catalogCurrent(intent);
   if(intent.phase==='repository'){
    if(intent.preview.registration==='new'){
     await scopeCurrent(intent);if(!intent.catalogReceipt){intent.catalogStarted=true;await persist(intent);intent.catalogReceipt=await catalog.register({projectId,title:intent.preview.title,repositoryAliases:[intent.analysis.repositoryKey]},intent.operationId+':catalog');if(intent.catalogReceipt.projectId!==projectId)throw new AppError('PROJECT_LINK_REQUIRED','The repository now names another project.');intent.catalogExpectedRevision=(await observeProjectCatalog(ctx.vaultDir)).revision;await persist(intent);}
     await scopeCurrent(intent);if(!intent.claimReceipt){intent.claimReceipt=await ownership.claim({id:projectId,title:intent.preview.title,repositoryKey:intent.analysis.repositoryKey},intent.operationId+':claim');await scopeCurrent(intent);await persist(intent);}
    }
    intent.phase='registered';delete intent.diagnostic;await persist(intent);
   }
   if(intent.phase==='registered'){
    await catalogCurrent(intent);if(!intent.associationInput){intent.associationInput={association:{projectId,path:intent.preview.path,commonDir:intent.repositoryCommonDir!,rootIdentity:intent.repositoryRoot!,evidence:intent.preview.identity.kind==='alias'?{kind:'alias',alias:intent.preview.identity.alias!,...selection.mode==='catalog-clone'?{source:selection.url}:{}}:{kind:'operator_assertion',source:selection.mode==='catalog-clone'?selection.url:intent.preview.path}},expectedRevision:intent.preview.checkoutRevision};await persist(intent);}
    intent.associationReceipt=await checkouts.associate(intent.associationInput,intent.operationId+':association');intent.phase='associated';delete intent.diagnostic;await persist(intent);
   }
   if(intent.phase==='associated'){
    await catalogCurrent(intent);const checkout=await checkouts.observe(projectId);if(checkout.revision!==intent.associationReceipt!.revision||checkout.state!=='available')throw new AppError('REVISION_CONFLICT','The original selected checkout changed.');
    const grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',projectId);let owned=false;if(grant?.assignment.ownerId===ctx.instanceId)try{await ownership.assertOwner(projectId,grant.assignment.generation);owned=true;}catch{/* Recorded projects remain available without a current execution grant. */}
    if(owned){intent.bindingStarted=true;await persist(intent);await checkouts.prepareExecutionBinding({projectId,expectedCheckoutRevision:intent.associationReceipt!.revision,expectedBindingRevision:intent.preview.bindingRevision},intent.operationId+':binding');intent.phase='bound';await persist(intent);}
    intent.result={projectId,path:intent.preview.path,checkoutAvailable:true,executionReady:owned};
   }
   if(intent.phase==='bound'){
    const checkout=await checkouts.observe(projectId),binding=await ctx.store.read<ProjectBinding>('project-binding',projectId),grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',projectId);let executionReady=false;
    if(checkout.state==='available'&&checkout.revision===intent.associationReceipt?.revision&&binding?.path===intent.preview.path&&binding.commonDir===intent.repositoryCommonDir&&inputHash(binding.rootIdentity??null)===inputHash(intent.repositoryRoot??null)&&grant?.assignment.ownerId===ctx.instanceId)try{await ownership.assertOwner(projectId,grant.assignment.generation);executionReady=true;}catch{/* The completed checkout remains available; a retired grant never reports ready. */}
    intent.result={projectId,path:intent.preview.path,checkoutAvailable:true,executionReady};
   }
   intent.phase='completed';delete intent.diagnostic;await persist(intent);return project(intent);
  }catch(error){intent.diagnostic={code:error instanceof AppError?error.code:'PROJECT_OPERATION_INTERRUPTED',message:error instanceof AppError?error.message:'The operation was interrupted. Original choices and native evidence are retained; resume explicitly.'};await persist(intent);return project(intent);}
 }
 async function confirm(input:{selection:ProjectSelection;expectedPreviewRevision:string},operationId:string):Promise<ProjectFlowOperation>{return serial(async()=>{
  assertRequestId(operationId);await assertRestoredExecutionAllowed(ctx);const selection=selectionOf(input.selection),old=await ctx.store.read<Intent>('project-flow',operationId);
  if(old){if(old.selectionHash!==inputHash(selection)||old.preview.revision!==input.expectedPreviewRevision)throw new AppError('REQUEST_CONFLICT','This operation already names different frozen choices.');return finish(old);}
  const analysis=await analyze(selection,operationId);if(analysis.preview.revision!==input.expectedPreviewRevision)throw new AppError('REVISION_CONFLICT','The reviewed project or destination changed. Review it again before confirming.');
  const catalogExceptRevision=(await observeProjectCatalogExcluding(ctx.vaultDir,analysis.preview.projectId)).revision;if((await observeProjectCatalog(ctx.vaultDir)).revision!==analysis.preview.catalogRevision)throw new AppError('REVISION_CONFLICT','The catalog changed while the intent was freezing.');
  const identity=await readVaultIdentity(ctx.vaultDir),intent:Intent={version:1,operationId,selectionHash:inputHash(selection),preview:analysis.preview,analysis,vaultDir:ctx.vaultDir,vaultId:identity.vaultId,phase:'planned',catalogExpectedRevision:analysis.preview.catalogRevision,catalogExceptRevision};await persist(intent);return finish(intent);
 });}
 async function review(operationId:string){assertRequestId(operationId);const intent=await ctx.store.read<Intent>('project-flow',operationId);if(!intent)throw new AppError('NOT_FOUND','Project operation not found.');if(intent.vaultDir!==ctx.vaultDir)throw new AppError('VAULT_CHANGED','Review this operation against its original vault.');return intent.preview;}
 async function operation(operationId:string){const intent=await ctx.store.read<Intent>('project-flow',operationId);if(!intent)throw new AppError('NOT_FOUND','Project operation not found.');return project(intent);}
 async function resume(operationId:string){return serial(async()=>{const intent=await ctx.store.read<Intent>('project-flow',operationId);if(!intent)throw new AppError('NOT_FOUND','Project operation not found.');return finish(intent);});}
 async function pending(){return (await ctx.store.list<Intent>('project-flow')).filter(intent=>intent.phase!=='completed'&&intent.vaultDir===ctx.vaultDir).map(project);}
 return {preview,confirm,operation,resume,pending,review};
}
