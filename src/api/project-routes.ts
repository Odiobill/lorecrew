import type {ApiOptions,Route} from './routes.js';
import type {ProjectSelection} from '../projects/workflow-types.js';
import {GitClient} from '../git/client.js';
import {openProjectWorkflows} from '../projects/workflows.js';
import {openProjectCatalogView} from '../projects/catalog-view.js';
import * as S from './schemas.js';
export function projectRoutes(options:ApiOptions):Route[]{const services={...options,git:new GitClient()},flow=openProjectWorkflows(services),catalog=openProjectCatalogView(services);return [
 {method:'GET',path:'/project-catalog',response:S.JsonSchema,handle:()=>catalog.list()},
 {method:'GET',path:'/project-catalog/:id',response:S.JsonSchema,handle:c=>catalog.detail(c.req.param('id')!)},
 {method:'POST',path:'/project-workflows/preview',body:S.ProjectFlowPreviewInputSchema,response:S.JsonSchema,browserOnly:true,transient:true,handle:(_c,b)=>{const input=b as {operationId:string;selection:ProjectSelection};return flow.preview(input.selection,input.operationId);}},
 {method:'POST',path:'/project-workflows',body:S.ProjectFlowConfirmInputSchema,response:S.JsonSchema,browserOnly:true,idempotent:true,handle:(c,b)=>flow.confirm(b as {selection:ProjectSelection;expectedPreviewRevision:string},c.req.header('idempotency-key')!)},
 {method:'GET',path:'/project-workflows/:id/review',response:S.JsonSchema,browserOnly:true,handle:c=>flow.review(c.req.param('id')!)},
 {method:'GET',path:'/project-workflows/:id',response:S.JsonSchema,handle:c=>flow.operation(c.req.param('id')!)},
 {method:'POST',path:'/project-workflows/:id/resume',body:S.EmptySchema,response:S.JsonSchema,browserOnly:true,idempotent:true,handle:c=>flow.resume(c.req.param('id')!)},
 ];}
