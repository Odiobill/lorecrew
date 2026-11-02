import { useState } from 'react';
import type {ConversationState} from './conversation-state.js';
import type { Decision } from '../api.js';
export function Decisions({decisions,answer,disabled,drafts}:{drafts?:ConversationState;decisions:Decision[];answer:(id:string,text:string)=>Promise<void>;disabled:boolean}) {
  return <>{decisions.filter(d=>d.state==='pending').map(d=><DecisionForm key={d.id} decision={d} answer={answer} disabled={disabled} drafts={drafts}/>)}</>;
}
function DecisionForm({decision,answer,disabled,drafts}:{drafts?:ConversationState|undefined;decision:Decision;answer:(id:string,text:string)=>Promise<void>;disabled:boolean}) {
  const view=drafts?.get('decision:'+decision.id);const [text,setValue]=useState(view?.draft??'');const setText=(value:string)=>{setValue(value);if(view)view.draft=value;};const [submitted,setSubmitted]=useState(false);
  return <section className="decision" aria-label="Decision needed"><p className="eyebrow">HUMAN INPUT</p><h2>Waiting for your decision</h2><p><strong>{decision.question}</strong></p><p>Recommendation: {decision.recommendation}</p><p className="muted">{decision.blockedTaskIds.length} selected task{decision.blockedTaskIds.length===1?'':'s'} waiting. Independent work continues.</p>{submitted?<p>Answer sent.</p>:<form onSubmit={event=>{event.preventDefault();void answer(decision.id,text).then(()=>{setText('');setSubmitted(true);}).catch(()=>{});}}><label>Your answer<textarea value={text} onChange={event=>setText(event.target.value)} required disabled={disabled}/></label><button disabled={disabled}>Send answer</button></form>}</section>;
}
