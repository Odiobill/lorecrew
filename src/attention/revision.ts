import type { TaskRecord } from '../team/types.js';
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value)??'null';
}
/** A non-security 128-bit content fingerprint; no message text enters seen-marker storage. */
export function revision(value:unknown):string {
 const text=canonical(value);let a=0x811c9dc5,b=0x9e3779b9,c=0x85ebca6b,d=0xc2b2ae35;
 for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);a=Math.imul(a^n,16777619);b=Math.imul(b^n,2246822507);c=Math.imul(c^n,3266489909);d=Math.imul(d^n,668265263);}
 return [a,b,c,d].map(v=>(v>>>0).toString(16).padStart(8,'0')).join('');
}
export const taskRevision=(t:TaskRecord)=>revision({state:t.state,generation:t.generation,session:t.executingSessionId,reason:t.blockedReason,outcome:t.outcome});
