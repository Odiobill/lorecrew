import {lstat,realpath} from 'node:fs/promises';
import type {InstanceContext} from '../instance/open.js';
import type {GitClient} from '../git/client.js';
import type {Ownership,Assignment} from './types.js';
import type {ProjectBinding} from '../workspaces/types.js';
import type {CheckoutAssociation,CheckoutObservation} from './checkout-types.js';
import {AppError} from '../contracts/base.js';
import {assertRestoredExecutionAllowed} from '../instance/recovery.js';
import {inspectRepository,inputHash} from '../repositories/inspect.js';
import {projectPathAllowed} from '../setup/folders.js';
import {bindProject} from './bindings.js';
import {assertAuthorityDomain,assertAuthorityScope,authorityScope} from './authority-domain.js';
import {observeProjectCatalog} from './catalog-observation.js';
import {reviewProjectSource} from './clone-sources.js';
import {requestId as assertRequestId} from '../runtime/admission.js';
const legacyRevision=(binding:ProjectBinding)=>inputHash({kind:'legacy_binding',binding});
const checkoutRevision=(association:CheckoutAssociation|undefined,binding:ProjectBinding|undefined)=>association?.revision??(binding?legacyRevision(binding):null);
export function openProjectCheckouts({ctx,git,ownership}:{ctx:InstanceContext;git:GitClient;ownership:Ownership}){
 async function inspected(path:string){
  if(await realpath(path)!==path||!projectPathAllowed(ctx,path))throw new AppError('INVALID_PROJECT_PATH','Select a canonical Git root separate from the vault and operational state.');
  const view=await inspectRepository(git,path),info=await lstat(path);
  if(!info.isDirectory()||info.isSymbolicLink()||view.kind!=='git'||!view.snapshot?.head||!view.snapshot.branch)throw new AppError('INVALID_GIT_PROJECT','Select a Git repository root with a usable initial commit.');
  if(view.snapshot.busy)throw new AppError('REPOSITORY_BUSY','Resolve the native Git operation before associating this checkout.');
  return {path,commonDir:view.snapshot.commonDir,rootIdentity:{dev:info.dev,ino:info.ino,uid:info.uid}};
 }
 async function observe(projectId:string):Promise<CheckoutObservation>{
  const saved=await ctx.store.read<CheckoutAssociation>('project-checkout',projectId),binding=await ctx.store.read<ProjectBinding>('project-binding',projectId),revision=checkoutRevision(saved,binding);
  if(!saved&&!binding)return {state:'missing',revision:null};
  try{
   const current=await inspected(saved?.path??binding!.path);
   if(saved&&(saved.commonDir!==current.commonDir||inputHash(saved.rootIdentity)!==inputHash(current.rootIdentity))||!saved&&binding&&(binding.commonDir&&binding.commonDir!==current.commonDir||binding.rootIdentity&&inputHash(binding.rootIdentity)!==inputHash(current.rootIdentity)))throw new AppError('CHECKOUT_CHANGED','The saved repository root changed; preserve it and review its original placement.');
   const association:CheckoutAssociation=saved??{projectId,...current,evidence:{kind:'legacy_binding'},operationId:'legacy-binding:'+projectId,revision:revision!};
   return {state:'available',association,revision};
  }catch(error){return {state:'repair',revision,...saved?{association:saved}:{},diagnostic:{code:error instanceof AppError?error.code:(error as NodeJS.ErrnoException).code==='ENOENT'?'CHECKOUT_MISSING':'CHECKOUT_UNAVAILABLE',message:error instanceof AppError?error.message:'The saved checkout is unavailable. Preserve its original folder and inspect it before repair.'}};}
 }
 async function associate(input:{association:Omit<CheckoutAssociation,'operationId'|'revision'>;expectedRevision:string|null},requestId:string):Promise<CheckoutAssociation>{
  assertRequestId(requestId);await assertRestoredExecutionAllowed(ctx);
  if(ctx.store.repositoryFormat()!==2)throw new AppError('MIGRATION_REQUIRED','Stop and convert legacy state before associating a checkout.');
  const digest=inputHash(input),prior=await ctx.store.read<{inputHash:string;result:CheckoutAssociation}>('project-checkout-request',requestId);
  if(prior){if(prior.inputHash!==digest)throw new AppError('REQUEST_CONFLICT','Checkout request names different choices.');return prior.result;}
  const a=input.association,catalog=await observeProjectCatalog(ctx.vaultDir),entry=catalog.entries.find(e=>e.projectId===a.projectId);
  if(!entry)throw new AppError('NOT_FOUND','The recorded project is not in this vault.');
  if(catalog.blockedProjectIds.includes(a.projectId))throw new AppError('AMBIGUOUS_REPOSITORY','Repair the ambiguous project catalog before association.');
  if(!['alias','operator_assertion','legacy_binding'].includes(a.evidence.kind))throw new AppError('INVALID_CHECKOUT_EVIDENCE','Review the checkout identity explicitly.');
  if(a.evidence.kind==='alias'&&(!a.evidence.alias||!entry.repositoryAliases.includes(a.evidence.alias)))throw new AppError('PROJECT_SOURCE_MISMATCH','The reviewed alias does not belong to this project.');
  if(a.evidence.source){const reviewed=reviewProjectSource(entry,a.evidence.source,a.evidence.kind==='operator_assertion');if(a.evidence.kind==='alias'&&(reviewed.kind!=='alias'||reviewed.alias!==a.evidence.alias))throw new AppError('PROJECT_SOURCE_MISMATCH','The reviewed source and alias differ.');}
  const current=await inspected(a.path);
  if(current.commonDir!==a.commonDir||inputHash(current.rootIdentity)!==inputHash(a.rootIdentity))throw new AppError('CHECKOUT_CHANGED','The reviewed checkout root changed.');
  const bindings=await ctx.store.list<ProjectBinding>('project-binding'),clashes:ProjectBinding[]=[];
  for(const other of bindings)if(other.projectId!==a.projectId&&(other.commonDir??(await inspectRepository(git,other.path)).snapshot?.commonDir)===a.commonDir)clashes.push(other);
  const result:CheckoutAssociation={...a,operationId:requestId,revision:inputHash({association:a,operationId:requestId})};
  return ctx.store.transact(tx=>{
   const receipt=tx.get<{inputHash:string;result:CheckoutAssociation}>('project-checkout-request',requestId);if(receipt){if(receipt.inputHash!==digest)throw new AppError('REQUEST_CONFLICT','Checkout request names different choices.');return receipt.result;}
   const previous=tx.get<CheckoutAssociation>('project-checkout',a.projectId),binding=tx.get<ProjectBinding>('project-binding',a.projectId);
   if(checkoutRevision(previous,binding)!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Checkout association changed. Review it again.');
   if(binding?.used&&binding.path!==a.path)throw new AppError('BINDING_IN_USE','An already-used execution binding cannot move to another checkout.');
   if(binding?.used&&binding.commonDir&&binding.commonDir!==a.commonDir)throw new AppError('BINDING_CHANGED','The original used Git common directory changed.');
   if(binding?.used&&binding.rootIdentity&&inputHash(binding.rootIdentity)!==inputHash(a.rootIdentity))throw new AppError('BINDING_CHANGED','The original used repository root changed.');
   if(a.evidence.kind==='legacy_binding'&&binding?.path!==a.path)throw new AppError('INVALID_CHECKOUT_EVIDENCE','Legacy evidence requires the original matching binding.');
   for(const kind of ['project-checkout-common-dir','project-repository-binding']){const owner=tx.get<{projectId:string}>(kind,a.commonDir);if(owner&&owner.projectId!==a.projectId)throw new AppError('PROJECT_PATH_CONFLICT','This Git common directory belongs to another project.');}
   if(clashes.some(b=>tx.get<ProjectBinding>('project-binding',b.projectId)?.path===b.path))throw new AppError('PROJECT_PATH_CONFLICT','This Git common directory belongs to another project.');
   if(previous?.commonDir&&previous.commonDir!==a.commonDir&&tx.get<{projectId:string}>('project-checkout-common-dir',previous.commonDir)?.projectId===a.projectId)tx.delete('project-checkout-common-dir',previous.commonDir);
   tx.put('project-checkout-common-dir',a.commonDir,{projectId:a.projectId});tx.put('project-checkout',a.projectId,result);tx.put('project-checkout-request',requestId,{inputHash:digest,result});tx.emit('project.checkout_changed',{projectId:a.projectId});return result;
  });
 }
 async function prepareExecutionBinding(input:{projectId:string;expectedCheckoutRevision:string;expectedBindingRevision:string|null},requestId:string):Promise<void>{
  assertRequestId(requestId);await assertRestoredExecutionAllowed(ctx);const view=await observe(input.projectId);
  if(view.revision!==input.expectedCheckoutRevision)throw new AppError('REVISION_CONFLICT','Checkout association changed. Review it again.');
  if(view.state!=='available'||!view.association)throw new AppError('CHECKOUT_UNAVAILABLE','Repair the saved checkout before preparing execution.');
  const scope=authorityScope(await assertAuthorityDomain(ctx)),grant=await ctx.store.read<{assignment:Assignment;authority?:typeof scope}>('assignment-grants',input.projectId),fleet=await ctx.store.read('fleet','assignments');
  if(!grant||grant.assignment.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Preparing a checkout does not grant execution ownership.');
  await ownership.assertOwner(input.projectId,grant.assignment.generation);
  const catalog=await observeProjectCatalog(ctx.vaultDir);if(!catalog.entries.some(e=>e.projectId===input.projectId))throw new AppError('NOT_FOUND','The recorded project is not in this vault.');if(catalog.blockedProjectIds.includes(input.projectId))throw new AppError('AMBIGUOUS_REPOSITORY','Repair the ambiguous project catalog before preparing execution.');
  const digest=inputHash(input),receipt=await ctx.store.read<{inputHash:string}>('project-checkout-binding-request',requestId);if(receipt&&receipt.inputHash!==digest)throw new AppError('REQUEST_CONFLICT','Execution binding request changed.');
  await bindProject(ctx,{projectId:input.projectId,path:view.association.path,expectedRevision:input.expectedBindingRevision,requestId:'checkout-binding:'+requestId,expectedCanonicalPath:view.association.path,expectedRepositoryCommonDir:view.association.commonDir,expectedRootIdentity:view.association.rootIdentity,beforeCommit:tx=>{
   assertAuthorityScope(tx,scope);assertAuthorityScope(tx,grant.authority);
   const generation=grant.assignment.generation;
   if(tx.get('assignment-revocations',JSON.stringify([input.projectId,generation])))throw new AppError('OWNER_REVOKED','The reviewed execution generation was revoked.');
   if(tx.get<{closed:boolean}>('project-admission',input.projectId)?.closed||(tx.get<{generation:number}>('runtime-project-fence',input.projectId)?.generation??0)>=generation)throw new AppError('ADMISSION_CLOSED','Project execution admission is closed.');
   if(inputHash(tx.get('assignment-grants',input.projectId)??null)!==inputHash(grant)||inputHash(tx.get('fleet','assignments')??null)!==inputHash(fleet??null))throw new AppError('NOT_OWNER','Confirmed project ownership changed before binding.');
   if(checkoutRevision(tx.get('project-checkout',input.projectId),tx.get('project-binding',input.projectId))!==input.expectedCheckoutRevision)throw new AppError('REVISION_CONFLICT','The reviewed checkout changed before binding.');
  }});
  await ctx.store.transact(tx=>tx.put('project-checkout-binding-request',requestId,{inputHash:digest}));
 }
 return {observe,associate,prepareExecutionBinding};
}
