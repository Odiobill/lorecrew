import type { Context } from 'hono';
import type { ApiOptions, Principal, Route } from './routes.js';
import { openSkillManagement, type SkillDraftFields, type SkillDraftInput, type ScopeTarget } from '../skills/manage.js';
import { previewLocalSkill } from '../skills/import.js';
import * as S from './schemas.js';
export function skillManagementRoutes({ctx,vault}:ApiOptions,principal:(c:Context)=>Principal):Route[]{
 const m=openSkillManagement(ctx,vault);
 return [
  {method:'POST',path:'/skills/draft-preview',body:S.SkillDraftFieldsSchema,response:S.JsonSchema,browserOnly:true,transient:true,async handle(c,body){return m.review(principal(c).id,body as SkillDraftFields);}},
  {method:'POST',path:'/skills/drafts',body:S.SkillDraftInputSchema,response:S.JsonSchema,browserOnly:true,idempotent:true,async handle(c,body){return m.save(principal(c).id,body as SkillDraftInput);}},
  {method:'GET',path:'/skills/authoring',response:S.JsonSchema,query:[{name:'path',schema:S.Type.String(),required:true}],async handle(c){return m.authoring(c.req.query('path')??'');}},
  {method:'GET',path:'/skills/export',response:S.JsonSchema,query:[{name:'path',schema:S.Type.String(),required:true}],async handle(c){return m.exportSkill(c.req.query('path')??'');}},
  {method:'POST',path:'/skills/scope-preview',body:S.SkillScopePreviewInputSchema,response:S.JsonSchema,browserOnly:true,transient:true,async handle(_c,body){const i=body as {path:string;target:ScopeTarget};return m.scopePreview(i.path,i.target);}},
  {method:'POST',path:'/skills/scope',body:S.SkillScopeInputSchema,response:S.JsonSchema,browserOnly:true,idempotent:true,async handle(c,body,key){return m.changeScope(key,`human:${principal(c).id}`,body as Parameters<typeof m.changeScope>[2]);}},
  {method:'GET',path:'/skills/authoring-operations',response:S.JsonSchema,browserOnly:true,query:['state','cursor','limit'].map(name=>({name,schema:S.Type.String()})),async handle(c){return m.operations(c.req.query('state'),c.req.query('cursor'),Number(c.req.query('limit')??20));}},
  {method:'GET',path:'/skills/authoring-operations/:id',response:S.JsonSchema,browserOnly:true,async handle(c){return m.getOperation(c.req.param('id')!);}},
  {method:'POST',path:'/skills/authoring-operations/:id/resume',body:S.SkillOperationResumeSchema,response:S.JsonSchema,browserOnly:true,idempotent:true,async handle(c,body){return m.resume(c.req.param('id')!,(body as {expectedOperationRevision:string}).expectedOperationRevision);}},
  {method:'POST',path:'/skills/authoring-operations/:id/recover-draft',body:S.SkillOperationResumeSchema,response:S.JsonSchema,browserOnly:true,transient:true,async handle(c,body){return m.recoverDraft(principal(c).id,c.req.param('id')!,(body as {expectedOperationRevision:string}).expectedOperationRevision);}},
 ];
}
