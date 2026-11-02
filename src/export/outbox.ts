import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AppError, type Json } from '../contracts/base.js';
import type { SessionRecord } from '../runtime/types.js';
import type { TaskRecord } from '../team/types.js';
import { GitClient } from '../git/client.js';
import { safePath } from '../vault/indexes.js';
import { parseConcept } from '../vault/parse.js';
import { component, document, hash, historyDocument, relativeLink } from './history.js';
import { taskStatusDocument } from './status.js';
import { redact } from './redact.js';
import type { Exporter, ExportOptions, ExportReceipt, PublicationIntent, TaskSnapshot } from './types.js';
import { recordLearningSource } from '../learning/capture.js';
import { inspectVaultStart } from '../vault/start.js';
const queues=new WeakMap<ExportOptions['ctx'],Promise<void>>();
export function openExporter({ctx,vault,runtime,baseRevision,policy={}}:ExportOptions):Exporter {
  const actor=`export:${ctx.instanceId}`;
  const bytes=async(path:string)=>{try{return await readFile(await safePath(ctx.vaultDir,path),'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}};
  const conflict=async(path:string)=>{
    const observed=await bytes(path);
    await ctx.store.transact(tx=>{
      const old=tx.get<{observations:Array<{hash:string|null;content:string|null}>}>('export-conflict',path);
      const observations=old?.observations??[];const observedHash=observed===null?null:hash(observed);
      if(!observations.some(item=>item.hash===observedHash))observations.push({hash:observedHash,content:observed});
      tx.put('export-conflict',path,{path,reason:'live_file_changed',reportedAt:new Date(ctx.clock.now()).toISOString(),observations});
    });
  };
  const serial=<T>(fn:()=>Promise<T>)=>{const result=(queues.get(ctx)??Promise.resolve()).then(fn);queues.set(ctx,result.then(()=>{},()=>{}));return result;};
  async function finish(intent:PublicationIntent):Promise<boolean> {
    for(const file of intent.batch.files) {
      // The exporter emits concepts; deletion batches are supported by the public
      // transport type, but deletion/application belongs to the sync engine.
      if(file.content===null)throw new AppError('EXPORT_DELETE','Exporter has no generated deletion to apply');
      const current=await bytes(file.path);
      if(current!==file.content && (current===null?null:hash(current))!==file.baseHash){await conflict(file.path);return false;}
      await vault.propose({id:`${intent.batch.id}:${hash(file.path)}`,path:file.path,expectedRevision:file.baseHash,actor,content:file.content});
      const published=await bytes(file.path);
      if(published!==file.content)throw new AppError('EXPORT_VALIDATION','Published bytes changed before validation');
      parseConcept(file.path,published);
    }
    // Local validation is distinct from confirmed integration into shared Git.
    await ctx.store.transact(tx=>{
      for(const file of intent.batch.files){tx.put<ExportReceipt>('export-file',file.path,{path:file.path,hash:hash(file.content!),content:file.content!,batchId:intent.batch.id});if(file.path.startsWith('history/')&&!file.path.endsWith('/index.md')){const metadata=parseConcept(file.path,file.content!).metadata.lorecrew as Record<string,Json>;tx.put('export-history-item',file.path,{path:file.path,sessionId:metadata.sessionId,metadata});}}
      for(const entry of intent.entries){tx.put('export-entry',`${entry.sessionId}:${entry.entryId}`,{batchId:intent.batch.id});tx.put('export-cursor',entry.sessionId,{entryId:entry.entryId});tx.put('export-history-sequence',entry.sessionId,{sequence:entry.sequence});recordLearningSource(tx,entry.sessionId,{historyPath:`history/${component(ctx.instanceId)}/${component(entry.sessionId)}/${hash(entry.entryId)}.md`});}
      for(const [id,status] of Object.entries(intent.statuses))tx.put('export-status',id,status);
      tx.put('export-batch',intent.batch.id,{...intent,state:'validated'});tx.emit('export.validated',{batchId:intent.batch.id});
    });return true;
  }
  async function flush() {
    // Events are a bounded wake-up journal. Every pass reconciles durable records
    // and transcript cursors, including when this advisory cursor has expired.
    const eventCursor=(await ctx.store.read<{seq:number}>('export-event-cursor',ctx.instanceId))?.seq??0;
    const eventPage=await ctx.store.eventPage(eventCursor,256);
    if(!await ctx.store.read('export-projection-version','current')){const receipts=await ctx.store.list<ExportReceipt>('export-file');const batches=await ctx.store.list<PublicationIntent>('export-batch');await ctx.store.transact(tx=>{for(const receipt of receipts)if(receipt.path.startsWith('history/')&&!receipt.path.endsWith('/index.md')){const metadata=parseConcept(receipt.path,receipt.content).metadata.lorecrew as Record<string,Json>;tx.put('export-history-item',receipt.path,{path:receipt.path,metadata});}for(const item of batches)tx.put('export-batch-index',item.batch.id,{id:item.batch.id,state:item.state,acknowledged:!!item.acknowledged});tx.put('export-projection-version','current',{version:1});});}
    let deferred=false;const deferredSessions=new Set<string>();
    const batchIndex=await ctx.store.list<{id:string;state:string;acknowledged:boolean}>('export-batch-index');
    const order=(await ctx.store.read<string[]>('export-order',ctx.instanceId))??[];
    for(const id of order){const item=batchIndex.find(i=>i.id===id);if(item?.state==='pending'){const intent=await ctx.store.read<PublicationIntent>('export-batch',id);if(intent&&!await finish(intent)){deferred=true;for(const entry of intent.entries)deferredSessions.add(entry.sessionId);}}}
    const sources=await ctx.store.list<{sessionId:string;generation:number}>('session-source');
    const done=new Map((await ctx.store.list<{sessionId:string;generation:number}>('export-source')).map(item=>[item.sessionId,item.generation]));
    const sessionIndex=await ctx.store.list<{sessionId:string;instanceId:string;agentId:string;agentRevision:string;projectId:string|null;finished:boolean;cancelled:boolean;cancellationSettled:boolean}>('runtime-session-index');
    const changed=sources.filter(item=>done.get(item.sessionId)!==item.generation||(!('observationIndexed' in runtime)&&sessionIndex.some(s=>s.sessionId===item.sessionId&&!(s.cancelled?s.cancellationSettled:s.finished))));
    const outstanding=async()=>{const index=await ctx.store.list<{id:string;state:string;acknowledged:boolean}>('export-batch-index');const ids=new Set(index.filter(i=>i.state==='validated'&&!i.acknowledged).map(i=>i.id));const result:PublicationIntent['batch'][]=[];for(const id of order)if(ids.has(id)){const intent=await ctx.store.read<PublicationIntent>('export-batch',id);if(intent)result.push(intent.batch);}return result;};
    // A content-free Device projection must not turn a new vault into a populated
    // one before onboarding reads it. Pending/history recovery always runs above;
    // once content or real work exists, ordinary publication resumes unchanged.
    if(!deferred&&!changed.length&&!sessionIndex.length&&!batchIndex.length&&!(await ctx.store.keys('export-file')).length&&(await inspectVaultStart(ctx.vaultDir)).kind==='new')return outstanding();
    if(!deferred&&!changed.length&&await ctx.store.read('export-initialized',ctx.instanceId)&&!(await ctx.store.read<{retry:boolean}>('export-common-retry',ctx.instanceId))?.retry)return outstanding();
    const revision=await baseRevision();
    if(revision!==null&&!/^[0-9a-f]{40,64}$/i.test(revision))throw new AppError('EXPORT_BASE','Expected a known shared Git commit hash or null');
    const files:PublicationIntent['batch']['files']=[];const preimages:Record<string,string|null>={};const entries:PublicationIntent['entries']=[];const statuses:PublicationIntent['statuses']={};
    const held:Array<{id:string;sessionId:string;entryId:string}>=[];
    const sessions:SessionRecord[]=[];for(const item of changed){const record=await ctx.store.read<SessionRecord>('runtime-session',item.sessionId);if(record?.session.instanceId===ctx.instanceId)sessions.push(record);}
    const local=new Map(sessions.map(r=>[r.session.id,r]));
    const tasks:TaskRecord[]=[];for(const record of sessions)tasks.push(...await ctx.store.scan<TaskRecord>('team-task',{field:'executingSessionId',value:record.session.id}));
    const knownPaths=await ctx.store.keys('export-file');
    const pending:PublicationIntent[]=[];for(const item of batchIndex)if(item.state==='pending'){const intent=await ctx.store.read<PublicationIntent>('export-batch',item.id);if(intent?.state==='pending')pending.push(intent);}
    const pendingPaths=new Set(pending.flatMap(intent=>intent.batch.files.map(file=>file.path)));
    async function offer(path:string,content:string):Promise<boolean> {
      parseConcept(path,content);
      if(redact(content,policy).held){await ctx.store.transact(tx=>tx.put('export-held',`file:${hash(path)}`,{path,reason:'possible_secret'}));return false;}
      if(pendingPaths.has(path)){deferred=true;return false;}
      const current=await bytes(path);const prior=await ctx.store.read<ExportReceipt>('export-file',path);
      if(prior&&current!==prior.content){deferred=true;await conflict(path);return false;}
      if(current===content)return true;
      if(current!==null&&!prior) {
        // Only shared bytes can establish a first preimage. Live human edits are
        // observed locally, never implicitly included in a generated publication.
        const shared=revision===null?undefined:await new GitClient().run(ctx.vaultDir,['show',`${revision}:${path}`]);
        if(shared?.exitCode!==0||shared.stdout!==current){deferred=true;await conflict(path);return false;}
      }
      files.push({path,baseHash:current===null?null:hash(current),content});preimages[path]=current;return true;
    }
    for(const record of sessions) {
      const sessionId=record.session.id;let sequence=(await ctx.store.read<{sequence:number}>('export-history-sequence',sessionId))?.sequence??0;const cursor=await ctx.store.read<{entryId:string}>('export-cursor',sessionId);
      let history;try{history=await runtime.history(sessionId,cursor?.entryId);}catch(error){if(!(error instanceof AppError)||error.code!=='INVALID_CURSOR')throw error;history=await runtime.history(sessionId);}
      for(const entry of history) {
        if(await ctx.store.read('export-entry',`${sessionId}:${entry.id}`))continue;
        const rendered=await historyDocument(ctx,record,entry,policy,sequence+1);
        if(await offer(rendered.path,rendered.content)) {
          entries.push({sessionId,entryId:entry.id,sequence:++sequence});
          if(rendered.held)held.push({id:`${sessionId}:${entry.id}`,sessionId,entryId:entry.id});
        } else {deferredSessions.add(sessionId);break;} // Never advance a session cursor beyond unpublished evidence.
      }
    }
    for(const record of sessions) {
      const prefix=`history/${component(ctx.instanceId)}/${component(record.session.id)}/`;
      const path=`${prefix}index.md`;
      const sources=new Map((await ctx.store.scan<{path:string;metadata:Record<string,Json>}>('export-history-item',{prefix})).map(r=>[r.path,r.metadata]));
      for(const file of files)if(file.path.startsWith(prefix)&&file.path!==path&&file.content!==null)sources.set(file.path,parseConcept(file.path,file.content).metadata.lorecrew as Record<string,Json>);
      if(!sources.size)continue;
      const catalog=[...sources].map(([path,metadata])=>({path,metadata})).sort((a,b)=>Number(a.metadata.sequence)-Number(b.metadata.sequence));
      if(!await offer(path,`# Session history\n\nOrigin: ${ctx.instanceId}; session: ${record.session.id}. Entries are immutable; late results append.\n\n${catalog.map(entry=>`- [${entry.metadata.sequence}. ${entry.metadata.kind} — ${entry.metadata.at}](${relativeLink(path,entry.path)})`).join('\n')}\n`))deferredSessions.add(record.session.id);
    }
    for(const task of tasks) {
      const path=`status/${component(ctx.instanceId)}/${component(task.id)}.md`;
      // A partial batch may already have written this sequence without earning
      // any receipts. Its immutable intent owns the path until recovery settles.
      if(pendingPaths.has(path))continue;
      const record=local.get(task.executingSessionId)!;
      const evidence=[...new Set([...knownPaths,...files.map(f=>f.path)])].filter(p=>p.startsWith(`history/${component(ctx.instanceId)}/${component(task.executingSessionId)}/`)).sort();
      const fingerprint=hash(JSON.stringify({task,evidence,finished:record.finished??false,cancellationSettled:record.cancellationSettled??false}));
      const previous=await ctx.store.read<{fingerprint:string;sequence:number}>('export-status',task.id);
      if(previous?.fingerprint===fingerprint)continue;
      const checked=redact(JSON.stringify(task),policy);const summary=checked.held?'Export held: possible_secret.':`${task.objective}\n\n${task.outcome?JSON.stringify(task.outcome,null,2):'No final outcome reported.'}`;
      const snapshot:TaskSnapshot={agentId:task.agentId,taskId:task.id,instanceId:ctx.instanceId,sequence:(previous?.sequence??0)+1,reportedAt:new Date(ctx.clock.now()).toISOString(),state:task.state,summary,sessionId:task.executingSessionId};
      const current=await bytes(path);
      if(current!==null){const owner=parseConcept(path,current).metadata.lorecrew;if(!owner||typeof owner!=='object'||Array.isArray(owner)||owner.originId!==ctx.instanceId)throw new AppError('EXPORT_ORIGIN','Task snapshot belongs to another origin');}
      const settled=record.finished||record.cancellationSettled;
      const body=`# Reported task: ${task.state}\n\n${summary}\n\nReported by ${ctx.instanceId} at ${snapshot.reportedAt}; snapshot ${snapshot.sequence}.\nExecution settlement: ${settled?'confirmed':'unconfirmed; further results may follow'}.\n\nShared history evidence:\n${evidence.map(p=>`- [History](${relativeLink(path,p)})`).join('\n')}`;
      const content=taskStatusDocument(ctx,path,current??undefined,snapshot,body,checked.held);
      if(await offer(path,content))statuses[task.id]={fingerprint,sequence:snapshot.sequence};else deferredSessions.add(task.executingSessionId);
    }
    // Read-only public projections deliberately contain no bindings, credentials,
    // workspaces, executable assignment grants, or provider envelopes.
    const publicFiles:string[]=[];
    for(const agentId of new Set(sessionIndex.map(s=>s.agentId))) {
      const id=hash(agentId);const path=`agents/${component(ctx.instanceId)}/${id}.md`;const checked=redact(agentId,policy);
      const selected=sessionIndex.filter(r=>r.agentId===agentId);
      const body=checked.held?'Export held: possible_secret.':`# ${agentId}\n\nPinned definitions: ${[...new Set(selected.map(r=>redact(r.agentRevision,policy).text))].join(', ')}\n\nOrigin: ${ctx.instanceId}. Read-only reported projection.`;
      if(await offer(path,document('AgentStatus','Reported agent',{id:`agent-status:${ctx.instanceId}:${id}`,originId:ctx.instanceId},body)))publicFiles.push(path);
    }
    for(const projectId of new Set(sessionIndex.flatMap(s=>s.projectId?[s.projectId]:[]))) {
      const path=`projects/${component(ctx.instanceId)}/${hash(projectId)}.md`;const checked=redact(projectId,policy);
      if(await offer(path,document('ProjectStatus','Reported project',{id:`project-status:${ctx.instanceId}:${hash(projectId)}`,originId:ctx.instanceId},`# ${checked.held?'Export held: possible_secret.':projectId}\n\nOrigin: ${ctx.instanceId}. Read-only reported projection.\nNo executable ownership grant is conveyed.`)))publicFiles.push(path);
    }
    const devicePath=`devices/${component(ctx.instanceId)}.md`;
    const links=[...new Set([...knownPaths,...files.map(f=>f.path),...publicFiles])].filter(p=>p!==devicePath&&p!=='index.md'&&(!p.startsWith('history/')||p.endsWith('/index.md'))).sort();
    await offer(devicePath,document('Device','Reported device',{id:`device:${ctx.instanceId}`,originId:ctx.instanceId},`# Device ${ctx.instanceId}\n\nLast reported state from this origin. Remote execution controls are unavailable.\n\n${links.map(p=>`- [${p.startsWith('history/')?'History':p.startsWith('status/')?'Task status':p.startsWith('agents/')?'Agent':'Project'}](${relativeLink(devicePath,p)})`).join('\n')}`));
    // Per-origin Device documents remain discoverable through the workspace.
    // Automatic exports do not edit the user's shared root index: concurrent
    // origins appending generated links would create artificial text conflicts.
    if(files.length) {
      const intent:PublicationIntent={batch:{id:randomUUID(),originId:ctx.instanceId,baseRevision:revision,files,createdAt:new Date(ctx.clock.now()).toISOString()},preimages,state:'pending',entries,statuses};
      await ctx.store.transact(tx=>{tx.insert('export-batch',intent.batch.id,intent);tx.put('export-order',ctx.instanceId,[...(tx.get<string[]>('export-order',ctx.instanceId)??[]),intent.batch.id]);for(const entry of held)tx.put('export-held',entry.id,{sessionId:entry.sessionId,entryId:entry.entryId,reason:'possible_secret'});});
      if(!await finish(intent)){deferred=true;for(const entry of intent.entries)deferredSessions.add(entry.sessionId);}
    }
    await ctx.store.transact(tx=>tx.put('export-event-cursor',ctx.instanceId,{seq:eventPage.maxSeq,reconciledFromRecords:eventCursor<eventPage.minSeq-1}));
    await ctx.store.transact(tx=>{for(const source of changed)if(!deferredSessions.has(source.sessionId))tx.put('export-source',source.sessionId,source);tx.put('export-common-retry',ctx.instanceId,{retry:deferred});tx.put('export-initialized',ctx.instanceId,{initialized:true});});
    // The newly created batch is appended after the initial order snapshot.
    const finalOrder=await ctx.store.read<string[]>('export-order',ctx.instanceId)??[];order.splice(0,order.length,...finalOrder);return outstanding();
  }
  return {flush:()=>serial(flush),acknowledge:id=>serial(async()=>{
    await ctx.store.transact(tx=>{const intent=tx.get<PublicationIntent>('export-batch',id);if(!intent||intent.batch.originId!==ctx.instanceId||intent.state!=='validated')throw new AppError('EXPORT_BATCH','Only a validated local batch can be acknowledged');tx.put('export-batch',id,{...intent,acknowledged:true});});
  })};
}
