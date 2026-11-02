import {withProjectEntry,assertProjectEntryAvailable} from '../projects/entry-coordination.js';
import { realpath,stat,lstat } from 'node:fs/promises';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { GitClient } from '../git/client.js';
import type { Assignment,Ownership } from '../projects/types.js';
import type { ProjectBinding } from '../workspaces/types.js';
import { projectPathAllowed } from './folders.js';
import { bindProject } from '../projects/bindings.js';
import { canonicalRepositoryKey,registerProject } from '../projects/registry.js';
import {inspectRepository} from '../repositories/inspect.js';
import {readVaultIdentity} from '../repositories/identity.js';
import {ensureLocalAuthority} from '../projects/authority-domain.js';
import { stableId } from '../runtime/admission.js';
import type { ProjectConnectionInput,ProjectConnection,ProjectInspection,SetupView } from './types.js';
interface Intent extends ProjectConnectionInput {commonDir:string;root:{dev:number;ino:number;uid:number};requestId:string;bindingRevision:string|null;claimed?:true}
export function openSetupProjects({ctx,git,ownership,strictPath=false}:{ctx:InstanceContext;git:GitClient;ownership:Ownership;strictPath?:boolean}) {
 async function inspectProject(input:{path:string}):Promise<ProjectInspection>{
  let path:string;try{path=await realpath(input.path);if(!(await stat(path)).isDirectory())throw Error();}catch{throw new AppError('INVALID_PROJECT_PATH','Enter an existing directory on the instance host.');}
  const root=await git.run(path,['rev-parse','--show-toplevel']);
  if(root.exitCode!==0)return {path,kind:'directory'};
  // Use a repository root rather than accidentally binding a nested directory to its parent worktree.
  path=await realpath(root.stdout.trim());
  const remote=await git.run(path,['config','--get','remote.origin.url']);
  let suggestedRepositoryKey:string|undefined;
  if(remote.exitCode===0){
   let candidate=remote.stdout.trim();
   try{const url=new URL(candidate);url.username='';url.password='';url.search='';url.hash='';candidate=url.href;}catch{/* scp-style SSH remains supported */}
   try{suggestedRepositoryKey=canonicalRepositoryKey(candidate);}catch{/* Local and unrecognized remotes require an explicit fork identity. */}
  }
  return {path,kind:'git',...(suggestedRepositoryKey?{suggestedRepositoryKey}:{})};
 }
 async function readiness(projectId:string|undefined):Promise<SetupView['readiness']['project']>{
  if(!projectId)return 'not_selected';
  const grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',projectId);
  if(!grant)return 'unavailable';
  try{await ownership.assertOwner(projectId,grant.assignment.generation);}catch{return 'unavailable';}
  const binding=await ctx.store.read<ProjectBinding>('project-binding',projectId);
  if(!binding)return 'claimed_unbound';
  try{if(await realpath(binding.path)!==binding.path||!(await stat(binding.path)).isDirectory()||(await inspectRepository(git,binding.path)).kind!=='git')return 'claimed_unbound';}catch{return 'claimed_unbound';}
  return 'ready';
 }
 function connectProject(input:ProjectConnectionInput,requestId:string):Promise<ProjectConnection>{
  const work=withProjectEntry(ctx.store,async():Promise<ProjectConnection>=>{
   const checked=await inspectRepository(git,input.path);if(checked.kind!=='git'||!checked.snapshot?.head||!projectPathAllowed(ctx,checked.path))throw new AppError('INVALID_GIT_PROJECT','Connect a separate actual Git root with a usable initial commit');
   const project=registerProject([],{id:input.projectId,title:input.title,repositoryKey:input.repositoryKey});
   const previous=await ctx.store.read<Intent>('setup-project-intent',project.id);
   await assertProjectEntryAvailable(ctx,{family:'legacy',operationId:previous?.requestId??requestId,projectId:input.projectId,path:checked.path,commonDir:checked.snapshot.commonDir,repositoryKey:project.repositoryKey});
   await ensureLocalAuthority(ctx,await readVaultIdentity(ctx.vaultDir),requestId+':authority');
   // After a claim the original canonical path remains repairable even while the directory is absent.
   let path:string;try{path=await realpath(input.path);}catch{if(previous?.path===input.path)path=previous.path;else throw new AppError('INVALID_PROJECT_PATH','Enter an existing directory on the instance host.');}
   if(strictPath&&(path!==input.path||!projectPathAllowed(ctx,path)))throw new AppError('PROJECT_FOLDER_CHANGED','The project folder target changed. Review the original host folder before retrying.');
   const info=await lstat(path),root={dev:info.dev,ino:info.ino,uid:info.uid};
   const normalized={commonDir:checked.snapshot.commonDir,root,projectId:project.id,title:project.title,repositoryKey:project.repositoryKey,path};
   const intent=await ctx.store.transact(tx=>{
    const prior=tx.get<Intent>('setup-project-intent',project.id);
    if(prior){if(JSON.stringify([prior.repositoryKey,prior.path,prior.title])!==JSON.stringify([normalized.repositoryKey,path,normalized.title]))throw new AppError('REQUEST_CONFLICT','This project has a recorded connection intent. Resume its original identity and path.');return prior;}
    const binding=tx.get<ProjectBinding>('project-binding',project.id);
    const next:Intent={...normalized,requestId,bindingRevision:binding?stableId(binding.projectId,binding.path):null};tx.put('setup-project-intent',project.id,next);return next;
   });
   if(!intent.claimed){
    const grant=await ctx.store.read<{assignment:Assignment}>('assignment-grants',project.id);
    if(grant){if(grant.assignment.repositoryKey!==project.repositoryKey)throw new AppError('PROJECT_CONFLICT','The existing project has a different repository identity.');await ownership.assertOwner(project.id,grant.assignment.generation);}
    else await ownership.claim(project,intent.requestId);
    await ctx.store.transact(tx=>tx.put('setup-project-intent',project.id,{...intent,claimed:true}));
   }
   // A confirmed historical claim cannot bypass a later revocation or admission fence.
   if(await readiness(project.id)==='unavailable')throw new AppError('NOT_OWNER','Local project ownership is unavailable. Repair the grant before connecting.');
   try{const target=await ctx.store.read<{commonDir?:string;root?:{dev:number;ino:number;uid:number}}>('setup-project-workflow',project.id);await bindProject(ctx,{projectId:project.id,path:intent.path,expectedRepositoryCommonDir:target?.commonDir??intent.commonDir,expectedRootIdentity:target?.root??intent.root,expectedRevision:intent.bindingRevision,requestId:stableId('setup-binding',project.id,intent.requestId),...strictPath?{expectedCanonicalPath:intent.path}:{}});}
   catch{return {projectId:project.id,state:'claimed_unbound',diagnostic:'Ownership confirmed; binding needs repair. Restore the selected host directory and retry Repair binding. Review the original checkout and execution state in Projects.'};}
   return {projectId:project.id,state:await readiness(project.id)==='ready'?'ready':'claimed_unbound'};
  });return work;
 }
 return {inspectProject,connectProject,readiness};
}
