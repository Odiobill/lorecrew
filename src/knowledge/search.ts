import { join, posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault, Concept } from '../vault/types.js';
import { orderedVault, vaultSnapshotLocked } from '../vault/write.js';
import { recoverPendingReplacements } from '../sync/recovery.js';
import { revisionOf, validatePath } from '../vault/parse.js';
import type { SessionRecord } from '../runtime/types.js';
import { KnowledgeIndex } from './index.js';
import type { Knowledge } from './types.js';
/** Both proposal and sync recovery run under the existing shared vault queue. */
export function coherentSnapshot(ctx:InstanceContext):Promise<Concept[]> {return orderedVault(ctx,async()=>{await recoverPendingReplacements(ctx);return vaultSnapshotLocked(ctx);});}
export function openKnowledge({ctx,vault,index=new KnowledgeIndex(join(ctx.stateDir,'index.sqlite'))}:{ctx:InstanceContext;vault:Vault;index?:KnowledgeIndex}):Knowledge {
 const snapshot=()=>coherentSnapshot(ctx);
 const rebuild=async()=>{await index.rebuild(await snapshot());};
 return {snapshot,rebuild,search:async input=>{await rebuild();return index.search(input);},close:()=>index.close(),
  async loadKnowledge(input){
   const id=input.requestId?revisionOf(JSON.stringify([input.sessionId,input.requestId])):revisionOf(JSON.stringify([input.sessionId,input.path,input.revision]));
   const request=JSON.stringify([input.sessionId,input.path,input.revision]);
   type Receipt={request:string;concept:Concept};
   const check=(record:Receipt)=>{if(record.request!==request)throw new AppError('REQUEST_MISMATCH','Load request ID already names different arguments');return record.concept;};
   const previous=await ctx.store.read<Receipt>('knowledge-load',id);if(previous)return check(previous);
   const concept=(await snapshot()).find(c=>c.path===input.path);if(!concept)throw new AppError('NOT_FOUND','Knowledge document not found');if(concept.revision!==input.revision)throw new AppError('REVISION_CONFLICT','Knowledge changed; search again before loading',{path:input.path});
   return ctx.store.transact(tx=>{const previous=tx.get<Receipt>('knowledge-load',id);if(previous)return check(previous);tx.insert('knowledge-load',id,{request,concept,sessionId:input.sessionId,path:input.path,revision:input.revision,at:new Date(ctx.clock.now()).toISOString()});tx.emit('knowledge.loaded',{sessionId:input.sessionId,path:input.path,revision:input.revision});return concept;});
  },
  async remember(input){
   if(!input.text?.trim()||!['global','agent','group'].includes(input.scope))throw new AppError('INVALID_MEMORY','Memory requires text and a valid scope');
   const session=await ctx.store.read<SessionRecord>('runtime-session',input.sessionId);if(!session)throw new AppError('SESSION_NOT_FOUND','Memory requires a local session');
   const scopeId=input.scope==='global'?undefined:input.scopeId??(input.scope==='agent'?session.input?.temporaryIdentity?.sourceAgentId??session.session.agentId:undefined);
   if(input.scope!=='global'&&(!scopeId||!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scopeId)))throw new AppError('INVALID_MEMORY','Scoped memories require a portable scope ID');
   for(const path of input.sourcePaths)validatePath(path);
   const requestId=input.requestId??randomUUID();const id=revisionOf(JSON.stringify([input.sessionId,requestId]));const path=`memories/${input.scope}${scopeId?`/${scopeId}`:''}/${id}.md`;
   const metadata={type:'Memory',title:input.text.trim().split('\n')[0]!.slice(0,100),description:input.text.trim().slice(0,240),evidenceState:'tentative',sourcePaths:input.sourcePaths,lorecrew:{memory:{schemaVersion:1,scope:input.scope,...(scopeId?{scopeId}:{}),sessionId:input.sessionId}}};
   const links=input.sourcePaths.map(source=>`- [${source}](${posix.relative(posix.dirname(path),source)})`).join('\n');
   const result=await vault.propose({id:`memory:${id}`,path,expectedRevision:null,content:`---\n${JSON.stringify(metadata)}\n---\n${input.text.trim()}\n\nSources:\n${links}\n`,actor:`agent:${session.session.agentId}`});return {path,revision:result.revision};
  },
 };
}
