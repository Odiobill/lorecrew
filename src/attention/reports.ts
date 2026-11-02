import { isAbsolute } from 'node:path';
import { AppError } from '../contracts/base.js';
import { assertAdmission,stableId } from '../runtime/admission.js';
import type { SessionRecord } from '../runtime/types.js';
import type { TaskRecord } from '../team/types.js';
import type { InboxOptions,InboxResultRef,ReportResultInput,StoredResult } from './types.js';
import { attentionOrigin,outcomeId } from './origin.js';
import { revision } from './revision.js';
function validate(input:ReportResultInput){
 if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['kind','title','body','sourcePaths','expectedRevision'].includes(k))||!['report','finding'].includes(input.kind)||typeof input.title!=='string'||!input.title.trim()||input.title.length>200||typeof input.body!=='string'||!input.body.trim()||input.body.length>30000||!Array.isArray(input.sourcePaths)||input.sourcePaths.length>50||input.sourcePaths.some(p=>typeof p!=='string'||!p||p.length>1024||isAbsolute(p)||/[\\\0?#:]/.test(p)||p.split('/').some(s=>!s||s==='.'||s==='..'))||input.expectedRevision!==null&&(typeof input.expectedRevision!=='string'||!input.expectedRevision||input.expectedRevision.length>128))throw new AppError('INVALID_REQUEST','Report content or source paths are invalid');
}
/** Called with actual Pi identity. Origin, ownership and cancellation never come from tool arguments. */
export async function reportResult({ctx,vault}:InboxOptions,caller:SessionRecord,input:ReportResultInput,requestId:string):Promise<InboxResultRef>{
 validate(input);if(!requestId)throw new AppError('INVALID_REQUEST','Stable report request required');
 const record=await ctx.store.read<SessionRecord>('runtime-session',caller.session.id);
 if(!record||record.session.instanceId!==ctx.instanceId||record.conversationId!==caller.conversationId)throw new AppError('REPORT_SCOPE_REQUIRED','Only an actual background producer can publish a result');
 const source=await attentionOrigin(ctx,{sessionId:record.session.id});
 const task=record.input.teamTaskId?await ctx.store.read<TaskRecord>('team-task',record.input.teamTaskId):undefined;
 const eligible=source.kind==='schedule'?(task?!task.parentTaskId&&task.executingSessionId===record.session.id:!record.input.teamTaskId):source.kind==='workload'&&record.input.background&&record.input.workload?.workloadId===record.session.workloadId;
 if(!eligible)throw new AppError('REPORT_SCOPE_REQUIRED','Report results require a scheduled root or assigned background workload');
 const key=stableId(record.session.id,requestId),fingerprint=revision(input),receipt=await ctx.store.read<{fingerprint:string;ref:InboxResultRef}>('inbox-report-request',key);
 // An old receipt remains replayable if its original source documents were later removed.
 if(!receipt)for(const path of input.sourcePaths)await vault.read(path);
 const paths=[...new Set(input.sourcePaths)].sort(),id=outcomeId(source),title=input.title.trim(),rev=revision({kind:input.kind,title,body:input.body,sourcePaths:paths});
 return ctx.store.transact(tx=>{
  const actual=tx.get<SessionRecord>('runtime-session',record.session.id);if(!actual)throw new AppError('REPORT_SCOPE_REQUIRED','Producer no longer exists');assertAdmission(ctx,tx,actual);
  const old=tx.get<{fingerprint:string;ref:InboxResultRef}>('inbox-report-request',key);if(old){if(old.fingerprint!==fingerprint)throw new AppError('REQUEST_CONFLICT','Report request names different content');return old.ref;}
  const current=tx.get<StoredResult>('inbox-result',id);if((current?.revision??null)!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Report changed; use its current revision to replace it');
  const value:StoredResult={id,revision:rev,source,title,content:{body:input.body},sourcePaths:paths,kind:input.kind,sessionId:record.session.id};
  if(current?.revision!==rev){tx.put('inbox-result',id,value);tx.put('inbox-result-version',stableId(id,rev),value);tx.emit('inbox.updated',{id});}
  const ref={id,revision:rev};tx.put('inbox-report-request',key,{fingerprint,ref});return ref;
 });
}
