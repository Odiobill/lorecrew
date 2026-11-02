import {DatabaseSync} from 'node:sqlite';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import type {StateContext} from '../instance/state.js';
import {LinuxProcessProbe} from '../workspaces/processes.js';
import type {HostProcessRecord} from '../workspaces/types.js';
/** Cold/read-only inspection: never opens a harness, polls work, signals or steals locks. */
export async function readStoppedExecutionProof(ctx:StateContext):Promise<{quiescent:boolean;reason?:string}>{
 const no=(reason:string)=>({quiescent:false,reason});
 if((await ctx.store.list<{state:string}>('team-task')).some(t=>!['completed','cancelled','failed'].includes(t.state))||(await ctx.store.list('team-task-outbox')).length||(await ctx.store.list('team-outbox')).length)return no('Pending task/admission envelopes require the original owner to stop/export them without replay');
 if((await ctx.store.list<{state:string}>('runtime-effect')).some(r=>r.state!=='settled'))return no('Unresolved tool effects require the original owner to stop and verify');
 if((await ctx.store.list<{piId?:number;cancelled?:boolean}>('runtime-outbox')).some(r=>!r.cancelled))return no('Pending submissions must be settled by the original owner without replay');
 for(const record of await ctx.store.list<{session:{projectId?:string};finished?:boolean;cancelled?:boolean;cancellationSettled?:boolean;executionContextId?:string}>('runtime-session'))if(record.session.projectId&&!record.finished&&!(record.cancelled&&record.cancellationSettled)){const execution=record.executionContextId?await ctx.store.read<{state:string}>('execution-context',record.executionContextId):undefined;if(execution?.state!=='stopped')return no('An old scoped session has no positive stopped boundary');}
 const probe=await new LinuxProcessProbe().snapshot();if(!probe.complete)return no(probe.reason??'Process evidence unavailable');
 for(const r of await ctx.store.list<HostProcessRecord>('host-process')){if(r.state==='uncertain'||r.state==='launching'||r.baselineComplete===false)return no('Uncertain host process evidence');if(r.state!=='stopped'&&!(r.state==='exited'&&r.settled))return no('Host command lacks a positive stop receipt');if(probe.processes.some(p=>p.token===r.token||p.groupId===r.pid||p.markerReadable===false&&!(r.opaqueBefore??[]).includes(`${p.pid}:${p.start}`)))return no('Live or newly opaque descendants prevent stopped conversion');}
 for(const r of await ctx.store.list<{token:string;pid?:number;settled:boolean;baselineComplete:boolean;opaqueBefore:string[]}>('repository-child'))if(!r.baselineComplete||probe.processes.some(p=>p.token===r.token||p.groupId===r.pid||p.markerReadable===false&&!r.opaqueBefore.includes(`${p.pid}:${p.start}`)))return no('Git descendants remain unconfirmed');
 const path=join(ctx.stateDir,'pi.sqlite');try{await lstat(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {quiescent:true};throw e;}
 let db:DatabaseSync|undefined;try{db=new DatabaseSync(path,{readOnly:true});if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')return no('Pi store integrity is uncertain');for(const table of ['tasks','submissions'])if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table))return no('Unknown Pi storage format');if(db.prepare("SELECT id FROM tasks WHERE status!='terminal' LIMIT 1").get()||db.prepare("SELECT id FROM submissions WHERE status IN ('queued','placed') LIMIT 1").get())return no('Pi retains executable work; use the original owner to stop/export it');return {quiescent:true};}catch{return no('Cannot inspect cold Pi evidence');}finally{db?.close();}
}
