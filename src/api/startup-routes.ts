import type { Static } from 'typebox';
import type { StateContext } from '../instance/state.js';
import type { Route } from './routes.js';
import type { StartupView } from '../setup/types.js';
import type { openVaultInitialization } from '../setup/vault.js';
import { listHostFolders } from '../setup/folders.js';
import * as S from './schemas.js';
export function startupRoutes(options:{state:StateContext;initialization:ReturnType<typeof openVaultInitialization>;view:()=>Promise<StartupView>;activate:()=>Promise<void>}):Route[]{
 const {state,initialization}=options;
 return [
  {method:'POST',path:'/startup/retry',body:S.EmptySchema,response:S.StartupSchema,browserOnly:true,idempotent:true,async handle(){await initialization.reconcile();await options.activate();return options.view();}},
  {method:'GET',path:'/startup',response:S.StartupSchema,handle:()=>options.view()},
  {method:'POST',path:'/startup/directories',body:S.HostFolderInputSchema,response:S.HostFolderListingSchema,browserOnly:true,handle:(_c,b)=>listHostFolders(state,b as Static<typeof S.HostFolderInputSchema>)},
  {method:'POST',path:'/startup/vault-preview',body:S.VaultPreviewInputSchema,response:S.VaultPreviewSchema,browserOnly:true,handle:(_c,b)=>initialization.preview((b as Static<typeof S.VaultPreviewInputSchema>).choice)},
  {method:'POST',path:'/startup/vault',body:S.VaultConfirmSchema,response:S.StartupSchema,browserOnly:true,idempotent:true,async handle(_c,b,key){await initialization.confirm(b as Static<typeof S.VaultConfirmSchema>,key);await options.activate();return options.view();}},
 ];
}
