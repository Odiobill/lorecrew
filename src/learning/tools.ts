import { ensureWorkspaceExecutionContext } from '../workspaces/context.js';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, lstat, realpath, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { SessionRecord } from '../runtime/types.js';
import type { ProcessSupervisor } from '../workspaces/processes.js';
import type { WorkloadWorkspace } from '../workspaces/types.js';
import type { CuratorWork, LearningAssignment } from './curator.js';
import { assertWorkloadAdmission } from '../projects/workload-grants.js';
import { assertAdmission, stableId } from '../runtime/admission.js';
import { subjectHash } from './hash.js';
export async function assertWorkloadWorkspace(ctx:InstanceContext,workspace:WorkloadWorkspace){
 const root=join(ctx.stateDir,'staging',`workload-${stableId('workload',workspace.taskId)}`);
 if(workspace.path!==root&&(dirname(workspace.path)!==root||!/^[a-f0-9]{64}$/.test(basename(workspace.path))))throw new AppError('UNSAFE_WORKSPACE','Workload workspace is outside its dedicated staging directory');
 for(const path of [join(ctx.stateDir,'staging'),root,workspace.path])if(await realpath(path)!==path||!(await lstat(path)).isDirectory())throw new AppError('UNSAFE_WORKSPACE','Workload staging path changed');
}
/** The service allocates staging directories. No project binding or project grant is manufactured. */
export async function ensureWorkloadWorkspace(ctx:InstanceContext,record:SessionRecord):Promise<WorkloadWorkspace>{
 const workload=record.input.workload!;const id=stableId('workload',record.session.id);const path=join(ctx.stateDir,'staging',`workload-${id}`);
 if(await realpath(join(ctx.stateDir,'staging'))!==join(ctx.stateDir,'staging'))throw new AppError('UNSAFE_WORKSPACE','Staging root changed');
 await mkdir(path,{recursive:true,mode:0o700});if(!(await lstat(path)).isDirectory()||(await lstat(path)).isSymbolicLink())throw new AppError('UNSAFE_WORKSPACE','Workload staging directory is not a real directory');
 const workspace:WorkloadWorkspace={id,...workload,taskId:record.session.id,path,state:'active'};
 await ctx.store.transact(tx=>{assertAdmission(ctx,tx,record);assertWorkloadAdmission(ctx,tx,workload.workloadId,workload.generation);const previous=tx.get<WorkloadWorkspace>('workload-workspace',id);if(previous&&previous.state!=='active')throw new AppError('WORKSPACE_STOPPED','Workload workspace was released');if(!previous)tx.put('workload-workspace',id,workspace);});return workspace;
}
export function curatorTools(ctx:InstanceContext,vault:Vault,supervisor:ProcessSupervisor,session:(id:number)=>SessionRecord,evolution?:ReturnType<typeof import('../skills/activate.js').openSkillEvolution>){
 const output=(value:unknown)=>({output:[{type:'text' as const,text:JSON.stringify(value)}]});
 async function jobFor(record:SessionRecord){
  const assignment=await ctx.store.read<LearningAssignment>('learning-assignment','curator');
  if(record.input.workload?.workloadId!=='curator'||assignment?.ownerId!==ctx.instanceId||assignment.agentId!==record.session.agentId||assignment.generation!==record.input.workload.generation)throw new AppError('NOT_CURATOR','Tool requires the assigned curator session');
  const job=(await ctx.store.list<CuratorWork>('curator-work')).find(w=>w.sessionId===record.session.id);if(!job)throw new AppError('NOT_CURATOR','Session has no consolidation work');return job;
 }
 return defineExtension({name:'lorecrew-curator',tools:[
  defineTool({name:'curator_propose',description:'Append a tentative lesson resolution or inactive skill candidate. Source lessons and all conflict versions are preserved automatically. This tool cannot edit grants, evidence records, originals, or activate skills.',replay:'safe',parameters:Type.Object({kind:Type.Union([Type.Literal('lesson'),Type.Literal('skill')]),title:Type.String({minLength:1,maxLength:200}),description:Type.String({minLength:1,maxLength:1000}),body:Type.String({minLength:1,maxLength:30000}),expectedBenefit:Type.Optional(Type.String({maxLength:2000})),check:Type.Optional(Type.String({maxLength:4000})),skill:Type.Optional(Type.Object({qualifiedId:Type.String(),baseRevision:Type.Union([Type.String(),Type.Null()]),resources:Type.Array(Type.String()),checks:Type.Array(Type.Object({name:Type.String(),command:Type.Literal('node --test'),fixturePath:Type.String()})),expectedImprovement:Type.String()}))}),async execute(args,api){
   const record=session(api.conversationId);const job=await jobFor(record);const id=stableId(job.id,record.session.id,String(api.taskId));const path=`learning/proposals/${id}.md`;
   const previous=await ctx.store.read<{args:unknown;proposal:import('../vault/types.js').VaultProposal}>('curator-proposal',id);
   async function publish(proposal:import('../vault/types.js').VaultProposal){const result=await vault.propose(proposal);if(args.kind==='skill'&&args.skill){if(!evolution)throw new AppError('UNAVAILABLE','Skill evolution is not composed');await evolution.proposeSkill({sessionId:record.session.id,proposal:{id,qualifiedId:args.skill.qualifiedId,baseRevision:args.skill.baseRevision,candidatePath:path,lessonPaths:job.sourcePaths,checks:args.skill.checks,expectedImprovement:args.skill.expectedImprovement}});}return output({...result,proposalId:id});}
   if(previous){if(!isDeepStrictEqual(previous.args,args))throw new AppError('REQUEST_CONFLICT','Proposal replay arguments differ');return publish(previous.proposal);}
   if(args.kind==='skill'&&(!args.skill||!args.expectedBenefit?.trim()))throw new AppError('INVALID_PROPOSAL','A skill candidate requires structured scope/checks and expected benefit');
   const qualified=args.skill?.qualifiedId.match(/^(global|group:([A-Za-z0-9][A-Za-z0-9._-]*)|agent:([A-Za-z0-9][A-Za-z0-9._-]*))\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
   if(args.kind==='skill'&&!qualified)throw new AppError('INVALID_PROPOSAL','Use a qualified global, group, or agent skill ID');
   const sources=[];for(const source of job.sourcePaths){try{const c=job.sources?.find(c=>c.path===source)??await vault.read(source);sources.push({path:c.path,revision:c.revision,subjectHash:subjectHash(c),sourcePaths:c.metadata.sourcePaths??[],snapshot:c});}catch(error){if(!(error instanceof AppError)||error.code!=='NOT_FOUND')throw error;sources.push({path:source,unavailable:true});}}
   const metadata={type:args.kind==='skill'?'Skill':'LearningProposal',title:args.title,description:args.description,evidenceState:'tentative',sourcePaths:job.sourcePaths,lorecrew:{workId:job.id,sources,...job.conflict?{conflict:job.conflict}:{},...args.kind==='skill'?{skill:{schemaVersion:1,name:qualified![4]!,scope:qualified![1]!.split(':')[0]!,...(qualified![2]||qualified![3]?{scopeId:qualified![2]??qualified![3]!}:{}),status:'candidate',resources:args.skill!.resources},expectedBenefit:args.expectedBenefit!,expectedImprovement:args.skill!.expectedImprovement}:{}}};
   const body=`${args.body}\n\n## Retained sources\n${JSON.stringify({sources,conflict:job.conflict??null},null,2)}\n\nModel proposal only; no claim is validated by this review.`;
   const proposal={id:`curator:${id}`,path,expectedRevision:null,actor:`agent:${record.session.agentId}`,content:`---\n${JSON.stringify(metadata)}\n---\n${body}\n`};
   await ctx.store.transact(tx=>tx.insert('curator-proposal',id,{args,proposal}));
   return publish(proposal);
  }}),
  defineTool({name:'skill_fixture',description:'Save a reproducible SkillFixture concept. Each named Node test must match its declared check name. The service reserves skill-subject.mjs for the frozen before/after subject.',replay:'safe',parameters:Type.Object({files:Type.Array(Type.Object({path:Type.String(),content:Type.String({maxLength:30000})}),{minItems:1,maxItems:15})}),async execute(args,api){
   const record=session(api.conversationId);await jobFor(record);const id=stableId('skill-fixture',record.session.id,String(api.taskId));const path=`learning/skill-fixtures/${id}.md`;
   if(args.files.some(f=>f.path==='skill-subject.mjs'||!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.mjs$/.test(f.path)||f.path.includes('..'))||new Set(args.files.map(f=>f.path)).size!==args.files.length||!args.files.some(f=>f.path.endsWith('.test.mjs')))throw new AppError('INVALID_FIXTURE','Invalid or reserved fixture file');
   const result=await vault.propose({id:`skill-fixture:${id}`,path,expectedRevision:null,actor:`agent:${record.session.agentId}`,content:`---\n${JSON.stringify({type:'SkillFixture',title:'Skill check',files:args.files})}\n---\nReproducible Node check.\n`});return output({path,...result});
  }}),
  defineTool({name:'skill_evaluate',description:'Compare declared fixture checks against frozen baseline/candidate snapshots, yielding to foreground work before every execution. Review alone cannot validate.',replay:'unsafe',parameters:Type.Object({proposalId:Type.String()}),async execute(args,api){if(!evolution)throw new AppError('UNAVAILABLE','Skill evolution is not composed');return output(await evolution.evaluateProposal({...args,sessionId:session(api.conversationId).session.id}));}}),
  defineTool({name:'skill_activate',description:'Activate only an unchanged candidate with a recorded named-check improvement and no regression. Requires the current designated curator grant.',replay:'safe',parameters:Type.Object({proposalId:Type.String(),expectedActiveRevision:Type.Union([Type.String(),Type.Null()])}),async execute(args,api){if(!evolution)throw new AppError('UNAVAILABLE','Skill evolution is not composed');return output(await evolution.activateProposal({...args,mode:'validated',sessionId:session(api.conversationId).session.id}));}}),
  defineTool({name:'curator_test',description:'Run Node test fixtures in service-owned workload staging with supervised processes. Accepts bounded flat .mjs files; no project workspace or arbitrary shell/Git command. Trusted host execution, not a security sandbox. Returns actual execution receipt.',replay:'unsafe',parameters:Type.Object({files:Type.Array(Type.Object({path:Type.String(),content:Type.String({maxLength:30000})}),{minItems:1,maxItems:16})}),async execute(args,api,c){
   const record=session(api.conversationId);await jobFor(record);
   return output(await runCuratorFixture(ctx,supervisor,record,args.files,`pi:${record.session.id}:${api.taskId}`,c));
  }}),
 ]});
}

export async function runCuratorFixture(ctx:InstanceContext,supervisor:ProcessSupervisor,record:SessionRecord,files:Array<{path:string;content:string}>,receiptId:string,c:{abortSignal?:AbortSignal|undefined},skillCheck?:import('./types.js').ExecutionReceipt['skillCheck']){
   if(files.some(f=>!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.mjs$/.test(f.path)||f.path.includes('..'))||new Set(files.map(f=>f.path)).size!==files.length||!files.some(f=>f.path.endsWith('.test.mjs')))throw new AppError('INVALID_FIXTURE','Use unique flat .mjs names and at least one .test.mjs file');
   const root=await ensureWorkloadWorkspace(ctx,record);const id=stableId('fixture',receiptId);const path=join(root.path,id);await mkdir(path,{mode:0o700});
   for(const file of files)await writeFile(join(path,file.path),file.content,{flag:'wx',mode:0o600});
   const workspace={...root,id,path};await ctx.store.transact(tx=>{assertAdmission(ctx,tx,record);assertWorkloadAdmission(ctx,tx,root.workloadId,root.generation);tx.put('workload-workspace',id,workspace);});
   const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;const command=`cd ${quote(path)} && ${quote(process.execPath)} --test --test-reporter=tap ${files.filter(f=>f.path.endsWith('.test.mjs')).map(f=>quote(f.path)).join(' ')}`;
   const execution=await ensureWorkspaceExecutionContext(ctx,record.session.id,root.id);
   let abortProof:Promise<{quiescent:boolean;reason?:string}>|undefined;
   const abort=()=>{abortProof??=supervisor.stopContext(execution.id).catch(error=>({quiescent:false,reason:error instanceof Error?error.message:'Fixture stop failed'}));};
   c.abortSignal?.addEventListener('abort',abort,{once:true});if(c.abortSignal?.aborted)abort();
   try{c.abortSignal?.throwIfAborted();const result=await supervisor.run({contextId:execution.id,command,requestId:receiptId});const subjects=(await ctx.store.list<{sessionId:string;concept:import('../vault/types.js').Concept}>('knowledge-load')).filter(l=>l.sessionId===record.session.id).map(l=>({path:l.concept.path,revision:l.concept.revision,subjectHash:subjectHash(l.concept)}));await ctx.store.transact(tx=>tx.insert('learning-execution',receiptId,{id:receiptId,sessionId:record.session.id,command,exitCode:result.exitCode,output:result.output,at:new Date(ctx.clock.now()).toISOString(),localArtifact:!!result.artifactPath,subjects,...(skillCheck?{skillCheck}:{})}));return {...result,receiptId};}finally{c.abortSignal?.removeEventListener('abort',abort);if(abortProof){const proof=await abortProof;if(!proof.quiescent)throw new AppError('NOT_QUIESCENT',proof.reason??'Fixture processes are not proven stopped');}}
}
