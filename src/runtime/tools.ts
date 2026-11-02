import {relative,resolve} from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {safeRepositoryPath,validateFile} from '../repositories/checkpoint.js';
import {hash} from '../repositories/inspect.js';
import { ensureWorkspaceExecutionContext } from '../workspaces/context.js';
import { Type } from '@earendil-works/pi-ai';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { defineExtension, type Extension, type ToolRegistration, type ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { InstanceContext } from '../instance/open.js';
import type { ProcessSupervisor } from '../workspaces/processes.js';
import type { SessionRecord } from './types.js';
import { assertAdmission } from './admission.js';
import { AppError } from '../contracts/base.js';
import { subjectHash } from '../learning/hash.js';
import type { Concept } from '../vault/types.js';
import { recordLearningSource } from '../learning/capture.js';
export function runtimeTools(ctx:InstanceContext,supervisor:ProcessSupervisor,guard:(api:ToolExecutionApi,context:Context)=>Promise<SessionRecord>,extensions:readonly Extension[]):Extension[] {
  const admitted=new Map<number,SessionRecord>();
  const coding=defineExtension({...CodingTools,tools:CodingTools.tools!.map(tool=>tool.name==='bash'?{
    ...tool,description:'Run a command under supervised POSIX /bin/sh in the recorded session working directory, using the service environment. Output is bounded; the complete log is a local artifact. Return the execution receiptId when contributing knowledge evidence. Host-user file access is available without a project. Use explicit scripts for additional environment.',parameters:Type.Object({command:Type.String()}),structuredOutputSchema:Type.Object({output:Type.String(),exitCode:Type.Integer(),receiptId:Type.String()}),replay:'unsafe' as const,async execute(args:{command:string},api:ToolExecutionApi,context:Context){
      const session=admitted.get(api.taskId)!;
      if(!session.executionContextId)throw new AppError('CONTEXT_NOT_FOUND','Session has no execution context');
      const execution=session.executionContextId;
      const stop=()=>{void supervisor.stopContext(execution).catch(()=>{});};
      context.abortSignal?.addEventListener('abort',stop,{once:true});
      if(context.abortSignal?.aborted)stop();
      try {
      const subjects=(await ctx.store.list<{sessionId:string;concept:Concept}>('knowledge-load')).filter(r=>r.sessionId===session.session.id).map(r=>({path:r.concept.path,revision:r.concept.revision,subjectHash:subjectHash(r.concept)}));
      const result=await supervisor.run({contextId:execution,command:args.command,requestId:`pi:${session.session.id}:${api.taskId}`});
      const receiptId=`pi:${session.session.id}:${api.taskId}`;
      await ctx.store.transact(tx=>{tx.insert('learning-execution',receiptId,{id:receiptId,sessionId:session.session.id,command:args.command,exitCode:result.exitCode,output:result.output,at:new Date(ctx.clock.now()).toISOString(),localArtifact:!!result.artifactPath,subjects});recordLearningSource(tx,session.session.id,{receiptId});});
      return {structuredOutput:{output:result.output,exitCode:result.exitCode,receiptId},output:[{type:'text' as const,text:result.output},{type:'text' as const,text:`Execution receipt: ${receiptId}`}],isError:result.exitCode!==0,details:{exitCode:result.exitCode,receiptId,...(result.artifactPath?{artifactPath:result.artifactPath}:{})}};
      } finally {context.abortSignal?.removeEventListener('abort',stop);}
    },
  }:tool)});
  return [coding,...extensions].map(extension=>({...extension,tools:(extension.tools??[]).map(tool=>({
    ...tool,async execute(args:unknown,api:ToolExecutionApi,context:Context){
      const session=await guard(api,context);
      const current=await ctx.store.read<SessionRecord>('runtime-session',session.session.id);if(current)Object.assign(session,current);admitted.set(api.taskId,session);
      try {
      const unsafe=tool.replay!=='safe';
      if(unsafe)await ctx.store.transact(tx=>{
        assertAdmission(ctx,tx,session);
        const id=`${session.session.id}:${api.taskId}`;
        if(tx.get('runtime-effect',id))throw new AppError('UNCERTAIN_TOOL_OUTCOME','An effect intent already exists; it cannot be replayed');
        tx.insert('runtime-effect',id,{id,sessionId:session.session.id,taskId:api.taskId,tool:tool.name,state:'started'});
      });
      // Receipt lives in Pi's task outcome. Do not mark settled before Pi commits it.
      const result=await (tool as ToolRegistration).execute(args,api,context);
      if(unsafe&&!result.isError&&['write','edit'].includes(tool.name)&&session.session.projectId&&session.input.teamTaskId&&session.cwd){const selected=(args as {path?:unknown}).path;if(typeof selected==='string'){const path=relative(session.cwd,resolve(session.cwd,selected));let file:{path:string;hash:string}|undefined;try{validateFile(path);const absolute=await safeRepositoryPath(session.cwd,path);if((await lstat(absolute)).isFile())file={path,hash:hash(await readFile(absolute))};}catch{}if(file)await ctx.store.transact(tx=>{const id=session.session.id+':'+api.taskId,effect=tx.get<import('./types.js').EffectRecord>('runtime-effect',id);if(effect)tx.put('runtime-effect',id,{...effect,checkpointFiles:[file!]});});}}
      return result;
      }finally{admitted.delete(api.taskId);}
    },
  } as ToolRegistration))}));
}
