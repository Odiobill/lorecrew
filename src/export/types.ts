import type { InstanceContext } from '../instance/open.js';
import type { Runtime } from '../runtime/types.js';
import type { Vault } from '../vault/types.js';
export interface PublicationBatch {actor?:string;id:string;originId:string;baseRevision:string|null;files:Array<{path:string;baseHash:string|null;content:string|null}>;createdAt:string}
export interface TaskSnapshot {agentId?:string;taskId:string;instanceId:string;sequence:number;reportedAt:string;state:string;summary:string;sessionId:string}
export interface RedactionPolicy {literals?:readonly string[]}
export interface Exporter {flush():Promise<PublicationBatch[]>;acknowledge(batchId:string):Promise<void>}
/** baseRevision must be the last known shared Git commit, or null for an unpublished vault. */
export interface ExportOptions {ctx:InstanceContext;vault:Vault;runtime:Pick<Runtime,'history'>;baseRevision:()=>Promise<string|null>;policy?:RedactionPolicy}
export interface ExportReceipt {path:string;hash:string;content:string;batchId:string}
/** Exact preimages stay local. Batches are immutable, ordered; later same-path
 * baseHash values may name a preceding validated export rather than baseRevision.
 * Sync must retain that predecessor ancestry and acknowledge only confirmed integration.
 */
export interface PublicationIntent {batch:PublicationBatch;preimages:Record<string,string|null>;state:'pending'|'validated';acknowledged?:true;entries:Array<{sessionId:string;entryId:string;sequence:number}>;statuses:Record<string,{fingerprint:string;sequence:number}>}
