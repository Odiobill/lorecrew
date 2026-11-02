import {trackedRepositoryGit} from '../repositories/git.js';
import { assertAuthorityDomain,assertAuthorityScope,authorityScope,type AuthorityScope } from './authority-domain.js';
import { createHash } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { Tx } from '../storage/store.js';
import { ASSIGNMENT_REF } from '../git/refs.js';
import { resolveRemote, fetchControl, candidate, inControlRepo,validateControlDomain } from './ownership.js';
import type { InstanceContext } from '../instance/open.js';
import type { GitClient } from '../git/client.js';
export interface WorkloadGrant {workloadId:string;ownerId:string;generation:number;transitionId:string}
export interface WorkloadTransfer {workloadId:string;expectedGeneration:number;targetInstanceId:string;transitionId:string}
export interface WorkloadProbe {stopAndProve(workloadId:string):Promise<{quiescent:boolean;reason?:string}>}
export interface WorkloadOwnership {
 claim(workloadId:string,requestId:string):Promise<WorkloadGrant>;accept(workloadId:string):Promise<WorkloadGrant>;revoke(workloadId:string,generation:number):Promise<void>;
 assertOwner(workloadId:string,generation:number):Promise<void>;transfer(input:WorkloadTransfer&{probe:WorkloadProbe}):Promise<WorkloadGrant>;
}
interface LocalGrant {authority?:AuthorityScope;remote:string;assignment:WorkloadGrant}
interface Transition extends WorkloadTransfer {phase:'closed'|'revoked'|'published';quiescenceProven?:true}
const revokedId=(id:string,generation:number)=>JSON.stringify([id,generation]);
const same=(a:WorkloadTransfer,b:WorkloadTransfer)=>a.workloadId===b.workloadId&&a.expectedGeneration===b.expectedGeneration&&a.targetInstanceId===b.targetInstanceId&&a.transitionId===b.transitionId;
export function assertWorkloadAdmission(ctx:InstanceContext,tx:Tx,workloadId:string,generation:number){
 assertAuthorityScope(tx,tx.get<LocalGrant>('workload-grants',workloadId)?.authority);
 if(tx.get('workload-revocations',revokedId(workloadId,generation)))throw new AppError('OWNER_REVOKED','Workload generation was revoked');
 if(tx.get<{closed:boolean}>('workload-admission',workloadId)?.closed)throw new AppError('ADMISSION_CLOSED','Workload admission is closed');
 const grant=tx.get<LocalGrant>('workload-grants',workloadId)?.assignment;
 if(grant?.ownerId!==ctx.instanceId||grant.generation!==generation)throw new AppError('NOT_OWNER','No confirmed local workload grant');
}
export function openWorkloadOwnership(ctx:InstanceContext,git:GitClient,remote:string):WorkloadOwnership {
 git=trackedRepositoryGit(ctx,git);
 async function save(assignment:WorkloadGrant,endpoint:string){const scope=await ctx.store.read('authority-binding','current')?{authority:authorityScope(await assertAuthorityDomain(ctx))}:{};
  await ctx.store.transact(tx=>{
   if(tx.get('workload-revocations',revokedId(assignment.workloadId,assignment.generation)))throw new AppError('OWNER_REVOKED','A revoked generation cannot be accepted');
   const closed=tx.get<{generation:number;closed:boolean}>('workload-admission',assignment.workloadId);
   if(closed?.closed&&closed.generation>=assignment.generation)throw new AppError('ADMISSION_CLOSED','Old grant cannot reopen handoff');
   const fleet=tx.get<{remote:string}>('fleet','assignments');if(fleet&&fleet.remote!==endpoint)throw new AppError('FLEET_MISMATCH','Assignment remote differs');
   const prior=tx.get<LocalGrant>('workload-grants',assignment.workloadId);
   tx.put('fleet','assignments',{remote:endpoint});tx.put('workload-grants',assignment.workloadId,{...scope,remote:endpoint,assignment});
   tx.put('workload-admission',assignment.workloadId,{generation:assignment.generation,closed:false});
   if(prior?.assignment.transitionId!==assignment.transitionId)tx.emit('workload.granted',{...assignment});
  });return assignment;
 }
 const api:WorkloadOwnership={
  async claim(workloadId,requestId){
   if(!workloadId?.trim()||!requestId?.trim())throw new AppError('INVALID_REQUEST','Workload and request IDs required');
   if(await ctx.store.read('authority-binding','current'))await assertAuthorityDomain(ctx);
   const transitionId=createHash('sha256').update(JSON.stringify([ctx.instanceId,workloadId,requestId])).digest('hex');const endpoint=await resolveRemote(ctx,git,remote);
   return inControlRepo(ctx,git,async cwd=>{
    let state=await fetchControl(git,cwd,endpoint,ctx);if(!state)throw new AppError('FLEET_NOT_INITIALIZED','Initialize assignment branch first');
    await validateControlDomain(ctx,state.control);for(let attempt=0;attempt<16;attempt++){
     const existing=state.control.workloads?.find(g=>g.workloadId===workloadId);
     if(existing){if(existing.ownerId!==ctx.instanceId||existing.transitionId!==transitionId)throw new AppError('WORKLOAD_OWNED','Initial claim cannot transfer a workload');return save(existing,endpoint);}
     const grant={workloadId,ownerId:ctx.instanceId,generation:1,transitionId};state.control.workloads=[...state.control.workloads??[],grant];
     const commit=await candidate(git,cwd,state.control,state.head);await git.run(cwd,['-c','core.hooksPath=/dev/null','push',endpoint,`${commit}:${ASSIGNMENT_REF}`]).catch(()=>undefined);
     const confirmed=await fetchControl(git,cwd,endpoint,ctx);if(!confirmed||confirmed.head===state.head)throw new AppError('ASSIGNMENT_UNCONFIRMED','Workload claim not confirmed');state=confirmed;
    }throw new AppError('ASSIGNMENT_CONTENTION','Retry the same workload claim');
   });
  },
  async accept(workloadId){const endpoint=await resolveRemote(ctx,git,remote);return inControlRepo(ctx,git,async cwd=>{const state=await fetchControl(git,cwd,endpoint,ctx);if(state)await validateControlDomain(ctx,state.control);const grant=state?.control.workloads?.find(g=>g.workloadId===workloadId);if(grant?.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Remote workload is not assigned locally');return save(grant,endpoint);});},
  async assertOwner(workloadId,generation){if(await ctx.store.read('authority-binding','current'))await assertAuthorityDomain(ctx);await ctx.store.transact(tx=>assertWorkloadAdmission(ctx,tx,workloadId,generation));const endpoint=await resolveRemote(ctx,git,remote);if((await ctx.store.read<LocalGrant>('workload-grants',workloadId))?.remote!==endpoint)throw new AppError('NOT_OWNER','Grant remote differs');},
  async revoke(workloadId,generation){await ctx.store.transact(tx=>{
   if(tx.get('workload-revocations',revokedId(workloadId,generation)))return;
   const grant=tx.get<LocalGrant>('workload-grants',workloadId)?.assignment;if(grant?.ownerId!==ctx.instanceId||grant.generation!==generation)throw new AppError('NOT_OWNER','Only a confirmed generation can be revoked');
   tx.put('workload-admission',workloadId,{generation,closed:true});tx.put('workload-revocations',revokedId(workloadId,generation),grant);
   const transition=tx.get<Transition>('workload-handoff',workloadId);if(transition?.expectedGeneration===generation)tx.put('workload-handoff',workloadId,{...transition,phase:'revoked'});
   tx.emit('workload.revoked',{workloadId,generation});
  });},
  async transfer({probe,...request}){
   if(!Number.isSafeInteger(request.expectedGeneration)||request.expectedGeneration<1||request.expectedGeneration>=Number.MAX_SAFE_INTEGER||!request.targetInstanceId?.trim()||request.targetInstanceId===ctx.instanceId||!request.transitionId?.trim())throw new AppError('INVALID_TRANSFER','Invalid workload transition');
   const endpoint=await resolveRemote(ctx,git,remote);
   const pending=await ctx.store.transact(tx=>{
    const old=tx.get<Transition>('workload-handoff',request.workloadId);if(old&&same(old,request))return old;
    const grant=tx.get<LocalGrant>('workload-grants',request.workloadId);if(grant?.remote!==endpoint||grant.assignment.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Only the owner can transfer');
    if(grant.assignment.generation!==request.expectedGeneration)throw new AppError('STALE_GENERATION','Generation differs');
    if(old&&old.expectedGeneration>=request.expectedGeneration)throw new AppError('HANDOFF_CONFLICT','Resume matching transition');
    const next:Transition={...request,phase:'closed'};tx.put('workload-admission',request.workloadId,{generation:request.expectedGeneration,closed:true});tx.put('workload-handoff',request.workloadId,next);return next;
   });
   if(!pending.quiescenceProven){
    const proof=await probe.stopAndProve(request.workloadId);if(!proof.quiescent)throw new AppError('NOT_QUIESCENT',proof.reason??'Workload is not quiescent');
    await ctx.store.transact(tx=>{const current=tx.get<Transition>('workload-handoff',request.workloadId);const closed=tx.get<{closed:boolean;generation:number}>('workload-admission',request.workloadId);if(!current||!same(current,request)||!closed?.closed||closed.generation!==request.expectedGeneration)throw new AppError('HANDOFF_CONFLICT','Transition changed during proof');tx.put('workload-handoff',request.workloadId,{...current,quiescenceProven:true});});
   }
   await api.revoke(request.workloadId,request.expectedGeneration);
   const revoked=await ctx.store.read<WorkloadGrant>('workload-revocations',revokedId(request.workloadId,request.expectedGeneration));
   return inControlRepo(ctx,git,async cwd=>{
    let state=await fetchControl(git,cwd,endpoint,ctx);if(!state)throw new AppError('ASSIGNMENT_UNCONFIRMED','Assignment branch unavailable');
    for(let attempt=0;attempt<16;attempt++){
     const current=state.control.workloads?.find(g=>g.workloadId===request.workloadId);
     if(current?.ownerId===request.targetInstanceId&&current.generation===request.expectedGeneration+1&&current.transitionId===request.transitionId){await ctx.store.transact(tx=>{const saved=tx.get<Transition>('workload-handoff',request.workloadId)!;if(!same(saved,request)||!saved.quiescenceProven)throw new AppError('HANDOFF_CONFLICT','Missing transition proof');tx.put('workload-handoff',request.workloadId,{...saved,phase:'published'});});return current;}
     if(!current||JSON.stringify(current)!==JSON.stringify(revoked))throw new AppError('TRANSFER_CONFLICT','Remote workload differs from revoked grant');
     const next={...current,ownerId:request.targetInstanceId,generation:request.expectedGeneration+1,transitionId:request.transitionId};state.control.workloads=state.control.workloads!.map(g=>g.workloadId===request.workloadId?next:g);
     const commit=await candidate(git,cwd,state.control,state.head);await git.run(cwd,['-c','core.hooksPath=/dev/null','push',endpoint,`${commit}:${ASSIGNMENT_REF}`]).catch(()=>undefined);
     const confirmed=await fetchControl(git,cwd,endpoint,ctx);if(!confirmed||confirmed.head===state.head)throw new AppError('ASSIGNMENT_UNCONFIRMED','Transfer not confirmed; old owner remains revoked');state=confirmed;
    }throw new AppError('ASSIGNMENT_CONTENTION','Retry the same transfer');
   });
  },
 };return api;
}

/** Reuse confirmed local authority offline; returning ownership needs a new online confirmation. */
export async function resumeWorkloadGrant(ctx:InstanceContext,ownership:WorkloadOwnership,workloadId:string):Promise<WorkloadGrant>{
 const prior=(await ctx.store.read<LocalGrant>('workload-grants',workloadId))?.assignment;
 if(prior){
  try{await ownership.assertOwner(workloadId,prior.generation);return prior;}
  catch(error){if(!(error instanceof AppError)||!['NOT_OWNER','OWNER_REVOKED','ADMISSION_CLOSED'].includes(error.code))throw error;}
 }
 return ownership.accept(workloadId);
}
