import { Value } from 'typebox/value';
import { AppError } from '../contracts/base.js';
import type { Tx } from '../storage/store.js';
import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import type { Runtime,SessionRecord,HistoryEntry } from '../runtime/types.js';
import type { Ownership } from '../projects/types.js';
import type { GitClient } from '../git/client.js';
import { resolveAgent,resolveGroup } from '../agents/resolve.js';
import { SetupSaveSchema } from '../api/schemas.js';
import { stableId } from '../runtime/admission.js';
import { readCompatibleSettings } from '../runtime/providers.js';
import { openSetupProjects } from './projects.js';
import { openSetupEntry } from './entry.js';
import type { SetupSaveInput,SetupState,SetupView } from './types.js';
export const setupEffectId=(kind:string,key:string)=>stableId('ui-setup',kind,key);
export const setupEntityId=(kind:string,key:string)=>`setup-${kind}-${key}`;
export function setupRevision(state:Omit<SetupState,'revision'>,previous:string|null):string{return stableId(JSON.stringify(state),previous??'initial');}
interface SetupOperation {kind:string;agentId?:string;projectId?:string;sessionId?:string;retired?:true}
const operationRecordId=(key:string)=>stableId('setup-operation',key);
function reconcileOperations(tx:Tx,previous:SetupState|undefined,next:Omit<SetupState,'revision'>){
 for(const [kind,key] of Object.entries(previous?.pendingOperations??{}))if(next.pendingOperations[kind]!==key){
  const record=tx.get<SetupOperation>('setup-operation',operationRecordId(key));
  tx.put('setup-operation',operationRecordId(key),{...record,kind,retired:true});
 }
 for(const [kind,key] of Object.entries(next.pendingOperations)){
  const id=operationRecordId(key),record=tx.get<SetupOperation>('setup-operation',id);
  if(record?.retired||record&&record.kind!==kind)throw new AppError('SETUP_CHANGED','This setup operation was retired. Reload saved progress and retry with the current selection.');
  if(!record)tx.put('setup-operation',id,{kind,...next.agentId?{agentId:next.agentId}:{},...next.projectId?{projectId:next.projectId}:{},...next.sessionId?{sessionId:next.sessionId}:{}});
  else if(kind==='message'&&!record.sessionId&&next.sessionId)tx.put('setup-operation',id,{...record,sessionId:next.sessionId});
 }
}
/** Known setup keys remain recognizable after retirement; delayed effects cannot become ordinary API work. */
export async function setupRequest(ctx:InstanceContext,kind:'session'|'task'|'message',key:string|undefined,body:{agentId?:string;leadAgentId?:string;projectId?:string},fallback:string,sessionId?:string):Promise<string>{
 if(!key)return fallback;
 return ctx.store.transact(tx=>{
  const state=tx.get<SetupState>('ui-setup','current'),record=tx.get<SetupOperation>('setup-operation',operationRecordId(key));
  if(!record&&state?.pendingOperations[kind]!==key)return fallback;
  const stale=()=>new AppError('SETUP_CHANGED','Setup changed before this operation was admitted. Reload saved progress and retry with the current selection.');
  if(!state||record?.retired||record&&record.kind!==kind||state.pendingOperations[kind]!==key)throw stale();
  if(kind==='session'&&(body.agentId!==state.agentId||body.projectId))throw stale();
  if(kind==='task'&&(body.leadAgentId!==state.agentId||body.projectId!==state.projectId||record?.projectId!==state.projectId))throw stale();
  if(kind==='message'&&(sessionId!==state.sessionId||record?.sessionId&&record.sessionId!==sessionId))throw stale();
  return setupEffectId(kind,key);
 });
}
export async function assertSetupReservation(ctx:InstanceContext,kinds:string[],key:string|undefined,entityId:string):Promise<void>{
 if(!key)return;
 await ctx.store.transact(tx=>{
  const record=tx.get<SetupOperation>('setup-operation',operationRecordId(key));if(!record)return;
  const state=tx.get<SetupState>('ui-setup','current');
  if(record.retired||!kinds.includes(record.kind)||state?.pendingOperations[record.kind]!==key||entityId!==setupEntityId(record.kind,key))throw new AppError('SETUP_CHANGED','This setup reservation changed. Reload saved progress before retrying.');
 });
}
/** Creation retries may use a fresh transport key, but their reserved entity remains fenced. */
export async function assertSetupCreationReservation(ctx:InstanceContext,kind:string,key:string|undefined,entityId:string):Promise<void>{
 await assertSetupReservation(ctx,[kind],key,entityId);
 const prefix=`setup-${kind}-`;
 if(entityId.startsWith(prefix))await assertSetupReservation(ctx,[kind],entityId.slice(prefix.length),entityId);
}
export async function attachSetupEntity(ctx:InstanceContext,kind:'agent'|'additionalAgent'|'group'|'session',key:string|undefined,id:string):Promise<void>{
 if(!key)return;
 await ctx.store.transact(tx=>{
  const state=tx.get<SetupState>('ui-setup','current');if(state?.pendingOperations[kind]!==key)return;
  if(kind!=='session'&&id!==setupEntityId(kind,key))return;
  if(kind==='agent'&&state.agentId===id||kind==='group'&&state.groupId===id||kind==='session'&&state.sessionId===id||kind==='additionalAgent'&&state.additionalAgentIds.includes(id))return;
  const {revision,...savedFields}=state;const fields={...savedFields,pendingOperations:{...savedFields.pendingOperations}};
  if(kind==='agent'&&state.agentId!==id){delete fields.sessionId;fields.completed=false;delete fields.pendingOperations.message;delete fields.pendingOperations.session;delete fields.pendingOperations.task;}
  if(kind==='session'&&state.sessionId&&state.sessionId!==id){delete fields.pendingOperations.message;fields.completed=false;}
  const next={...fields,...kind==='agent'?{agentId:id}:kind==='additionalAgent'?{additionalAgentIds:[...new Set([...state.additionalAgentIds,id])]}:kind==='group'?{groupId:id}:{sessionId:id}};
  reconcileOperations(tx,state,next);
  tx.put('ui-setup','current',{...next,revision:setupRevision(next,revision)});tx.emit('setup.updated',{kind});
 });
}
function successful(entry:HistoryEntry):boolean{
 if(entry.kind!=='assistant'||!Number.isFinite(Date.parse(entry.at))||Date.parse(entry.at)<=0)return false;
 const data=entry.data as {model?:Array<{stopReason?:string;content?:Array<{type:string;text?:string}>}>};const response=data?.model?.[0];
 // Use canonical Pi envelopes, never client-provided verification or tool-only output.
 return !!response&&['stop','length'].includes(response.stopReason??'')&&!!response.content?.some(c=>c.type==='text'&&c.text?.trim());
}
export function openSetup(options:{ctx:InstanceContext;vault:Vault;runtime:Runtime;ownership:Ownership;git:GitClient}) {
 const {ctx,vault,runtime}=options,projects=openSetupProjects(options);
 async function read():Promise<SetupView>{
  let state=await ctx.store.read<SetupState>('ui-setup','current')??null;
  // Recover the durable runtime-create / UI-attachment commit gap without starting new work.
  const sessionKey=state?.pendingOperations.session;
  if(sessionKey){
   const record=await ctx.store.read<SessionRecord>('runtime-session',stableId(ctx.instanceId,setupEffectId('session',sessionKey)));
   if(record&&record.session.agentId===state?.agentId&&!record.session.projectId&&!record.session.workloadId){await attachSetupEntity(ctx,'session',sessionKey,record.session.id);state=await ctx.store.read<SetupState>('ui-setup','current')??null;}
  }
  const entry=await openSetupEntry({ctx,vault}).read(!!state?.completed);
  const readiness:SetupView['readiness']={model:'missing_model',project:await projects.readiness(state?.projectId),fleetConfigured:!!await ctx.store.read('fleet','assignments')};
  if(state?.agentId){
   let agent;try{agent=await resolveAgent(vault,state.agentId);}catch{/* Missing definitions cannot claim readiness. */}
   if(agent){const model=(await runtime.listModels()).find(m=>m.provider===agent.model.provider&&m.modelId===agent.model.modelId);
    if(model){readiness.model=model.available?'unverified':'missing_credential';
     const record=state.sessionId?await ctx.store.read<SessionRecord>('runtime-session',state.sessionId):undefined;
     const localConfig=agent.model.provider==='openai-compatible'?await readCompatibleSettings(ctx):undefined;
     const descriptor=record?.modelDescriptor;
     const sameEndpoint=!localConfig||!descriptor||descriptor.baseUrl===localConfig.baseUrl&&descriptor.contextWindow===localConfig.contextWindow&&descriptor.maxTokens===localConfig.maxTokens;
     if(sameEndpoint&&model.available&&record&&record.session.agentId===agent.id&&record.session.model.provider===agent.model.provider&&record.session.model.modelId===agent.model.modelId&&record.session.agentRevision===agent.revision){
      const snapshot=await runtime.snapshot(record.session.id);readiness.sessionId=record.session.id;
      if(snapshot.status==='failed'||snapshot.status==='blocked')readiness.model='failed';
      else if(snapshot.status!=='cancelled'){
       const response=snapshot.messages.filter(successful).at(-1);
       if(response){readiness.model='verified';readiness.verifiedAt=response.at;}
      }
     }
    }
   }
  }
  return {state,...entry,needsSetup:entry.entry==='starter',readiness};
 }
 async function save(input:SetupSaveInput,requestId:string):Promise<SetupView>{
  if(!Value.Check(SetupSaveSchema,input)||!requestId)throw new AppError('INVALID_REQUEST','Setup accepts only non-secret choices and operation keys.');
  await openSetupEntry({ctx,vault}).read(!!(await ctx.store.read<SetupState>('ui-setup','current'))?.completed);
  const fingerprint=stableId(JSON.stringify(input));
  const receipt=await ctx.store.read<{fingerprint:string}>('setup-save',requestId);
  if(receipt){if(receipt.fingerprint!==fingerprint)throw new AppError('REQUEST_CONFLICT','Setup request key already names different choices.');return read();}
  const previous=await ctx.store.read<SetupState>('ui-setup','current');
  if((previous?.revision??null)!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Setup changed in another tab. Reload saved progress; current form text is retained.');
  const {revision:_,...fields}=previous??{version:1 as const,additionalAgentIds:[],completed:false,pendingOperations:{}};
  const next={...fields,...input.choices,pendingOperations:{...(input.pendingOperations??fields.pendingOperations)}};
  if(previous?.agentId&&input.choices.agentId&&input.choices.agentId!==previous.agentId){
   delete next.sessionId;next.completed=false;
   for(const kind of ['session','message','task','agent'])delete next.pendingOperations[kind];
   if(input.choices.sessionId)next.sessionId=input.choices.sessionId;
   if(input.choices.completed!==undefined)next.completed=input.choices.completed;
  }
  if(previous&&(previous.pendingOperations.session!==next.pendingOperations.session||previous.sessionId!==next.sessionId)){delete next.pendingOperations.message;}
  if(previous?.projectId!==next.projectId)delete next.pendingOperations.task;
  if(new Set(Object.values(next.pendingOperations)).size!==Object.values(next.pendingOperations).length)throw new AppError('INVALID_REQUEST','Use a distinct key for each setup operation.');
  if(next.completed&&!next.agentId)throw new AppError('INVALID_REQUEST','Create or choose an agent before finishing setup.');
  for(const id of [next.agentId,...next.additionalAgentIds].filter((id):id is string=>!!id))await resolveAgent(vault,id);
  if(next.groupId)await resolveGroup(vault,next.groupId);
  if(next.projectId&&await projects.readiness(next.projectId)==='unavailable')throw new AppError('INVALID_REQUEST','Selected project has no valid local grant.');
  if(next.sessionId){const session=await ctx.store.read<SessionRecord>('runtime-session',next.sessionId);if(!session||session.session.agentId!==next.agentId||session.session.projectId||session.session.workloadId)throw new AppError('INVALID_REQUEST','Choose a direct conversation belonging to the selected agent.');}
  await ctx.store.transact(tx=>{
   const old=tx.get<SetupState>('ui-setup','current');if((old?.revision??null)!==input.expectedRevision)throw new AppError('REVISION_CONFLICT','Setup changed in another tab. Reload saved progress; current form text is retained.');
   reconcileOperations(tx,old,next);
   const state={...next,revision:setupRevision(next,old?.revision??null)};tx.put('ui-setup','current',state);tx.put('setup-save',requestId,{fingerprint});tx.emit('setup.updated',{});
  });return read();
 }
 return {read,save,inspectProject:projects.inspectProject,connectProject:projects.connectProject};
}
