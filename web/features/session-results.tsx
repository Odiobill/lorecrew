import {useEffect,useState,type ReactNode} from 'react';
import {ResultDetail} from './result-detail.js';
import type {ApiClient} from '../api.js';
import type {InboxResultRef} from '../../src/attention/types.js';
/** History links survive reads. Embedded details use the same captured revision and visibility observer. */
export function SessionResults({api,sessionId,sequence,embedded=false,fallback}:{api:ApiClient;sessionId:string;sequence:number;embedded?:boolean;fallback?:ReactNode}){
 const [items,setItems]=useState<{sessionId:string;items:Array<InboxResultRef&{title:string;href:string}>}>({sessionId,items:[]}),[error,setError]=useState('');
 useEffect(()=>{let current=true;void api.operations<Array<InboxResultRef&{title:string;href:string}>>('/sessions/'+encodeURIComponent(sessionId)+'/results').then(value=>{if(current){setItems({sessionId,items:value});setError('');}}).catch(e=>{if(current)setError(e instanceof Error?e.message:'Cannot load results');});return()=>{current=false;};},[api,sessionId,sequence]);
 const results=items.sessionId===sessionId?items.items:[];
 return <div className="session-results">{error&&<p role="alert">{error}</p>}{results.length>0&&<><h4>Results</h4><ul>{results.map(item=><li key={item.id}><a href={item.href}>{item.title}</a>{embedded&&<ResultDetail key={item.id} api={api} id={item.id} currentRevision={item.revision} embedded/>}</li>)}</ul></>}{!results.length&&fallback}</div>;
}
