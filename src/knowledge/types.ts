import type { Json } from '../contracts/base.js';
import type { Concept } from '../vault/types.js';
export interface SearchHit {path:string;revision:string;title:string;description:string;evidenceState:'tentative'|'validated'|'contested';applicability:Record<string,Json>;sourcePaths:string[]}
export interface SearchRequest {query:string;framework?:string;version?:string;limit?:number;cursor?:string}
export interface SearchPage {items:SearchHit[];nextCursor?:string}
export interface RememberRequest {sessionId:string;scope:'agent'|'group'|'global';scopeId?:string;text:string;sourcePaths:string[];requestId?:string}
export interface Knowledge {rebuild():Promise<void>;snapshot():Promise<Concept[]>;search(input:SearchRequest):Promise<SearchPage>;loadKnowledge(input:{sessionId:string;path:string;revision:string;requestId?:string}):Promise<Concept>;remember(input:RememberRequest):Promise<{path:string;revision:string}>;close():Promise<void>}
