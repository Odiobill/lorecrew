import {useState,useRef,type Dispatch,type SetStateAction} from 'react';
import {registerDraftSource,registerPendingSource} from '../draft-guard.js';
/** Non-secret setup input in tab memory, never browser storage or a background queue. */
const values=new Map<string,unknown>();
registerDraftSource(()=>[...values.entries()].some(([key,value])=>!key.endsWith(':step')&&!key.endsWith(':creation')&&value!==undefined&&value!==''));
registerPendingSource(()=>[...values.entries()].some(([key,value])=>key.endsWith(':intent')&&value!==undefined));
export function getTabDraft<T>(key:string):T|undefined{return values.get(key) as T|undefined;}
export function clearTabDrafts(prefix=''){for(const key of values.keys())if(key.startsWith(prefix))values.delete(key);}
export function useTabDraftState<T>(key:string,initial:T):[T,Dispatch<SetStateAction<T>>]{
 const [value,setState]=useState<T>(()=>values.has(key)?values.get(key) as T:initial);
 const set:Dispatch<SetStateAction<T>>=update=>setState(previous=>{const next=typeof update==='function'?(update as (previous:T)=>T)(previous):update;if(next===undefined)values.delete(key);else values.set(key,next);return next;});
 return [value,set];
}

/** Refs retain frozen identity/payload through feature unmounts, without persisting host paths. */
export function useTabDraftRef<T>(key:string,initial:()=>T):{current:T}{
 if(!values.has(key))values.set(key,initial());
 const ref=useRef<{current:T}|undefined>(undefined);
 if(!ref.current)ref.current={get current(){return values.get(key) as T;},set current(value:T){values.set(key,value);}};
 return ref.current;
}
