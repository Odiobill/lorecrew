import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, type Clock } from '../contracts/base.js';
import { openStore, type Store } from '../storage/store.js';
import { readConfig } from './config.js';
import { acquireLock } from './lock.js';
import { validatePrivateStatePlacement } from './placement.js';
export interface StateContext {
  instanceId:string; stateDir:string; clock:Clock; store:Store; close():Promise<void>;
}
export async function openState(options:{stateDir:string;clock?:Clock}):Promise<StateContext> {
 const stateDir=await validatePrivateStatePlacement(options.stateDir);
 await mkdir(stateDir,{recursive:true,mode:0o700});
 const lock=await acquireLock(stateDir,randomUUID());let store:Store|undefined;
 try {
  const config=await readConfig(stateDir);let identity:{instanceId:string}|undefined;
  try {const value:unknown=JSON.parse(await readFile(join(stateDir,'state-identity.json'),'utf8'));if(!value||typeof value!=='object'||!('instanceId' in value)||typeof value.instanceId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instanceId))throw new Error('identity');identity={instanceId:value.instanceId};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new AppError('INVALID_CONFIG','Invalid private state identity; preserve state for inspection');}
  if(identity&&config&&identity.instanceId!==config.instanceId)throw new AppError('INVALID_CONFIG','Private identity and vault configuration disagree');
  const instanceId=identity?.instanceId??config?.instanceId??randomUUID();
  if(!identity){const file=await open(join(stateDir,'state-identity.json'),'wx',0o600);try{await file.writeFile(JSON.stringify({instanceId})+'\n');await file.sync();}finally{await file.close();}const dir=await open(stateDir,'r');try{await dir.sync();}finally{await dir.close();}}
  await lock.identify(instanceId);const clock=options.clock??{now:()=>Date.now()};store=openStore(join(stateDir,'control.sqlite'),clock);
  for(const dir of ['workspaces','staging','recovery','artifacts'])await mkdir(join(stateDir,dir),{recursive:true,mode:0o700});
  const openedStore=store;let closing:Promise<void>|undefined;
  return {instanceId,stateDir,clock,store,close(){return closing??=(async()=>{await openedStore.close();await lock.release();})().catch(error=>{closing=undefined;throw error;});}};
 }catch(error){await store?.close();await lock.release();throw error;}
}
