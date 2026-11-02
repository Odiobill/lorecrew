import { resolveAgent } from '../agents/resolve.js';
import { stableId } from '../runtime/admission.js';
import type { InstanceContext } from '../instance/open.js';
import type { Concept, Vault } from '../vault/types.js';
import type { Runtime } from '../runtime/types.js';
import type { WorkloadOwnership } from '../projects/workload-grants.js';
import type { Tx } from '../storage/store.js';
import type { ConflictProposal } from '../sync/types.js';
import { AppError } from '../contracts/base.js';
export interface LearningAssignment {agentId:string;ownerId:string;generation:number}
export interface CuratorWork {id:string;sourcePaths:string[];sources?:Concept[];conflict?:ConflictProposal;sessionId?:string;generation?:number;state:'pending'|'running'|'completed'|'failed';prompt?:string}
export interface CuratorStatus {state:'waiting_assignment'|'waiting_owner'|'waiting_grant'|'ready'|'working'|'blocked';reason?:string}
export function queueCurator(tx:Tx,input:{id:string;sourcePaths:string[];sources?:Concept[];conflict?:ConflictProposal}){
 if(!tx.get('curator-work',input.id))tx.put<CuratorWork>('curator-work',input.id,{...input,state:'pending'});
}
export function queueCuratorLesson(tx:Tx,concept:Concept){
 if(concept.metadata.type==='Lesson'&&!concept.path.startsWith('learning/proposals/'))queueCurator(tx,{id:`lesson:${stableId(concept.path,concept.revision)}`,sourcePaths:[concept.path],sources:[concept]});
}
const queues=new WeakMap<InstanceContext,Promise<void>>();
export function openCurator({ctx,vault,runtime,ownership}:{ctx:InstanceContext;vault:Vault;runtime:Runtime;ownership:WorkloadOwnership}){
 async function state(value:CuratorStatus){if(JSON.stringify(await ctx.store.read('curator-status','current'))!==JSON.stringify(value))await ctx.store.transact(tx=>tx.put('curator-status','current',value));}
 async function tick(){
  if(await ctx.store.read('curator-reassignment','pending')){await state({state:'blocked',reason:'REASSIGNMENT_PENDING'});return;}
  if(!await ctx.store.read('curator-source-index','v1')){const concepts=await vault.list();await ctx.store.transact(tx=>{for(const concept of concepts)queueCuratorLesson(tx,concept);tx.put('curator-source-index','v1',{initialized:true});});}
  const assignment=await ctx.store.read<LearningAssignment>('learning-assignment','curator');
  if(!assignment){await state({state:'waiting_assignment'});return;}
  if(assignment.ownerId!==ctx.instanceId){await state({state:'waiting_owner'});return;}
  const jobs=(await ctx.store.list<CuratorWork>('curator-work')).filter(j=>j.state==='pending'||j.state==='running');
  if(!jobs.length){await state({state:'ready'});return;}
  try{await ownership.assertOwner('curator',assignment.generation);}catch(error){await state({state:'waiting_grant',reason:error instanceof AppError?error.code:'GRANT_UNAVAILABLE'});return;}
  // One active consolidation per grant. The Pi session/outbox own recovery and retry identity.
  for(let job of jobs){
   if(job.sessionId&&job.generation===assignment.generation){
    const snapshot=await runtime.snapshot(job.sessionId);
    if(['completed','failed','cancelled'].includes(snapshot.status)){job={...job,state:snapshot.status==='completed'?'completed':'failed'};await ctx.store.transact(tx=>tx.put('curator-work',job.id,job));continue;}
   }
   if(!job.sessionId||job.generation!==assignment.generation){
    const epoch=(await ctx.store.read<{id:string}>('curator-epoch','current'))?.id??'initial';
    const requestId=`curator:${job.id}:${assignment.generation}:${epoch}`;
    const prompt=`Consolidate the following captured learning or conflict. Preserve every disagreement and evidence trail. Do not claim validation from model review or merge success. Use knowledge_search/load, then curator_propose to retain a bounded semantic proposal or a tentative skill candidate. No ownership changes. Work item: ${JSON.stringify({id:job.id,sourcePaths:job.sourcePaths,sources:job.sources,conflict:job.conflict})}`;
    const session=await runtime.createSession({requestId,agentId:assignment.agentId,background:true,workload:{workloadId:'curator',generation:assignment.generation}});
    job={...job,sessionId:session.id,generation:assignment.generation,state:'running',prompt};await ctx.store.transact(tx=>tx.put('curator-work',job.id,job));
   }
   await runtime.submit({sessionId:job.sessionId!,requestId:`curator:${job.id}`,text:job.prompt!});
   await state({state:'working'});return;
  }
  await state({state:'ready'});
 }
 interface Reassignment {requestId:string;agentId:string;expectedRevision:string|null;previous:LearningAssignment|null;grant:unknown}
 async function reassign(input:{agentId:string;expectedRevision:string|null;requestId:string;claim:()=>Promise<{ownerId:string;generation:number}>}){
  const receipt=await ctx.store.read<{agentId:string;expectedRevision:string|null}>('curator-reassignment-receipt',input.requestId);if(receipt){if(receipt.agentId!==input.agentId||receipt.expectedRevision!==input.expectedRevision)throw new AppError('REQUEST_CONFLICT','Curator request differs');return;}
  await resolveAgent(vault,input.agentId);
  let pending=await ctx.store.read<Reassignment>('curator-reassignment','pending');
  if(pending&&pending.requestId===input.requestId&&(pending.agentId!==input.agentId||pending.expectedRevision!==input.expectedRevision))throw new AppError('REQUEST_CONFLICT','Curator request differs');
  if(pending&&pending.requestId!==input.requestId)throw new AppError('REASSIGNMENT_PENDING','Resume the pending curator assignment first');
  if(!pending){
   const previous=await ctx.store.read<LearningAssignment>('learning-assignment','curator')??null;
   if((previous?stableId(JSON.stringify(previous)):null)!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Curator assignment changed');
   if(previous&&previous.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Curator is assigned to another instance');
   if(!previous&&!await ctx.store.read('workload-grants','curator'))await input.claim();
   const grant=await ctx.store.read<{assignment:{ownerId:string;generation:number}}>('workload-grants','curator');
   if(!grant||grant.assignment.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','No local curator grant');
   await ownership.assertOwner('curator',grant.assignment.generation);
   pending={requestId:input.requestId,agentId:input.agentId,expectedRevision:input.expectedRevision,previous,grant};
   await ctx.store.transact(tx=>{if(tx.get('curator-reassignment','pending'))throw new AppError('REASSIGNMENT_PENDING','Another reassignment is pending');tx.put('curator-reassignment','pending',pending);});
  }
  const proof=await runtime.quiesceCurator();if(!proof.quiescent)throw new AppError('NOT_QUIESCENT',proof.reason??'Curator work has not settled');
  const jobs=await ctx.store.list<CuratorWork>('curator-work');
  const intent=pending;await ctx.store.transact(tx=>{
   const current=tx.get<Reassignment>('curator-reassignment','pending');const grant=tx.get<{assignment:{ownerId:string;generation:number}}>('workload-grants','curator');
   if(current?.requestId!==input.requestId||JSON.stringify(grant)!==JSON.stringify(intent.grant)||JSON.stringify(tx.get('learning-assignment','curator')??null)!==JSON.stringify(intent.previous))throw new AppError('REASSIGNMENT_CONFLICT','Curator authority or selection changed');
   const generation=grant!.assignment.generation;
   if(tx.get<{closed:boolean}>('workload-admission','curator')?.closed||tx.get('workload-revocations',JSON.stringify(['curator',generation]))||tx.get<{expectedGeneration:number}>('workload-handoff','curator')?.expectedGeneration===generation)throw new AppError('ADMISSION_CLOSED','Ownership handoff prevents curator reassignment');
   for(const job of jobs)if(job.state==='running'||job.state==='pending'){
    tx.put('curator-work',job.id,{...job,state:'failed'});const {sessionId,generation,prompt,...source}=job;const id=stableId(job.id,input.requestId);if(!tx.get('curator-work',id))tx.put('curator-work',id,{...source,id,state:'pending'});
   }
   tx.put('learning-assignment','curator',{agentId:intent.agentId,ownerId:ctx.instanceId,generation});
   tx.put('curator-epoch','current',{id:input.requestId});tx.put('curator-reassignment-receipt',input.requestId,{agentId:intent.agentId,generation,expectedRevision:intent.expectedRevision});tx.delete('curator-reassignment','pending');
   tx.emit('curator.assigned',{agentId:intent.agentId,generation,requestId:input.requestId});
  });

 }
 return {
  reassign(input:Parameters<typeof reassign>[0]){const next=(queues.get(ctx)??Promise.resolve()).then(()=>reassign(input));queues.set(ctx,next.catch(()=>{}));return next;},
  tick(){const next=(queues.get(ctx)??Promise.resolve()).then(tick).catch(async error=>{await state({state:'blocked',reason:error instanceof AppError?error.code:error instanceof Error?error.message:'CURATOR_FAILED'});});queues.set(ctx,next.catch(()=>{}));return next;},
  async assign(assignment:LearningAssignment){
   if(!assignment.agentId?.trim()||!assignment.ownerId?.trim()||!Number.isSafeInteger(assignment.generation)||assignment.generation<1)throw new AppError('INVALID_ASSIGNMENT','Select agent, execution instance, and confirmed generation');
   if(assignment.ownerId===ctx.instanceId)await ownership.assertOwner('curator',assignment.generation);
   await ctx.store.transact(tx=>{const previous=tx.get<LearningAssignment>('learning-assignment','curator');if(previous&&JSON.stringify(previous)!==JSON.stringify(assignment)){
    // A live generation pins the selected identity; reconfiguration requires a quiescent new grant.
    const grant=tx.get<{assignment:{generation:number}}>('workload-grants','curator');
    if(previous.ownerId===ctx.instanceId&&grant?.assignment.generation===previous.generation)throw new AppError('ASSIGNMENT_ACTIVE','Transfer/revoke the existing curator generation before changing its identity');
   }tx.put('learning-assignment','curator',assignment);});
  },
  async status():Promise<CuratorStatus>{return await ctx.store.read<CuratorStatus>('curator-status','current')??{state:'waiting_assignment'};},
  async close(){await queues.get(ctx);},
 };
}
