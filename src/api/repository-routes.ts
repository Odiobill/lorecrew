import type {ApiOptions,Route} from './routes.js';
import * as S from './schemas.js';
import {AppError} from '../contracts/base.js';
import type {RepositoryAction} from '../repositories/workflow.js';
const object=(properties:Record<string,import('typebox').TSchema>)=>S.Type.Object(properties,{additionalProperties:false});
const text=S.Type.String({minLength:1,maxLength:8192}),id=S.Type.String({minLength:1,maxLength:256}),kind=S.Type.Union([S.Type.Literal('vault'),S.Type.Literal('project')]);
const target=object({name:id,endpoint:text,ref:id,revision:id});
export const RepositoryActionSchema=S.Type.Union([
 object({action:S.Type.Literal('confirm-remote'),kind,id,expectedRevision:id}),
 object({action:S.Type.Literal('publish'),checkpointId:id,target}),
 object({action:S.Type.Literal('clone'),projectId:id,title:text,url:text,parentPath:text,folderName:id}),
 object({action:S.Type.Literal('checkpoint'),input:object({projectId:id,taskIds:S.Type.Array(id,{maxItems:256}),expectedGeneration:S.Type.Integer({minimum:1}),files:S.Type.Array(object({taskId:S.Type.Optional(id),path:text,hash:S.Type.Union([id,S.Type.Null()])}),{maxItems:10000}),handoffId:S.Type.Optional(id)})}),
 ...(['sharing-enable','sharing-join'] as const).map(action=>object({action:S.Type.Literal(action),expectedDomain:id,expectedEpoch:S.Type.Integer({minimum:1}),target,protectionAcknowledged:S.Type.Literal(true)})),
 object({action:S.Type.Literal('handoff'),projectId:id,checkpointId:id,expectedGeneration:S.Type.Integer({minimum:1}),targetInstanceId:id}),
 object({action:S.Type.Literal('preflight'),manifestId:id,projectPath:text}),object({action:S.Type.Literal('accept'),manifestId:id}),
]);
export function repositoryRoutes({runtime}:ApiOptions):Route[]{const workflow=()=>{if(!runtime.repositories)throw new AppError('RUNTIME_REQUIRED','Repository controls are unavailable');return runtime.repositories;};return [
 {method:'GET',path:'/repositories/:kind/:id/status',response:S.JsonSchema,handle:c=>{const kind=c.req.param('kind');if(kind!=='vault'&&kind!=='project')throw new AppError('INVALID_REQUEST','Invalid repository kind');return workflow().status(kind,c.req.param('id')!);}},
 {method:'GET',path:'/repository-operations/:id',response:S.JsonSchema,handle:c=>workflow().operation(c.req.param('id')!)},
 {method:'POST',path:'/repository-operations/:id/resume',body:object({}),response:S.JsonSchema,browserOnly:true,idempotent:true,handle:c=>workflow().resume(c.req.param('id')!)},
 {method:'GET',path:'/sharing/status',response:S.JsonSchema,handle:()=>workflow().sharingStatus()},
 {method:'POST',path:'/repository-actions',body:RepositoryActionSchema,response:S.JsonSchema,browserOnly:true,idempotent:true,handle:(_c,body,id)=>{const input=body as RepositoryAction;return ['sharing-enable','handoff'].includes(input.action)?workflow().enqueue(input,id):workflow().execute(input,id);}},
 ];}
