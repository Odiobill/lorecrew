import {useSyncExternalStore} from 'react';
import {registerDraftSource,registerPendingSource} from '../draft-guard.js';
import {newOperationKey} from '../api.js';
export type Definition={id:string;revision?:string};
export type PendingSave={key:string;body:unknown;method:'POST'|'PUT'};
export type DefinitionDraft<T extends Definition>={value:T;base?:T|undefined;pending?:PendingSave|undefined;returnTo?:string|undefined};
const prefix='lorecrew:definition-drafts:';
type DraftMap=Record<string,DefinitionDraft<Definition>>;
type DraftSnapshot={drafts:DraftMap;storageError:string};
const stores=new Map<string,{snapshot:DraftSnapshot;subscribe:(listener:()=>void)=>()=>void;emit:()=>void}>();
function retainedDrafts():DefinitionDraft<Definition>[]{
 const drafts=[...stores.values()].flatMap(store=>Object.values(store.snapshot.drafts));
 // Recovered drafts can exist before their feature has ever mounted in this page.
 try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix)){const value:unknown=JSON.parse(sessionStorage.getItem(key)??'{}');if(value&&typeof value==='object'&&!Array.isArray(value))for(const entry of Object.values(value)){const draft=entry as DefinitionDraft<Definition>;if(draft?.value)drafts.push(draft);}}}catch{/* Live stores still protect drafts when tab storage is unavailable. */}
 return drafts;
}
registerDraftSource(()=>retainedDrafts().length>0);
registerPendingSource(()=>retainedDrafts().some(draft=>!!draft.pending));
const emptyDrafts=()=>Object.create(null) as DraftMap;
function draftStore(key:string){
 let store=stores.get(key);if(store)return store;
 let drafts=emptyDrafts(),storageError='';
 try{const saved=JSON.parse(sessionStorage.getItem(key)??'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const [id,record] of Object.entries(saved)){const draft=record as DefinitionDraft<Definition>;if(draft?.value&&draft.value.id===id&&(!draft.base||draft.base.id===id))drafts[id]=draft;}}
 catch{storageError='Draft recovery storage is unavailable. Keep this page open until you save.';}
 const listeners=new Set<()=>void>();store={snapshot:{drafts,storageError},subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener);};},emit:()=>{for(const listener of listeners)listener();}};stores.set(key,store);return store;
}
/** Management drafts are tab-local. Never use this store for credentials or messages. */
export function clearDefinitionDrafts(){
 for(const store of stores.values()){store.snapshot={drafts:emptyDrafts(),storageError:''};store.emit();}
 try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix))sessionStorage.removeItem(key);}catch{/* In-memory drafts still clear when browser storage is unavailable. */}
}
export function useDefinitionDrafts<T extends Definition>(instanceId:string,kind:string){
 const key=prefix+instanceId+':'+kind,store=draftStore(key);
 const snapshot=useSyncExternalStore(store.subscribe,()=>store.snapshot);
 function put(id:string,draft:DefinitionDraft<T>|undefined,expected?:DefinitionDraft<T>){
  // A late acknowledgement cannot replace a newer edit or resurrect a disconnected draft.
  if(expected&&store.snapshot.drafts[id]!==expected)return;
  const next=Object.assign(emptyDrafts(),store.snapshot.drafts);if(draft)next[id]=draft;else delete next[id];let storageError='';
  try{sessionStorage.setItem(key,JSON.stringify(next));}catch{storageError='Draft recovery storage is unavailable. Keep this page open until you save.';}
  store.snapshot={drafts:next,storageError};store.emit();
 }
 return {drafts:snapshot.drafts as Record<string,DefinitionDraft<T>>,get:(id:string)=>store.snapshot.drafts[id] as DefinitionDraft<T>|undefined,put,storageError:snapshot.storageError};
}
export function pendingSave<T extends Definition>(record:DefinitionDraft<T>,cleanResponsibilities=false):PendingSave{
 if(record.pending)return record.pending;
 const {revision,...fields}=record.value;
 const value=cleanResponsibilities&&'responsibilities' in fields?{...fields,responsibilities:(fields.responsibilities as string[]).filter(s=>s.trim())}:fields;
 return {key:newOperationKey(),method:record.base?.revision?'PUT':'POST',body:record.base?.revision?{...value,expectedRevision:record.base.revision}:value};
}
/** Only deliberately changed fields are rebased; group edits apply membership deltas. */
export function reapplyDefinition<T extends Definition>(base:T,draft:T,current:T):T{
 if(base.id!==draft.id||current.id!==draft.id)throw new Error('Definition identity changed; reload the intended definition before reapplying edits.');
 const next={...current} as Record<string,unknown>;
 for(const field of Object.keys(draft) as (keyof T)[]){
  if(field==='revision'||field==='id'||JSON.stringify(base[field])===JSON.stringify(draft[field]))continue;
  if(field==='groups'){
   const before=base[field] as string[],after=draft[field] as string[],latest=current[field] as string[];
   next.groups=[...latest.filter(id=>!before.includes(id)||after.includes(id)),...after.filter(id=>!before.includes(id)&&!latest.includes(id))];
  }else if(field==='model'){
   const before=base[field] as Record<string,unknown>,after=draft[field] as Record<string,unknown>,latest={...current[field] as Record<string,unknown>};
   if(before.provider!==after.provider||before.modelId!==after.modelId){latest.provider=after.provider;latest.modelId=after.modelId;}
   for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(key!=='provider'&&key!=='modelId'&&before[key]!==after[key]){if(after[key]===undefined)delete latest[key];else latest[key]=after[key];}
   next.model=latest;
  }else next[String(field)]=draft[field];
 }
 return next as T;
}
