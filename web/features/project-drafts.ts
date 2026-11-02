import {useSyncExternalStore} from 'react';
import type {ProjectSelection,ProjectFlowPreview,ProjectFlowOperation} from '../../src/projects/workflow-types.js';
import {registerDraftSource,registerPendingSource} from '../draft-guard.js';
export type ProjectDraft={operationId:string;createdAt:number;selection:ProjectSelection;preview?:ProjectFlowPreview;pending?:{key:string;body:{selection:ProjectSelection;expectedPreviewRevision:string}};operation?:ProjectFlowOperation;resumeKey?:string};
type Input={mode:ProjectSelection['mode'];projectId:string;title?:string;parentPath?:string;folderName?:string;path?:string;url?:string;catalogProjectId?:string;acknowledgeOpaque?:boolean};
export function createProjectDraft(operationId:string,input:Input):ProjectDraft{
 const selection:ProjectSelection=input.mode==='new'?{mode:input.mode,projectId:input.projectId,title:input.title??'',parentPath:input.parentPath??'',folderName:input.folderName??''}:input.mode==='existing'?{mode:input.mode,projectId:input.projectId,title:input.title??'',path:input.path??'',...input.catalogProjectId?{catalogProjectId:input.catalogProjectId}:{},...input.acknowledgeOpaque?{acknowledgeOpaque:true}:{}}:{mode:input.mode,projectId:input.projectId,url:input.url??'',parentPath:input.parentPath??'',folderName:input.folderName??'',...input.acknowledgeOpaque?{acknowledgeOpaque:true}:{}};
 return {operationId,createdAt:Date.now(),selection};
}
const same=(a:ProjectSelection,b:ProjectSelection)=>JSON.stringify(a,Object.keys(a).sort())===JSON.stringify(b,Object.keys(b).sort());
export function editProjectDraft(draft:ProjectDraft,selection:ProjectSelection):ProjectDraft{if(draft.pending||draft.operation)throw Error('Resume the original operation or start a distinct draft.');return {operationId:draft.operationId,createdAt:draft.createdAt,selection};}
function protect(draft:ProjectDraft):ProjectDraft{if(!draft.pending||Object.isFrozen(draft.pending))return draft;const selection=Object.freeze({...draft.pending.body.selection});return {...draft,pending:Object.freeze({key:draft.pending.key,body:Object.freeze({selection,expectedPreviewRevision:draft.pending.body.expectedPreviewRevision})})};}
export function freezeProjectDraft(draft:ProjectDraft):ProjectDraft{
 if(draft.pending)return protect(draft);const preview=draft.preview;
 if(!preview||preview.operationId!==draft.operationId||!same(preview.selection,draft.selection))throw Error('Review the current choices before confirming.');
 return protect({...draft,pending:{key:draft.operationId,body:{selection:{...preview.selection},expectedPreviewRevision:preview.revision}}});
}
export function acknowledgeProjectDraft(draft:ProjectDraft,operation:ProjectFlowOperation):ProjectDraft{if(operation.operationId!==draft.operationId||draft.preview&&operation.projectId!==draft.preview.projectId)throw Error('Response belongs to a different project operation.');const next={...draft,operation};if(operation.phase==='completed'){delete next.pending;delete next.resumeKey;}return next;}
const prefix='lorecrew:project-drafts:';
type Snapshot={drafts:Record<string,ProjectDraft>;storageError:string};
type DraftStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const warning='Draft recovery storage is unavailable. Keep this page open until the original operation is acknowledged.';
export function createProjectDraftStore(instanceId:string,context:string,storage?:DraftStorage){
 const key=prefix+encodeURIComponent(instanceId)+':'+encodeURIComponent(context);let selected=storage,snapshot:Snapshot={drafts:Object.create(null) as Record<string,ProjectDraft>,storageError:''};
 try{selected??=sessionStorage;const saved:unknown=JSON.parse(selected.getItem(key)??'{}');if(!saved||typeof saved!=='object'||Array.isArray(saved))throw Error('Invalid draft data');for(const [id,value] of Object.entries(saved)){const d=value as ProjectDraft;if(d?.operationId===id&&d.selection&&['new','existing','catalog-clone'].includes(d.selection.mode)&&typeof d.selection.projectId==='string')snapshot.drafts[id]=protect(d);}}catch{snapshot.storageError=warning;}
 const listeners=new Set<()=>void>();
 const put=(id:string,draft:ProjectDraft|undefined,expected?:ProjectDraft)=>{if(expected&&snapshot.drafts[id]!==expected)return;if(draft&&draft.operationId!==id)throw Error('Draft operation identity differs.');const drafts=Object.assign(Object.create(null) as Record<string,ProjectDraft>,snapshot.drafts);if(draft)drafts[id]=protect(draft);else delete drafts[id];let storageError=snapshot.storageError;try{if(!selected)throw Error('Unavailable');selected.setItem(key,JSON.stringify(drafts));storageError='';}catch{storageError=warning;}snapshot={drafts,storageError};for(const listener of listeners)listener();};
 return {getSnapshot:()=>snapshot,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},put,clear(){try{selected?.removeItem(key);}catch{}snapshot={drafts:Object.create(null) as Record<string,ProjectDraft>,storageError:''};for(const listener of listeners)listener();}};
}
const stores=new Map<string,ReturnType<typeof createProjectDraftStore>>();
function retained(){const drafts=[...stores.values()].flatMap(s=>Object.values(s.getSnapshot().drafts));try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix)){const values=JSON.parse(sessionStorage.getItem(key)??'{}');if(values&&typeof values==='object'&&!Array.isArray(values))for(const d of Object.values(values))if((d as ProjectDraft)?.selection)drafts.push(d as ProjectDraft);}}catch{/* Live memory still protects drafts. */}return drafts;}
registerDraftSource(()=>retained().some(d=>{if(d.operation?.phase==='completed')return false;if(d.pending||d.operation||d.preview)return true;const s=d.selection,values=s.mode==='new'?[s.title,s.parentPath,s.folderName]:s.mode==='existing'?[s.title,s.path,s.catalogProjectId]:[s.projectId,s.url,s.parentPath,s.folderName];return values.some(value=>typeof value==='string'&&value.length>0);}));
registerPendingSource(()=>retained().some(d=>!!d.pending||!!d.operation&&d.operation.phase!=='completed'));
export function clearProjectDrafts(){for(const store of stores.values())store.clear();try{for(const key of Object.keys(sessionStorage))if(key.startsWith(prefix))sessionStorage.removeItem(key);}catch{/* Live stores have already cleared. */}}
export function useProjectDrafts(instanceId:string,context:string){const key=JSON.stringify([instanceId,context]);let store=stores.get(key);if(!store){store=createProjectDraftStore(instanceId,context);stores.set(key,store);}const snapshot=useSyncExternalStore(store.subscribe,store.getSnapshot);return {...snapshot,put:store.put};}
