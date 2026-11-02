import { useEffect,useState } from 'react';

export function StopWork({kind,active,disabled,stopState,stop}:{kind:'task'|'conversation';active:boolean;disabled:boolean;stopState:'requested'|'confirmed'|undefined;stop:()=>Promise<{quiescent:boolean;reason?:string}>}) {
  const [pending,setPending]=useState(false);const [retry,setRetry]=useState(false);const [warning,setWarning]=useState('');
  useEffect(()=>{if(stopState==='confirmed'){setRetry(false);setWarning('');}},[stopState]);
  const unconfirmed=stopState==='requested';
  if(!active&&!pending&&!retry&&!unconfirmed)return null;
  async function cancel(){
    setPending(true);setWarning('');
    try {
      const result=await stop();setRetry(!result.quiescent);
      if(!result.quiescent)setWarning('Cancellation requested; process stop is unconfirmed. '+(result.reason??'Retry to check the outcome.'));
    }catch{setRetry(true);/* The shared command boundary displays the request error. */}
    finally{setPending(false);}
  }
  const message=warning||(unconfirmed&&!pending?'Cancellation requested; process stop is unconfirmed. Retry to check the outcome.':'');
  return <div className="stop-control"><button className="text-button stop-button" disabled={disabled||pending} onClick={()=>void cancel()}>{pending?'Stopping…':retry||unconfirmed?'Retry stop':`Stop ${kind}`}</button>{message&&<p role="alert" className="error-inline">{message}</p>}</div>;
}
