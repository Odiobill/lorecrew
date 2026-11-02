import { randomUUID } from 'node:crypto';
import { AppError } from '../../contracts/base.js';
import type { InstanceContext } from '../../instance/open.js';
import type { PreviewRecord, SourceRecord } from './types.js';
const kinds=['skill-import-source','skill-import-preview','skill-draft-review'];
function expiry(record:Record<string,unknown>){return Date.parse(String(record.expiresAt??(record.nativeImport as {expiresAt?:string})?.expiresAt??''));}
/** Shared quota with final candidate reviews; only local transient records are pruned. */
const queues=new WeakMap<InstanceContext,Promise<void>>();
export function stageRecord(ctx:InstanceContext,kind:string,id:string,principalId:string,value:unknown):Promise<void>{
 const run=(queues.get(ctx)??Promise.resolve()).then(async()=>{
 const records=(await Promise.all(kinds.map(async kind=>(await ctx.store.keys(kind)).map(id=>({kind,id}))))).flat();const entries=await Promise.all(records.map(async entry=>({...entry,value:(await ctx.store.read<Record<string,unknown>>(entry.kind,entry.id))!})));
 const bytes=(v:unknown)=>{const r=v as Record<string,any>,texts=r.texts??r.native?.texts;return texts?Object.values(texts).reduce<number>((n,text)=>n+Buffer.byteLength(String(text)),0):Buffer.byteLength(String(r.fields?.body??''));};
 await ctx.store.transact(tx=>{for(const e of entries)if(expiry(e.value)<=ctx.clock.now())tx.delete(e.kind,e.id);const live=entries.filter(e=>expiry(e.value)>ctx.clock.now()&&e.value.principalId===principalId);if(live.length>=8)throw new AppError('PREVIEW_LIMIT','Eight preview/review records are already retained. Discard a preview or wait for expiry.');if(live.reduce((n,e)=>n+bytes(e.value),0)+bytes(value)>16*1024*1024)throw new AppError('PREVIEW_LIMIT','Preview staging exceeds 16 MiB. Discard a preview or narrow the source.');tx.insert(kind,id,value);});
 });queues.set(ctx,run.catch(()=>{}));return run;
}
export async function staged<T extends SourceRecord|PreviewRecord>(ctx:InstanceContext,kind:string,id:string,principalId:string):Promise<T>{const value=await ctx.store.read<T>(kind,id);const expires=value&&('expiresAt' in value?value.expiresAt:value.nativeImport.expiresAt);if(!value||value.principalId!==principalId||Date.parse(expires!)<=ctx.clock.now())throw new AppError('PREVIEW_UNAVAILABLE','Preview expired or belongs to another pairing. Refresh source explicitly.');return value;}
export async function readPreviewFile(ctx:InstanceContext,principalId:string,id:string,path:string){const r=await staged<PreviewRecord>(ctx,'skill-import-preview',id,principalId),entry=r.nativeImport.files.find(e=>e.originalPath===path),contentText=Object.hasOwn(r.texts,path)?r.texts[path]:undefined;if(!entry||contentText===undefined)throw new AppError('NOT_FOUND','This preview has no inspectable text at that path');return {originalPath:path,kind:entry.kind,contentText,sha256:entry.sha256};}
export async function discardPreview(ctx:InstanceContext,principalId:string,id:string){for(const kind of ['skill-import-source','skill-import-preview','skill-draft-review']){const r=await ctx.store.read<{principalId:string}>(kind,id);if(r){if(r.principalId!==principalId)throw new AppError('PREVIEW_UNAVAILABLE','Preview belongs to another pairing');await ctx.store.transact(tx=>tx.delete(kind,id));return;}}throw new AppError('NOT_FOUND','Preview unavailable');}
export async function clonePreview(ctx:InstanceContext,principalId:string,record:PreviewRecord){const id=randomUUID(),value={...record,principalId,nativeImport:{...record.nativeImport,previewId:id,expiresAt:new Date(ctx.clock.now()+3_600_000).toISOString()}};await stageRecord(ctx,'skill-import-preview',id,principalId,value);return value;}
