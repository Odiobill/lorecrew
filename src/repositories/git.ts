import { randomUUID } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { GitClient, GitRunOptions } from '../git/client.js';
import type { StateContext } from '../instance/state.js';
import { LinuxProcessProbe } from '../workspaces/processes.js';
interface ChildEvidence {id:string;token:string;pid?:number;opaqueBefore:string[];baselineComplete:boolean;settled:boolean}
const identity=(p:{pid:number;start:string})=>`${p.pid}:${p.start}`;
export async function assertRepositoryChildrenStopped(state:StateContext,onlyId?:string){
 const records=await state.store.list<ChildEvidence>('repository-child');if(!records.length)return;
 const snapshot=await new LinuxProcessProbe().snapshot();
 for(const r of records)if(!r.settled&&(!onlyId||r.id===onlyId)){if(!snapshot.complete||!r.baselineComplete||snapshot.processes.some(p=>p.token===r.token||p.groupId===r.pid||p.markerReadable===false&&!r.opaqueBefore.includes(identity(p))))throw new AppError('REPOSITORY_UNCERTAIN','Git child or descendant outcome is not positively stopped');await state.store.transact(tx=>tx.put('repository-child',r.id,{...r,settled:true}));}
}
export async function runRepositoryGit(state:StateContext,git:GitClient,cwd:string,args:string[],options:GitRunOptions={}){
 if(options.processToken)return git.run(cwd,args,options);
 const probe=new LinuxProcessProbe();const before=await probe.snapshot();if(!before.complete)throw new AppError('REPOSITORY_UNCERTAIN','Host cannot provide positive Git process evidence');
 const r:ChildEvidence={id:randomUUID(),token:randomUUID(),opaqueBefore:before.processes.filter(p=>p.markerReadable===false).map(identity),baselineComplete:before.complete,settled:false};
 await state.store.transact(tx=>tx.put('repository-child',r.id,r));
 try{return await git.run(cwd,args,{...options,processToken:r.token,onSpawn:async pid=>{r.pid=pid;await state.store.transact(tx=>tx.put('repository-child',r.id,r));await options.onSpawn?.(pid);}});}
 finally{await assertRepositoryChildrenStopped(state,r.id);}
}

/** Preserve injected transports/options while attaching positive child evidence once. */
export function trackedRepositoryGit(state:StateContext,git:GitClient):GitClient{return {run:(cwd,args,options={})=>runRepositoryGit(state,git,cwd,['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],options)};}
