import type {StateContext} from '../instance/state.js';
import type {RepositoryRef} from './types.js';
import type {GitClient} from '../git/client.js';
import {creationOperations} from './create.js';
import {checkpointOperations} from './checkpoint.js';
import {inspectRepository} from './inspect.js';
import {discoverRepositoryTarget} from './target.js';
import {remoteOperations} from './remote.js';
import {integrationOperations} from './integrate-history.js';
export function openRepositories({state,git,validateIntegration}:{state:StateContext;git:GitClient;validateIntegration?:(repo:RepositoryRef,commit:string)=>Promise<void>}){const remote=remoteOperations(state,git);return {...creationOperations(state,git),...checkpointOperations(state,git),fetch:remote.fetch,publish:remote.publish,reconcilePublication:remote.reconcilePublication,verifyPublication:remote.verifyPublication,status:remote.status,confirmRepositoryTarget:remote.confirmRepositoryTarget,...integrationOperations(state,git,validateIntegration),async inspect(path:string){const view=await inspectRepository(git,path);if(view.snapshot){const target=await discoverRepositoryTarget(git,path,view.snapshot).catch(()=>undefined);if(target)view.target=target;}return view;}};}
export type RepositoryService=ReturnType<typeof openRepositories>;
