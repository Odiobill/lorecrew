import {thinkingLabel} from './agent-form.js';
import {SessionResults} from './session-results.js';
import { useState } from 'react';
import type { ApiClient,Session,Snapshot } from '../api.js';
import type { Route } from '../navigation.js';
import { Icon } from '../components/icon.js';
import { StopWork } from '../components/stop-work.js';
import { Conversation } from './conversation.js';
import type { ConversationState } from './conversation-state.js';

function text(session:Session,kind:'user'|'assistant',last=false):string {
  const messages=session.messages.filter(message=>message.kind===kind);
  const message=last?messages.at(-1):messages[0];
  const data=message?.data;
  if(!data||typeof data!=='object'||Array.isArray(data))return '';
  const content=data.content;
  if(!Array.isArray(content))return '';
  return content.flatMap(part=>part&&typeof part==='object'&&!Array.isArray(part)&&part.type==='text'&&typeof part.text==='string'?[part.text]:[]).join(' ').replace(/\s+/g,' ').trim();
}
function short(value:string,length:number){return value.length>length?value.slice(0,length-1)+'…':value;}
function subject(session:Session){return short(text(session,'user'),80)||'Direct conversation';}
function status(session:Session){
  if(session.status==='cancelled')return session.stopState==='requested'?'Stopping…':'Stopped';
  return {idle:'Ready',completed:'Ready',running:'Working…',waiting:'Needs input',blocked:'Blocked',failed:'Failed'}[session.status];
}
function DateLabel({value,compact=false}:{value:string|undefined;compact?:boolean}){
  if(!value||!Number.isFinite(Date.parse(value)))return <span>Date unavailable</span>;
  const date=new Date(value);
  const full=new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'long'}).format(date);
  return <time dateTime={value} title={full}>{compact?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date):full}</time>;
}
export function recentConversations(snapshot:Pick<Snapshot,'tasks'|'sessions'>):Session[] {
  const teamSessionIds=new Set(snapshot.tasks.map(task=>task.executingSessionId));
  return snapshot.sessions.filter(session=>!teamSessionIds.has(session.session.id)).sort((a,b)=>(Date.parse(b.updatedAt??'')||0)-(Date.parse(a.updatedAt??'')||0)||a.session.id.localeCompare(b.session.id));
}
function RepositoryRequest({value}:{value:string|undefined}){return value?<div className="repository-request" role="note" aria-label="Repository request"><strong>Prepared request</strong><p>{value}</p><p>Start or choose a conversation, review the draft and send it when ready.</p></div>:null;}
export function ConversationWorkspace({api,snapshot,route,selectedId,disabled,command,navigate,drafts}: {
  api:ApiClient;snapshot:Snapshot;route:Route;disabled:boolean;command:(work:()=>Promise<void>)=>Promise<void>;
  navigate:(route:Route)=>void;drafts:ConversationState;selectedId:string|undefined;
}) {
  const [agent,setAgent]=useState('');
  const selectedAgent=snapshot.agents.find(a=>a.id===agent)??snapshot.agents[0];
  const chats=recentConversations(snapshot);
  const conversation=chats.find(s=>s.session.id===(route.entity??selectedId));
  const agentName=(session:Session)=>snapshot.agents.find(a=>a.id===session.session.agentId)?.name??session.session.agentId;
  return <main className={'workspace conversation-workspace'+(route.entity?' has-selection':'')}>
    <section className="panel primary context-list"><div className="section-heading"><p className="eyebrow">YOUR TEAM, ONE CONVERSATION AWAY</p><h1>Conversations</h1><p className="muted">A place to think, plan, and get things moving.</p></div>
      {!route.entity&&<RepositoryRequest value={route.draft}/>}<div className="agent-picker" role="group" aria-label="Choose an agent">{snapshot.agents.map(a=><button className="agent-choice" aria-pressed={selectedAgent?.id===a.id} key={a.id} onClick={()=>setAgent(a.id)}><span className="agent-avatar" aria-hidden="true">{a.name.slice(0,1)}</span><span><strong>{a.name}</strong><span>{short(a.responsibilities[0]??'Your teammate',72)}</span></span></button>)}</div>
      <button className="start-conversation" disabled={disabled||!selectedAgent} onClick={()=>void command(async()=>{const created=await api.createSession({agentId:selectedAgent!.id});navigate({page:'conversations',entity:created.id,...route.draft?{draft:route.draft}:{}});}).catch(()=>{})}><Icon name="plus"/>Start conversation</button>
      {!snapshot.agents.length&&<p className="empty">Create your first agent in <a href="#settings">Settings</a>.</p>}
      <h2 className="list-title">Recent conversations <span>{chats.length}</span></h2><ul className="task-list" aria-label="Recent conversations">{chats.map(s=><li key={s.session.id}><button className={'task-choice conversation-choice'+(conversation?.session.id===s.session.id?' selected':'')} aria-current={conversation?.session.id===s.session.id?'true':undefined} onClick={()=>navigate({page:'conversations',entity:s.session.id,...route.draft?{draft:route.draft}:{}})}><span className="agent-avatar" aria-hidden="true">{agentName(s).slice(0,1)}</span><span className="conversation-preview"><strong>{text(s,'user')?subject(s):'New conversation'}</strong><span>{agentName(s)} · {status(s)}</span><span>{short(text(s,'assistant',true)||text(s,'user',true)||'Ready for your first message',100)}</span><span className="conversation-date">Last activity <DateLabel value={s.updatedAt} compact/></span></span></button></li>)}</ul>
    </section>
    <section className="panel detail conversation-detail">{route.entity&&<RepositoryRequest value={route.draft}/>}<a className="back-link" href="#conversations"><Icon name="back"/>All conversations</a>{route.entity&&!conversation?<div className="workspace-empty"><Icon name="conversations"/><h2>Conversation not found</h2><p>This conversation is not available on this instance.</p><a href="#conversations">Go to conversations</a></div>:conversation?<><div className="conversation-heading"><span className="agent-avatar large">{agentName(conversation).slice(0,1)}</span><div className="conversation-title"><h2>{subject(conversation)}</h2><p className="muted">{agentName(conversation)} <span aria-hidden="true">·</span> {conversation.session.model.modelId}</p><p className="muted">Thinking level: {thinkingLabel(conversation.session.thinkingPreference)} · Pinned to this conversation</p></div><div className="conversation-controls"><span className="badge conversation-status" role="status">{conversation.status==='running'&&<span className="busy-spinner" aria-hidden="true"/>}{status(conversation)}</span><StopWork key={conversation.session.id} kind="conversation" stopState={conversation.stopState} active={['running','waiting','blocked'].includes(conversation.status)} disabled={disabled} stop={async()=>{await command(async()=>{await api.cancelSession(conversation.session.id);});return {quiescent:true};}}/></div><div className="conversation-dates"><span>Started <DateLabel value={conversation.createdAt}/></span><span>Last activity <DateLabel value={conversation.updatedAt}/></span></div></div><Conversation key={conversation.session.id} preparedDraft={route.draft} session={conversation} disabled={disabled||conversation.status==='cancelled'} drafts={drafts} send={text=>command(async()=>{await api.message(conversation.session.id,text);})}/><SessionResults api={api} sessionId={conversation.session.id} sequence={snapshot.seq}/></>:<div className="workspace-empty"><div className="empty-emblem"><Icon name="conversations"/></div><p className="eyebrow">A FRESH CONVERSATION</p><h2>Your next idea starts here.</h2><p>Choose an agent and start a conversation.<br/>Your team's shared knowledge comes along.</p><div className="empty-suggestions"><span>Think through an idea</span><span>Make a plan</span><span>Explore what you know</span></div></div>}</section>
  </main>;
}
