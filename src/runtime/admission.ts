import { assertAuthorityScope } from '../projects/authority-domain.js';
import { assertWorkloadAdmission } from '../projects/workload-grants.js';
import { createHash } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { Tx } from '../storage/store.js';
import type { InstanceContext } from '../instance/open.js';
import type { Assignment, ProjectAdmission } from '../projects/types.js';
import type { SessionRecord } from './types.js';
export const stableId=(...parts:string[])=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export function requestId(id:string) {if(typeof id!=='string'||!id.trim())throw new AppError('INVALID_REQUEST','A stable nonempty request ID is required');}
export function assertAdmission(ctx:InstanceContext,tx:Tx,record:SessionRecord) {
 if(tx.get('repository-retired-session',record.session.id))throw new AppError('MIGRATION_REQUIRED','This legacy session is retained as stopped history; create a fresh task after conversion');
  if(record.session.projectId||record.input?.workload)assertAuthorityScope(tx,record.authority);
  if(record.cancelled || tx.get<SessionRecord>('runtime-session',record.session.id)?.cancelled) throw new AppError('SESSION_CANCELLED','Session admission is closed');
  if(record.input?.workload?.workloadId==='curator'&&tx.get('curator-reassignment','pending'))throw new AppError('ADMISSION_CLOSED','Curator assignment is changing');
  if(record.input?.workload)assertWorkloadAdmission(ctx,tx,record.input.workload.workloadId,record.input.workload.generation);
  const project=record.session.projectId;
  if(!project)return;
  const fence=tx.get<{generation:number}>('runtime-project-fence',project);
  const generation=record.generation??tx.get<{assignment:Assignment}>('assignment-grants',project)?.assignment.generation??0;
  if(tx.get<ProjectAdmission>('project-admission',project)?.closed || (fence && generation<=fence.generation))throw new AppError('ADMISSION_CLOSED','Project runtime admission is closed');
  if(record.generation!==undefined) {
    if(tx.get('assignment-revocations',JSON.stringify([project,record.generation])))throw new AppError('OWNER_REVOKED','Session generation was revoked');
    const grant=tx.get<{assignment:Assignment}>('assignment-grants',project)?.assignment;
    if(grant?.generation!==record.generation || grant.ownerId!==ctx.instanceId)throw new AppError('NOT_OWNER','Session generation is no longer locally owned');
  }
}
