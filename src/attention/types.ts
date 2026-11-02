import type { Json } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Runtime } from '../runtime/types.js';
import type { Vault } from '../vault/types.js';
export interface InboxResultRef {id:string;revision:string}
export type AttentionOrigin={kind:'user_task';rootTaskId:string}|{kind:'schedule';occurrenceId:string;scheduleId:string}|{kind:'workload';sessionId:string;workloadId:string}|{kind:'conversation';sessionId:string};
export interface InboxItem extends InboxResultRef {class:'action'|'result';kind:'decision'|'blocked'|'failed'|'completed'|'report'|'finding';title:string;href:string;source:AttentionOrigin|{kind:'decision';decisionId:string;taskId:string}|{kind:'repository';repositoryKind:'vault'|'project';repositoryId:string;problemId:string}}
export interface InboxResult extends InboxResultRef {source:AttentionOrigin;title:string;content:Json;sourcePaths:string[]}
export interface StoredResult extends InboxResult {kind:'report'|'finding';sessionId:string}
export interface InboxOptions {ctx:InstanceContext;runtime:Runtime;vault:Vault}
export interface ReportResultInput {kind:'report'|'finding';title:string;body:string;sourcePaths:string[];expectedRevision:string|null}
