import type { InstanceContext } from '../instance/open.js';
import { AppError } from '../contracts/base.js';
import { assertAdmission, requestId, stableId } from './admission.js';
import type { SessionRecord, SubmissionRecord } from './types.js';
export async function enqueue(ctx:InstanceContext,session:SessionRecord,input:{requestId:string;text:string}) {
  requestId(input.requestId);
  if(typeof input.text!=='string'||!input.text.trim())throw new AppError('INVALID_INPUT','A nonempty message is required');
  const id=stableId(session.session.id,input.requestId);
  return ctx.store.transact(tx=>{
    const old=tx.get<SubmissionRecord>('runtime-submission',id);
    if(old) {if(old.text!==input.text)throw new AppError('REQUEST_CONFLICT','Submission ID already names different text');return old;}
    assertAdmission(ctx,tx,session);
    const record:SubmissionRecord={id,sessionId:session.session.id,...input};
    tx.insert('runtime-submission',id,record);tx.insert('runtime-outbox',id,record);return record;
  });
}
export async function receipt(ctx:InstanceContext,record:SubmissionRecord,piId:number) {
  await ctx.store.transact(tx=>{
    tx.put('runtime-submission',record.id,{...record,piId});
    tx.delete('runtime-outbox',record.id);
    tx.emit('runtime.admitted',{sessionId:record.sessionId,submissionId:record.id});
  });
}
