import { AppError, type Json } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { TaskSnapshot } from './types.js';
import { document } from './history.js';
import { parseConcept, patchContent } from '../vault/parse.js';
const start='<!-- lorecrew:generated:start -->';const end='<!-- lorecrew:generated:end -->';
/** Preserve human metadata and text outside the explicitly generated region. */
export function statusContent(path:string,original:string|undefined,metadata:Record<string,Json>,body:string):string {
  const generated=`${start}\n${body}\n${end}`;
  if(original===undefined)return document('TaskStatus','Reported task status',metadata,generated);
  const match=original.match(/<!-- lorecrew:generated:start -->[\s\S]*?<!-- lorecrew:generated:end -->/);
  const boundary=original.indexOf('\n---',4);const currentBody=original.slice(boundary+4).replace(/^\r?\n/,'');
  return patchContent(path,original,{metadata:{lorecrew:metadata},body:match?currentBody.replace(match[0],generated):`${generated}\n${currentBody}`});
}
/** One origin owns each replaceable status; imported statuses never become local controls. */
export function taskStatusDocument(ctx:InstanceContext,path:string,original:string|undefined,snapshot:TaskSnapshot,body:string,held:boolean):string {
  if(snapshot.instanceId!==ctx.instanceId)throw new AppError('EXPORT_ORIGIN','Only the originating instance may write its task status');
  const metadata=original===undefined?undefined:parseConcept(path,original).metadata.lorecrew;
  if(original!==undefined&&(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||metadata.originId!==ctx.instanceId))throw new AppError('EXPORT_ORIGIN','Existing snapshot has another origin');
  const previous=metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?metadata:{};
  if(typeof previous.sequence==='number'&&snapshot.sequence<=previous.sequence)throw new AppError('EXPORT_SEQUENCE','Snapshot sequence must increase');
  return statusContent(path,original,{...previous,id:`task-status:${ctx.instanceId}:${snapshot.taskId}`,originId:ctx.instanceId,...snapshot,...held?{exportReason:'possible_secret'}:{}},body);
}
