import type {InstanceContext} from '../instance/open.js';
import type {GitClient} from '../git/client.js';
import type {Ownership,Assignment,HandoffState} from './types.js';
import type {ProjectBinding} from '../workspaces/types.js';
import type {ProjectFlowOperation} from './workflow-types.js';
import type {RepositoryService} from '../repositories/service.js';
import type {SessionRecord} from '../runtime/types.js';
import type {TaskRecord} from '../team/types.js';
import {AppError} from '../contracts/base.js';
import {assertRestoredExecutionAllowed} from '../instance/recovery.js';
import {assertAuthorityDomain} from './authority-domain.js';
import {observeProjectCatalog} from './catalog-observation.js';
import {openProjectCheckouts} from './checkouts.js';
import {openProjectWorkflows} from './workflows.js';
import {openRepositories} from '../repositories/service.js';
import {inputHash} from '../repositories/inspect.js';
export interface ProjectCatalogItem {
 project:{projectId:string;title:string;repositoryAliases:string[];revision:string};
 checkout:{state:'missing'|'available'|'repair';path?:string;revision:string|null};
 execution:{state:'ready_here'|'elsewhere'|'unconfirmed'|'repair';ownerId?:string};
 gitStatus?:Awaited<ReturnType<RepositoryService['status']>>;
 pending:ProjectFlowOperation[];diagnostics:Array<{code:string;message?:string}>;
}
export function openProjectCatalogView(options:{ctx:InstanceContext;git:GitClient;ownership:Ownership}){
 const {ctx,git,ownership}=options,checkouts=openProjectCheckouts(options),flow=openProjectWorkflows(options),repositories=openRepositories({state:ctx,git});
 async function list(){
  const catalog=await observeProjectCatalog(ctx.vaultDir),pending=await flow.pending(),items:ProjectCatalogItem[]=[];
  for(const entry of [...catalog.entries].sort((a,b)=>a.title.localeCompare(b.title)||a.projectId.localeCompare(b.projectId))){
   const projectId=entry.projectId,checkout=await checkouts.observe(projectId),diagnostics:ProjectCatalogItem['diagnostics']=catalog.diagnostics.filter(d=>d.projectIds.includes(projectId)).map(d=>({code:d.code}));if(checkout.diagnostic)diagnostics.push(checkout.diagnostic);
   let execution:ProjectCatalogItem['execution']={state:'unconfirmed'};
   const grant=await ctx.store.read<{assignment:Assignment;authority?:{domainId:string;epoch:number}}>('assignment-grants',projectId),binding=await ctx.store.read<ProjectBinding>('project-binding',projectId);
   if(grant){try{await assertRestoredExecutionAllowed(ctx);await ownership.assertOwner(projectId,grant.assignment.generation);const a=checkout.association;execution={state:checkout.state==='available'&&a&&binding?.path===a.path&&(!binding.commonDir||binding.commonDir===a.commonDir)&&(!binding.rootIdentity||inputHash(binding.rootIdentity)===inputHash(a.rootIdentity))?'ready_here':'repair',ownerId:ctx.instanceId};}catch{execution={state:'repair'};}}
   const transfer=await ctx.store.read<HandoffState>('project-handoff',projectId);
   if(transfer?.phase==='published'&&transfer.assignment?.ownerId!==ctx.instanceId){try{const domain=await assertAuthorityDomain(ctx);if(grant?.authority?.domainId===domain.domainId&&grant.authority.epoch===domain.epoch&&grant.assignment.generation===transfer.expectedGeneration&&transfer.assignment&&transfer.assignment.generation>transfer.expectedGeneration&&transfer.assignment.transitionId===transfer.transitionId)execution={state:'elsewhere',ownerId:transfer.assignment.ownerId};}catch{/* A retired local transfer does not establish current ownership. */}}
   if(catalog.blockedProjectIds.includes(projectId))execution={state:'repair'};
   items.push({project:{projectId,title:entry.title,repositoryAliases:entry.repositoryAliases,revision:catalog.revision},checkout:{state:checkout.state,revision:checkout.revision,...checkout.association?{path:checkout.association.path}:{}},execution,...checkout.state==='available'&&checkout.association?{gitStatus:await repositories.status({kind:'project',id:projectId,path:checkout.association.path})}:{},pending:pending.filter(p=>p.projectId===projectId),diagnostics});
  }
  return {revision:catalog.revision,items,pendingNew:pending.filter(p=>!catalog.entries.some(e=>e.projectId===p.projectId)),diagnostics:catalog.diagnostics};
 }
 async function detail(id:string){const view=await list(),item=view.items.find(i=>i.project.projectId===id);if(!item)throw new AppError('NOT_FOUND','Project not found in this vault.');return {...item,conversations:(await ctx.store.list<SessionRecord>('runtime-session')).filter(r=>r.session.projectId===id&&!r.input.teamTaskId).map(r=>r.session.id).sort(),tasks:(await ctx.store.list<TaskRecord>('team-task')).filter(t=>t.projectId===id).map(t=>t.id).sort()};}
 return {list,detail};
}
