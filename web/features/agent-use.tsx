import { useCallback,useEffect,useRef,useState } from 'react';
import { ApiError,type ApiClient } from '../api.js';
import type { AgentUseTarget,AgentUseReadiness } from '../../src/setup/agent-use.js';
import { ProviderPanel } from './providers.js';
const path=(target:AgentUseTarget)=>'agentId' in target?'/agents/'+encodeURIComponent(target.agentId)+'/readiness':'/sessions/'+encodeURIComponent(target.sessionId)+'/readiness';
type Pending={target:AgentUseTarget;identity:AgentUseReadiness;resolve:()=>void;reject:(e:Error)=>void};
/** Only a deliberate command enters this controller. A repaired connection never submits by itself. */
export function useAgentUse(api:ApiClient,enabled:boolean){
 const pending=useRef<Pending|undefined>(undefined),generation=useRef(0),dialog=useRef<HTMLDialogElement>(null);
 const [view,setView]=useState<AgentUseReadiness>(),[error,setError]=useState(''),[checking,setChecking]=useState(false);
 const cancel=useCallback(()=>{generation.current++;const prior=pending.current;pending.current=undefined;setView(undefined);setError('');prior?.reject(new Error('Action cancelled. Your draft is preserved.'));},[]);
 useEffect(()=>{
  if(!enabled){cancel();return;}
  api.setAgentUseHandler?.(async target=>{
   cancel();const current=++generation.current;const readiness=await api.operations<AgentUseReadiness>(path(target));
   if(current!==generation.current)throw new Error('Action changed. Try again.');
   if(readiness.state==='ready')return;
   await new Promise<void>((resolve,reject)=>{pending.current={target,identity:readiness,resolve,reject};setView(readiness);setError('');});
  });
  window.addEventListener('hashchange',cancel);
  return()=>{api.setAgentUseHandler?.(undefined);window.removeEventListener('hashchange',cancel);cancel();};
 },[api,enabled,cancel]);
 useEffect(()=>{if(view&&!dialog.current?.open)dialog.current?.showModal();},[view]);
 const check=useCallback(async()=>{
  const intent=pending.current;if(!intent)return;setChecking(true);setError('');
  try{const value=await api.operations<AgentUseReadiness>(path(intent.target));if(pending.current!==intent)return;
   if(value.agentRevision!==intent.identity.agentRevision||value.model.provider!==intent.identity.model.provider||value.model.modelId!==intent.identity.model.modelId){cancel();throw new Error('The agent changed. Retry the original action to use its current definition.');}
   setView(value);return value;
  }catch(e){if(pending.current===intent){if(e instanceof ApiError&&e.status===401){pending.current=undefined;setView(undefined);intent.reject(e);}else setError(e instanceof Error?e.message:'Connection check failed.');}}finally{setChecking(false);}
 },[api,cancel]);
 const content=view?<dialog ref={dialog} aria-label={view.state==='unsupported_thinking_level'?'Review thinking level':'Connect this agent'} onCancel={e=>{e.preventDefault();cancel();}} className="agent-use-dialog"><h2>{view.state==='unsupported_thinking_level'?'Review thinking level':'Connect this agent'}</h2><p>{view.model.provider} · {view.model.modelId}</p><p>{view.reason??'This agent needs a local provider connection before it can continue.'}</p>{view.state==='unsupported_thinking_level'&&<p><a href={'#agents/'+encodeURIComponent(view.agentId)} onClick={cancel}>Review the agent thinking level</a></p>}{view.state==='unknown_model'&&<p><a href={'#agents/'+encodeURIComponent(view.agentId)} onClick={cancel}>Review the agent model</a></p>}{view.state!=='unsupported_thinking_level'&&<ProviderPanel key={view.model.provider} api={api} disabled={!enabled} initialProvider={view.model.provider} fixedProvider={view.model.provider} refresh={check}/>} {error&&<p role="alert">{error}</p>}<p>{view.state==='unsupported_thinking_level'?'Repair the agent definition, then retry your original action. Your draft is preserved.':'Saving credentials does not start this action. Continue when you are ready.'}</p><div className="setup-actions"><button className="secondary" onClick={cancel}>Cancel action</button><button className="secondary" disabled={checking||!enabled} onClick={()=>void check()}>{view.state==='unsupported_thinking_level'?'Check agent':'Check connection'}</button><button disabled={checking||view.state!=='ready'||!enabled} onClick={()=>void (async()=>{const intent=pending.current;if(!intent)return;const value=await check();if(value?.state!=='ready'||pending.current!==intent)return;pending.current=undefined;setView(undefined);intent.resolve();})()}>Continue action</button></div></dialog>:null;
 return content;
}
