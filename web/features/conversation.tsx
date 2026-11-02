import { useEffect,useLayoutEffect,useRef,useState } from 'react';
import type { Session } from '../api.js';
import { Markdown } from '../components/markdown.js';
import type { ConversationState,ConversationViewState } from './conversation-state.js';

function messageText(text:string):string {
  try {
    const value=JSON.parse(text);
    if(typeof value?.objective==='string'&&typeof value?.taskId==='string')return `Task assignment: ${value.objective}`;
    if(typeof value?.answer==='string'&&typeof value?.decisionId==='string')return `Your decision: ${value.answer}`;
    if(value?.kind==='user-steering'&&typeof value?.text==='string')return `Your guidance: ${value.text}`;
    if(typeof value?.outcome?.summary==='string')return `Task result: ${value.outcome.summary}`;
  }catch{/* Ordinary conversation text. */}
  return text;
}
function toolSummary(text:string,name?:string):string {
  for(const line of text.split('\n')) {
    try {
      const value=JSON.parse(line);
      if(typeof value?.objective==='string')return `Delegated task: ${value.objective}`;
      if(typeof value?.question==='string')return `Decision requested: ${value.question}`;
    }catch{/* Tools may return plain text. */}
  }
  return name?`Tool result: ${name}`:'Tool result';
}
async function copyText(text:string) {
  try {if(navigator.clipboard){await navigator.clipboard.writeText(text);return;}}catch{/* Insecure LAN origins and denied permission use the selection fallback. */}
  const focused=document.activeElement;const input=document.createElement('textarea');
  input.value=text;input.style.position='fixed';input.style.opacity='0';input.setAttribute('aria-hidden','true');
  document.body.append(input);input.select();
  const copied=document.execCommand('copy');input.remove();if(focused instanceof HTMLElement)focused.focus();
  if(!copied)throw new Error('Copy unavailable. Use Download Markdown.');
}
function ResponseActions({text,id}:{text:string;id:string}) {
  const [notice,setNotice]=useState('');
  function download(){
    const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='response-'+id.replace(/[^A-Za-z0-9_-]/g,'-')+'.md';link.click();
    // The browser consumes the URL asynchronously when starting a download.
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  return <div className="response-actions"><button className="text-button" onClick={()=>void copyText(text).then(()=>setNotice('Copied.')).catch(cause=>setNotice(cause.message))}>Copy response</button><button className="text-button" onClick={download}>Download Markdown</button>{notice&&<span role="status">{notice}</span>}</div>;
}
export function Conversation({session,send,disabled,drafts,preparedDraft,label='Message',button='Send message'}:{
  preparedDraft?:string|undefined;session:Session|undefined;send:(text:string)=>Promise<void>;disabled:boolean;drafts?:ConversationState;label?:string;button?:string;
}) {
  const local=useRef<ConversationViewState>({draft:'',scrollTop:0,following:true});
  const view=(session&&drafts?.get(session.session.id))||local.current;
  const [text,setText]=useState(view.draft);const [following,setFollowing]=useState(view.following);
  const transcript=useRef<HTMLDivElement>(null);
  function update(value:string){setText(value);view.draft=value;}
  useLayoutEffect(()=>{
    const log=transcript.current;if(!log)return;
    log.scrollTop=view.following?log.scrollHeight:view.scrollTop;
  },[session?.messages,view]);
  const prepared=useRef<string|undefined>(undefined);useEffect(()=>{if(!preparedDraft||prepared.current===preparedDraft)return;prepared.current=preparedDraft;view.draft=view.draft?view.draft+'\n\n'+preparedDraft:preparedDraft;setText(view.draft);},[preparedDraft,view]);
  function onScroll(){
    const log=transcript.current;if(!log)return;
    view.scrollTop=log.scrollTop;view.following=log.scrollHeight-log.scrollTop-log.clientHeight<48;setFollowing(view.following);
  }
  function latest(){const log=transcript.current;if(log){view.following=true;log.scrollTop=log.scrollHeight;view.scrollTop=log.scrollTop;setFollowing(true);}}
  return <>
    <div className="conversation-stream"><div className="transcript" ref={transcript} onScroll={onScroll} role="log" aria-label="Conversation output" aria-live="polite">
      {session?.messages.map(message=>{
        const textParts=message.data.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
        const validTime=Number.isFinite(Date.parse(message.at));
        return <article key={message.id} className={'message '+message.kind}>
          <div className="message-meta"><span>{message.kind==='user'?'You':message.kind==='assistant'?'Assistant':message.kind==='tool'?'Tool activity':message.kind}</span>{validTime&&<time dateTime={message.at} title={new Date(message.at).toLocaleString()}>{new Date(message.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time>}</div>
          {message.data.content.map((part,index)=>{
            if(part.type==='toolCall')return <details key={index}><summary>Tool: {part.name}</summary><pre>{JSON.stringify(part.arguments,null,2)}</pre></details>;
            if(message.kind==='tool')return <details key={index}><summary>{toolSummary(part.text,message.data.toolName)}</summary><pre>{part.text}</pre></details>;
            const readable=messageText(part.text);
            return readable===part.text?<Markdown key={index} text={part.text}/>:<details key={index}><summary>{readable}</summary><pre>{part.text}</pre></details>;
          })}
          {message.kind==='assistant'&&textParts&&<ResponseActions text={textParts} id={message.id}/>}
        </article>;
      })}
      {!session?.messages.length&&<div className="conversation-intro"><p className="eyebrow">ROOM FOR YOUR NEXT IDEA</p><h3>What would you like to work on?</h3><p>Ask a question, think through a plan, or explore your team's knowledge.</p></div>}
    </div>
    {!following&&<button className="latest-button secondary" onClick={latest}>Return to latest</button>}
    </div>
    {session?.blockedReason&&<p role="status">Blocked: {session.blockedReason}</p>}
    <form className="composer" onSubmit={event=>{event.preventDefault();void send(text).then(()=>update('')).catch(()=>{});}}>
      <label><span>{label}</span><textarea aria-label={label} value={text} onChange={event=>update(event.target.value)} placeholder={label==='Message'?'What’s on your mind?':'Add guidance for this task…'} required disabled={disabled||!session}/></label>
      <div className="composer-bottom"><span>Shared knowledge. Your perspective.</span><button disabled={disabled||!session||!text.trim()}>{button}</button></div>
    </form>
  </>;
}
