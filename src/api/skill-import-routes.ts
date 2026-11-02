import type { Context } from 'hono';
import type { ApiOptions,Principal,Route } from './routes.js';
import { publicGitHub } from '../skills/import/github.js';
import { resolveSkillSource,previewRemoteSkill } from '../skills/import/source.js';
import { readPreviewFile,discardPreview } from '../skills/import/staging.js';
import { readImportedResource } from '../skills/import/reader.js';
import { previewLocalSkill } from '../skills/import.js';
import type { GitHubSourceInput } from '../skills/import/types.js';
import * as S from './schemas.js';
export function skillImportRoutes({ctx,skillImportTransport=publicGitHub}:ApiOptions,principal:(c:Context)=>Principal):Route[]{return [
 {method:'POST',path:'/skills/import-sources',body:S.SkillSourceInputSchema,response:S.JsonSchema,browserOnly:true,transient:true,async handle(c,body){return resolveSkillSource(ctx,principal(c).id,body as GitHubSourceInput,skillImportTransport);}},
 {method:'POST',path:'/skills/import-preview',body:S.SkillImportPreviewInputSchema,response:S.JsonSchema,browserOnly:true,transient:true,async handle(c,body){const input=body as {markdown:string}|{sourceId:string;skillPath:string};return 'markdown' in input?previewLocalSkill(input.markdown):previewRemoteSkill(ctx,principal(c).id,input,skillImportTransport);}},
 {method:'GET',path:'/skills/import-previews/:id/file',response:S.JsonSchema,browserOnly:true,query:[{name:'path',schema:S.Type.String(),required:true}],async handle(c){return readPreviewFile(ctx,principal(c).id,c.req.param('id')!,c.req.query('path')!);}},
 {method:'DELETE',path:'/skills/import-previews/:id',response:S.OkSchema,browserOnly:true,transient:true,async handle(c){await discardPreview(ctx,principal(c).id,c.req.param('id')!);return {ok:true};}},
 {method:'GET',path:'/skills/resource',response:S.JsonSchema,query:['qualifiedId','skillRevision','resourcePath'].map(name=>({name,schema:S.Type.String(),required:true})),async handle(c){return readImportedResource(ctx,{qualifiedId:c.req.query('qualifiedId')!,skillRevision:c.req.query('skillRevision')!,resourcePath:c.req.query('resourcePath')!});}},
 ];}
