import { assertExecutionContext, assertContextAdmission, type ExecutionContext } from './context.js';
import { assertRestoredExecutionAllowed } from '../instance/recovery.js';
import { assertWorkloadWorkspace } from '../learning/tools.js';
import { assertWorkloadAdmission } from '../projects/workload-grants.js';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../contracts/base.js';
import type { ProjectAdmission } from '../projects/types.js';
import type { InstanceContext } from '../instance/open.js';
import type { HostProcessRecord, ProcessIdentity, ProcessProbe, WorkspaceRecord, WorkloadWorkspace } from './types.js';

const launchTails=new WeakMap<object,Promise<unknown>>();
function launchSerial<T>(ctx:InstanceContext,fn:()=>Promise<T>):Promise<T>{const result=(launchTails.get(ctx.store)??Promise.resolve()).then(fn);launchTails.set(ctx.store,result.catch(()=>{}));return result;}
const marker = 'LORECREW_PROCESS_TOKEN';
const identityKey=(item:ProcessIdentity) => `${item.pid}:${item.start}`;
const opaqueAfterLaunch=(record:HostProcessRecord,items:ProcessIdentity[]) => !record.opaqueBefore || items.some(item=>item.markerReadable===false && !record.opaqueBefore!.includes(identityKey(item)));
const alive = (item: ProcessIdentity) => item.state !== 'Z' && item.state !== 'X';
/** Host supervision, not a security sandbox. Commands must preserve inherited process evidence.
 * Linux /proc supplies process identity and inherited markers; unsupported/hidden evidence fails closed.
 * A stronger platform supervisor (e.g. cgroups) can implement ProcessProbe without changing admission callers.
 */
export class LinuxProcessProbe implements ProcessProbe {
  /** An alternate mounted proc filesystem may be supplied by the host integration. */
  constructor(private readonly procRoot='/proc') {}
  async snapshot(): Promise<{processes: ProcessIdentity[]; complete: boolean; reason?: string}> {
    if (process.platform !== 'linux') return {processes:[],complete:false,reason:'Process evidence unavailable on this platform'};
    const processes: ProcessIdentity[]=[]; let complete=true;
    let entries: string[];
    try { entries=await readdir(this.procRoot); } catch { return {processes,complete:false,reason:'Cannot inspect /proc'}; }
    await Promise.all(entries.filter(value=>/^\d+$/.test(value)).map(async value=> {
      try {
        const dir=join(this.procRoot,value);
        if ((await stat(dir)).uid !== process.getuid!()) return;
        const content=await readFile(`${dir}/stat`,'utf8');
        const fields=content.slice(content.lastIndexOf(')')+2).trim().split(/\s+/);
        const item: ProcessIdentity={pid:Number(value),state:fields[0]!,parentPid:Number(fields[1]),groupId:Number(fields[2]),start:fields[19]!};
        if (!alive(item)) return;
        try {
          const env=await readFile(`${dir}/environ`,'utf8');
          const token=env.split('\0').find(value=>value.startsWith(`${marker}=`))?.slice(marker.length+1);
          if (token) item.token=token;
        } catch (error) {
          if (['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return;
          // Preserve the identity: old opaque services are baselined, newly opaque processes are uncertain.
          item.markerReadable=false;
        }
        processes.push(item);
      } catch (error) {
        // Exit races are normal. Inaccessible same-user processes are uncertain evidence.
        if (!['ENOENT','ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) complete=false;
      }
    }));
    return {processes,complete,...(!complete ? {reason:'Some host process evidence is inaccessible'} : {})};
  }
}

export class ProcessSupervisor {
  constructor(private readonly ctx: InstanceContext, private readonly probe: ProcessProbe = new LinuxProcessProbe()) {}
  async run(input: {contextId: string; command: string; requestId: string}): Promise<{exitCode: number; output: string; artifactPath?: string}> {
    await assertRestoredExecutionAllowed(this.ctx);
    if (!input.command.trim() || !input.requestId) throw new AppError('INVALID_COMMAND','Command and request ID are required');
    const execution=await assertExecutionContext(this.ctx,input.contextId);
    const owner=execution.owner;
    const projectId=owner.kind==='project'?owner.projectId:undefined;
    const workspaceId=owner.kind!=='session'?owner.workspaceId:undefined;
    const id=createHash('sha256').update(input.requestId).digest('hex');
    const artifactPath=join(this.ctx.stateDir,'artifacts',`process-${id}.log`);
    const before=await this.probe.snapshot();
    const launch=await launchSerial(this.ctx,async()=>{
    await assertExecutionContext(this.ctx,input.contextId);
    const record: HostProcessRecord={opaqueBefore:before.processes.filter(item=>item.markerReadable===false).map(identityKey),baselineComplete:before.complete,id,contextId:execution.id,sessionId:execution.sessionId,...(owner.kind==='workload'?{workloadId:owner.workloadId}:projectId?{projectId}:{}),...(workspaceId?{workspaceId}:{}),command:input.command,token:randomUUID(),state:'launching',artifactPath};
    await this.ctx.store.transact(tx=> {
      assertContextAdmission(this.ctx,tx,input.contextId);
      if (tx.get('host-process',id)) throw new AppError('REQUEST_REUSED','A launched process request cannot be repeated');
      tx.insert('host-process',id,record);
      if(workspaceId)tx.put('workspace-processes',workspaceId,[...(tx.get<string[]>('workspace-processes',workspaceId) ?? []),id]);
    });
    const file=await open(artifactPath,'wx+',0o600);
    let child;
    try {
      child=spawn('/bin/sh',['-c',input.command],{cwd:execution.cwd,detached:true,shell:false,env:{...process.env,[marker]:record.token},stdio:['ignore',file.fd,file.fd]});
    } catch (error) { await file.close(); throw error; }
    const outcome=new Promise<{code:number;error?:string}>(resolve=> {
      child.once('error',error=>resolve({code:1,error:error.message}));
      child.once('exit',(code,signal)=>resolve({code:code ?? (signal ? 128 : 1)}));
    });
    if (child.pid !== undefined) record.pid=child.pid;
      const snapshot=await this.probe.snapshot();
      const root=snapshot.processes.find(item=>item.pid===record.pid && item.token===record.token);
      if (root) record.start=root.start;
      record.state='running';
      await this.ctx.store.transact(tx=>tx.put('host-process',id,record));
      return {record,file,outcome};
    });
    const {record,file,outcome}=launch;
    try {
      const result=await outcome;
      const after=await this.probe.snapshot();
      const escaped=after.processes.some(item=>item.token===record.token && item.groupId!==record.pid);
      const unknown=after.processes.some(item=>item.groupId===record.pid && item.token!==record.token);
      const opaque=opaqueAfterLaunch(record,after.processes);
      record.settled=before.complete && after.complete && !opaque && !after.processes.some(item=>item.token===record.token || item.groupId===record.pid);
      record.state=!before.complete || !after.complete || opaque || escaped || unknown ? 'uncertain' : 'exited';
      if (opaque) record.reason='New opaque process identity makes descendants uncertain';
      if (!before.complete) record.reason=before.reason ?? 'Incomplete process visibility before launch';
      if (unknown) record.reason='Unknown descendant in process group';
      if (escaped) record.reason='Escaped descendant is outside the journaled process group';
      if (!after.complete) record.reason=after.reason ?? 'Incomplete process evidence';
      await this.ctx.store.transact(tx=> {
        const current=tx.get<HostProcessRecord>('host-process',id);
        // The exit probe may have started before a concurrent stop proved quiescence.
        // Never overwrite that completed proof (or a recorded uncertainty) with stale run state.
        if(current?.state==='stopped'||current?.state==='uncertain')return;
        tx.put('host-process',id,record);
      });
      await file.sync();
      // Read only a bounded prefix; the full output stays in the local artifact, including later child writes.
      const buffer=Buffer.alloc(8192); const read=await file.read(buffer,0,buffer.length,0);
      const output=buffer.subarray(0,read.bytesRead).toString('utf8');
      return {exitCode:result.code,output:result.error ? `${result.error}\n${output}` : output,artifactPath};
    } finally { await file.close(); }
  }
  async stopContext(contextId:string):Promise<{quiescent:boolean;reason?:string}>{
    await launchSerial(this.ctx,()=>this.ctx.store.transact(tx=>{
      const c=tx.get<ExecutionContext>('execution-context',contextId);if(!c)throw new AppError('CONTEXT_NOT_FOUND','Unknown execution context');
      tx.put('execution-context-fence',contextId,{stopped:true});if(c.state==='active')tx.put('execution-context',contextId,{...c,state:'draining'});
    }));
    const proof=await this.stopRecords((await this.ctx.store.list<HostProcessRecord>('host-process')).filter(p=>p.contextId===contextId));
    if(proof.quiescent)await this.ctx.store.transact(tx=>{const c=tx.get<ExecutionContext>('execution-context',contextId)!;tx.put('execution-context',contextId,{...c,state:'stopped'});});
    return proof;
  }
  async stopWorkload(workloadId:string):Promise<{quiescent:boolean;reason?:string}>{
    const workspaces=(await this.ctx.store.list<WorkloadWorkspace>('workload-workspace')).filter(w=>w.workloadId===workloadId);
    await launchSerial(this.ctx,()=>this.ctx.store.transact(tx=>{for(const workspace of workspaces)tx.put('workspace-process-fence',workspace.id,{stopped:true});}));
    return this.stopRecords((await this.ctx.store.list<HostProcessRecord>('host-process')).filter(p=>p.workloadId===workloadId));
  }
  async stop(projectId: string,purpose?:{promotionId:string}): Promise<{quiescent:boolean;reason?:string}> {
    await launchSerial(this.ctx,()=>this.ctx.store.transact(tx=>{const generation=tx.get<{assignment:{generation:number}}>('assignment-grants',projectId)?.assignment.generation;const previous=tx.get<{generation?:number;promotionId?:string}>('process-fence',projectId);tx.put('process-fence',projectId,{stopped:true,...(generation!==undefined?{generation:Math.max(generation,previous?.generation??0)}:{}),...(purpose&&(!previous||previous.promotionId===purpose.promotionId)?{promotionId:purpose.promotionId}:{})});}));
    return this.stopRecords((await this.ctx.store.list<HostProcessRecord>('host-process')).filter(item=>item.projectId===projectId));
  }
  async stopWorkspace(workspaceId:string):Promise<{quiescent:boolean;reason?:string}> {
    await launchSerial(this.ctx,()=>this.ctx.store.transact(tx=>tx.put('workspace-process-fence',workspaceId,{stopped:true})));
    return this.stopRecords((await this.ctx.store.list<HostProcessRecord>('host-process')).filter(item=>item.workspaceId===workspaceId));
  }
  private async stopRecords(records:HostProcessRecord[]):Promise<{quiescent:boolean;reason?:string}> {
    let uncertain: string | undefined;
    for (let record of records) {
      // A concurrent local launch may be publishing its PID; wait briefly, never infer completion from timeout.
      for (let i=0;record.state==='launching' && i<20;i++) {
        await delay(10);
        record=(await this.ctx.store.read<HostProcessRecord>('host-process',record.id)) ?? record;
      }
      const snapshot=await this.probe.snapshot();
      if (!snapshot.complete) { uncertain=snapshot.reason ?? 'Incomplete process evidence'; continue; }
      if (opaqueAfterLaunch(record,snapshot.processes) || record.baselineComplete===false) { uncertain='Opaque process identity or missing baseline makes descendants uncertain'; continue; }
      if (record.state==='launching' || record.state==='uncertain') { uncertain=record.reason ?? 'Uncertain launch or descendant evidence'; continue; }
      const marked=snapshot.processes.filter(item=>item.token===record.token);
      if (marked.some(item=>item.groupId!==record.pid)) { uncertain='Escaped descendant cannot establish quiescence'; continue; }
      const group=snapshot.processes.filter(item=>item.groupId===record.pid);
      const root=group.find(item=>item.pid===record.pid);
      if (record.state==='running' && (!root || !record.start || root.start!==record.start)) {
        uncertain='Running process identity was lost; descendants are uncertain'; continue;
      }
      if (group.some(item=>item.token!==record.token)) { uncertain='Unknown descendant in process group'; continue; }
      if (group.length) {
        try { process.kill(-record.pid!,'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code!=='ESRCH') { uncertain='Cannot signal process group'; continue; } }
        let remaining=true;
        for (let i=0;i<40;i++) {
          await delay(10);
          const next=await this.probe.snapshot();
          if (!next.complete || opaqueAfterLaunch(record,next.processes)) { uncertain='Cannot verify stopped descendants or new opaque identity'; break; }
          const members=next.processes.filter(item=>item.groupId===record.pid || item.token===record.token);
          if (!members.length) { remaining=false; break; }
          if (members.some(item=>item.token!==record.token || item.groupId!==record.pid)) { uncertain='Unknown or escaped descendant'; break; }
          if (i===19) { try {process.kill(-record.pid!,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH') uncertain='Cannot kill process group';} }
        }
        if (remaining) { uncertain ??='Process group remains live'; continue; }
      }
      await this.ctx.store.transact(tx=> {
        const current=tx.get<HostProcessRecord>('host-process',record.id);
        if (current?.state==='uncertain') { uncertain=current.reason ?? 'Uncertain descendants'; return; }
        tx.put('host-process',record.id,{...record,state:'stopped'});
      });
    }
    return uncertain ? {quiescent:false,reason:uncertain} : {quiescent:true};
  }
}
