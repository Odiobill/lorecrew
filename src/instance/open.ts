import { stat } from 'node:fs/promises';
import { AppError, type Clock } from '../contracts/base.js';
import { readConfig, writeConfig } from './config.js';
import { validateStatePlacement } from './placement.js';
import { openState, type StateContext } from './state.js';
export interface InstanceContext extends StateContext {vaultDir:string}
const attachments=new WeakMap<StateContext,Promise<InstanceContext>>();
export async function attachVault(state:StateContext,path:string):Promise<InstanceContext> {
 // Serialize binding attempts on this lease; a competing target must inspect the committed binding.
 const previous=attachments.get(state);if(previous){const attached=await previous;if((await validateStatePlacement({stateDir:state.stateDir,vaultDir:path})).vaultDir!==attached.vaultDir)throw new AppError('VAULT_MISMATCH','Instance is already bound to a different vault');return attached;}
 const pending=(async()=>{
  const {vaultDir}=await validateStatePlacement({stateDir:state.stateDir,vaultDir:path});
  if(!(await stat(vaultDir)).isDirectory())throw new AppError('INVALID_VAULT_DIR','Vault must be a directory');
  const existing=await readConfig(state.stateDir);
  if(existing&&existing.instanceId!==state.instanceId)throw new AppError('INVALID_CONFIG','Private identity and vault configuration disagree');
  if(existing&&existing.vaultDir!==vaultDir)throw new AppError('VAULT_MISMATCH','Instance is already bound to a different vault');
  if(!existing)await writeConfig(state.stateDir,{instanceId:state.instanceId,vaultDir});
  return {...state,vaultDir};
 })();attachments.set(state,pending);
 try{return await pending;}catch(error){attachments.delete(state);throw error;}
}
export async function openInstance(options:{stateDir:string;vaultDir:string;clock?:Clock}):Promise<InstanceContext> {
 // Validate before creating any private state, preserving the existing no-effects-on-invalid-placement contract.
 const paths=await validateStatePlacement(options);if(!(await stat(paths.vaultDir)).isDirectory())throw new AppError('INVALID_VAULT_DIR','Vault must be a directory');
 const state=await openState({...paths,...(options.clock?{clock:options.clock}:{})});
 try{return await attachVault(state,paths.vaultDir);}catch(error){await state.close();throw error;}
}
