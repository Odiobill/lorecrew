import type {ProjectSelection} from '../projects/workflow-types.js';
import type { ApiOptions,Route } from './routes.js';
import { GitClient } from '../git/client.js';
import { openSetup,assertSetupReservation,assertSetupCreationReservation } from '../setup/service.js';
import type { SetupSaveInput,ProjectConnectionInput } from '../setup/types.js';
import {assertAuthorityDomain} from '../projects/authority-domain.js';
import { openSetupOwnership,type OwnershipSetupInput } from '../setup/ownership.js';
import { openProjectWorkflow } from '../setup/project-workflow.js';
import { listHostFolders } from '../setup/folders.js';
import type { ProjectWorkflowInput } from '../setup/types.js';
import * as S from './schemas.js';
export function setupRoutes(options:ApiOptions):Route[]{
 const services={...options,git:new GitClient()},setup=openSetup(services),ownership=openSetupOwnership(services),projects=openProjectWorkflow(services);
 return [
  {method:'POST',path:'/setup/project-entry/preview',body:S.ProjectFlowPreviewInputSchema,response:S.JsonSchema,browserOnly:true,transient:true,handle:(_c,b)=>{const input=b as {operationId:string;selection:ProjectSelection};return projects.entry.preview(input.selection,input.operationId);}},
  {method:'POST',path:'/setup/project-entry',body:S.ProjectFlowConfirmInputSchema,response:S.JsonSchema,browserOnly:true,idempotent:true,handle:(c,b)=>projects.entry.confirm(b as {selection:ProjectSelection;expectedPreviewRevision:string},c.req.header('idempotency-key')!)},
  {method:'GET',path:'/setup/project-entry/:id/review',response:S.JsonSchema,browserOnly:true,handle:c=>projects.entry.review(c.req.param('id')!)},
  {method:'GET',path:'/setup/project-entry/:id',response:S.JsonSchema,browserOnly:true,handle:c=>projects.entry.operation(c.req.param('id')!)},
  {method:'POST',path:'/setup/project-entry/:id/resume',body:S.EmptySchema,response:S.JsonSchema,browserOnly:true,idempotent:true,handle:c=>projects.entry.resume(c.req.param('id')!,c.req.header('idempotency-key')!)},
  {method:'GET',path:'/setup/project-options',response:S.ProjectSetupOptionsSchema,browserOnly:true,handle:()=>projects.options()},
  {method:'POST',path:'/setup/ownership',body:S.OwnershipSetupInputSchema,response:S.OwnershipSetupViewSchema,browserOnly:true,idempotent:true,async handle(_c,b,id){await assertAuthorityDomain(options.ctx);return ownership.configure(b as OwnershipSetupInput,id);}},
  {method:'POST',path:'/setup/directories',body:S.HostFolderInputSchema,response:S.HostFolderListingSchema,browserOnly:true,transient:true,handle:(_c,b)=>listHostFolders(options.ctx,b as {path?:string;cursor?:string})},
  {method:'POST',path:'/setup/project-previews',body:S.ProjectPreviewInputSchema,response:S.ProjectPreviewSchema,browserOnly:true,transient:true,handle:(_c,b)=>projects.preview(b as {projectId:string;path:string;repositoryKey?:string})},
  {method:'POST',path:'/setup/project-workflows',body:S.ProjectWorkflowInputSchema,response:S.ProjectWorkflowResultSchema,browserOnly:true,idempotent:true,async handle(c,b,id){const input=b as ProjectWorkflowInput;await assertSetupCreationReservation(options.ctx,'project',c.req.header('idempotency-key'),input.projectId);return projects.connect(input,id);}},
  {method:'POST',path:'/setup/project-workflows/:id/resume',body:S.ProjectResumeInputSchema,response:S.ProjectWorkflowResultSchema,browserOnly:true,idempotent:true,async handle(c,b){const id=c.req.param('id')!;await assertSetupReservation(options.ctx,['project'],c.req.header('idempotency-key'),id);return projects.resume(id,b as {useExisting?:boolean});}},
  {method:'GET',path:'/setup',response:S.SetupViewSchema,browserOnly:true,handle:()=>setup.read()},
  {method:'PUT',path:'/setup',body:S.SetupSaveSchema,response:S.SetupViewSchema,browserOnly:true,idempotent:true,handle:(_c,b,id)=>setup.save(b as SetupSaveInput,id)},
  {method:'POST',path:'/setup/project-inspection',body:S.ProjectInspectionInputSchema,response:S.ProjectInspectionSchema,browserOnly:true,transient:true,handle:(_c,b)=>setup.inspectProject(b as {path:string})},
  {method:'POST',path:'/setup/project-connections',body:S.ProjectConnectionInputSchema,response:S.ProjectConnectionSchema,browserOnly:true,idempotent:true,async handle(c,b,id){const input=b as ProjectConnectionInput;await assertSetupCreationReservation(options.ctx,'project',c.req.header('idempotency-key'),input.projectId);return setup.connectProject(input,id);}},
 ];
}
