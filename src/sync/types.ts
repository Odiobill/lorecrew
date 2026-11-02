import type { PublicationBatch, RedactionPolicy } from '../export/types.js';
import type { GitClient } from '../git/client.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
export interface ContentReference { hash:string|null; commit:string|null; path:string }
export interface ConflictProposal { id:string; batchId:string; originId:string; paths:string[]; reason:string; versions:Array<{path:string;base:ContentReference;left:ContentReference;right:ContentReference}> }
export interface IntegrationResult { acceptedCommit:string; appliedBatchIds:string[]; conflicts:ConflictProposal[] }
export interface SyncStatus { lastFetchAt?:string;lastPushAt?:string;pending:number;conflicts:number;held?:number;error?:string }
export interface SyncEngine { publish(batch:PublicationBatch):Promise<{commit:string}>;integrate():Promise<IntegrationResult>;status():Promise<SyncStatus> }
export interface SyncOptions { ctx:InstanceContext;git:GitClient;vault:Vault;remote:string;policy?:RedactionPolicy;acknowledge?:(batchId:string)=>Promise<void> }
export interface Contribution { batch:PublicationBatch;commit:string;dependencies:string[];bases:Record<string,ContentReference> }
export interface PublicationRecord { batch:PublicationBatch;commit?:string }
export interface ConfirmedIntegration { acceptedCommit:string;batchId:string;originId:string;acknowledged?:true }
