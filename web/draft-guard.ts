/** Tab memory only. A reload guard never queues or submits a command. */
const sources=new Set<()=>boolean>();
const pending=new Set<()=>boolean>();
export function registerDraftSource(source:()=>boolean){sources.add(source);return()=>{sources.delete(source);};}
export function registerPendingSource(source:()=>boolean){pending.add(source);return()=>{pending.delete(source);};}
export function hasUnsentDrafts(){return [...sources].some(source=>source());}
export function hasPendingReceipts(){return [...pending].some(source=>source());}
