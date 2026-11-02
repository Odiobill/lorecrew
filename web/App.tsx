import { lazy,Suspense,useCallback,useEffect,useRef,useState } from 'react';
import { ApiError,type ApiClient,type Snapshot } from './api.js';
import { subscribeEvents } from './events.js';
import { parseRoute,routeHash,type Page,type Route } from './navigation.js';
import { useAppearance } from './appearance.js';
import { AppShell } from './components/app-shell.js';
import { Onboarding } from './features/onboarding.js';
import { useAgentUse } from './features/agent-use.js';
import { VaultSetup } from './features/vault-setup.js';
import type { StartupView,SetupView } from '../src/setup/types.js';
import { Login } from './features/login.js';
import { TaskWorkspace } from './features/task-workspace.js';
import { ConversationWorkspace,recentConversations } from './features/conversation-workspace.js';
import { ConversationState } from './features/conversation-state.js';
import { Knowledge } from './features/knowledge.js';
const Skills=lazy(()=>import('./features/skills.js').then(module=>({default:module.Skills})));
import { Learning } from './features/learning.js';
import {clearProjectDrafts} from './features/project-drafts.js';
import {clearTabDrafts} from './features/tab-drafts.js';
import {registerDraftSource} from './draft-guard.js';
import { clearDefinitionDrafts } from './features/definition-drafts.js';
import { Settings } from './features/settings.js';
import {Projects} from './features/projects.js';
import {Inbox} from './features/inbox.js';
import {type AttentionItem} from './features/attention.js';
import { Schedules } from './features/schedules.js';
import { RemoteStatus } from './features/remote-status.js';

import {ResultDetail} from './features/result-detail.js';
import {ResultReadContext,useResultReads} from './features/use-result-read.js';
const Agents=lazy(()=>import('./features/agents.js').then(module=>({default:module.Agents})));
const Groups=lazy(()=>import('./features/groups.js').then(module=>({default:module.Groups})));
const cursorKey='lorecrew:event-cursor';
export function App({api}:{api:ApiClient}) {
  const [appearance,setAppearance]=useAppearance();
  const [attention,setAttention]=useState<AttentionItem[]>([]),[inboxError,setInboxError]=useState(''),[inboxLoading,setInboxLoading]=useState(true);
  const inboxGeneration=useRef(0);
  const loadInbox=useCallback(async()=>{const generation=++inboxGeneration.current;try{const view=await api.operations<{items:AttentionItem[];count:number}>('/inbox');if(generation===inboxGeneration.current){setAttention(view.items);setInboxError('');setInboxLoading(false);}}catch(e){if(generation===inboxGeneration.current){setInboxError(e instanceof Error?e.message:'Cannot load Inbox');setInboxLoading(false);}}},[api]);
  const [authenticated,setAuthenticated]=useState(false);
  const [snapshot,setSnapshot]=useState<Snapshot>();
  const [startup,setStartup]=useState<StartupView>();
  const [error,setError]=useState('');const [refreshError,setRefreshError]=useState('');
  const [busy,setBusy]=useState(false);const [online,setOnline]=useState(navigator.onLine);const [connected,setConnected]=useState(false);
  const agentUse=useAgentUse(api,authenticated&&online&&startup?.phase==='ready');
  const [route,setRoute]=useState(()=>parseRoute(location.hash));
  const selections=useRef<Partial<Record<Page,string>>>({});
  const defaultConversation=useRef<string|undefined>(undefined);
  const drafts=useRef(new ConversationState());
  useEffect(()=>registerDraftSource(()=>drafts.current.hasUnsentDrafts()),[]);
  const checkedSetup=useRef(false);
  useEffect(()=>{if(!authenticated||!snapshot||checkedSetup.current)return;checkedSetup.current=true;let active=true;void api.operations<SetupView>('/setup').then(v=>{if(active&&v.needsSetup&&parseRoute(location.hash).page==='conversations'&&!parseRoute(location.hash).entity){setRoute({page:'setup'});location.hash='#setup';}}).catch(()=>{checkedSetup.current=false;});return()=>{active=false;};},[api,authenticated,!!snapshot]);
  const refreshing=useRef<Promise<Snapshot>|undefined>(undefined);const refreshAgain=useRef(false);
  if(route.entity)selections.current[route.page]=route.entity;
  const navigate=(next:Route)=>{setRoute(next);location.hash=routeHash(next);};
  const refresh=useCallback(async():Promise<Snapshot>=>{
    if(refreshing.current){refreshAgain.current=true;return refreshing.current;}
    const pending=(async()=>{let value:Snapshot;do{refreshAgain.current=false;value=await api.snapshot();for(const {id,text} of api.reconcileSnapshot(value)){const decision=value.decisions.find(d=>d.id===id),view=drafts.current.get('decision:'+id);if(decision?.answer===text&&view.draft===text)view.draft='';}setSnapshot(value);}while(refreshAgain.current);return value;})();
    refreshing.current=pending;try{return await pending;}finally{refreshing.current=undefined;}
  },[api]);
  const fail=useCallback((cause:unknown)=>{
    setError(cause instanceof Error?cause.message:'The action could not be completed.');
    if(cause instanceof ApiError&&cause.status===401){setAuthenticated(false);setSnapshot(undefined);setStartup(undefined);}
  },[]);
  const refreshState=useCallback(async():Promise<Snapshot>=>{
    try{const fresh=await refresh();setRefreshError('');return fresh;}
    catch(cause){if(cause instanceof ApiError&&cause.status===401)fail(cause);else setRefreshError('Could not refresh team state. Retry the refresh to see the latest state.');throw cause;}
  },[refresh,fail]);
  useEffect(()=>{
    const on=()=>setOnline(true);const off=()=>{setOnline(false);setConnected(false);};const changed=()=>setRoute(parseRoute(location.hash));
    window.addEventListener('online',on);window.addEventListener('offline',off);window.addEventListener('hashchange',changed);
    return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off);window.removeEventListener('hashchange',changed);};
  },[]);
  const loadStartup=useCallback(async()=>{const view=await api.startup();setStartup(view);if(view.phase==='ready')await refreshState();},[api,refreshState]);
  useEffect(()=>{void api.restore().then(()=>{setAuthenticated(true);void loadStartup().catch(fail);}).catch(cause=>{if(!(cause instanceof ApiError&&cause.status===401))fail(cause);});},[api,fail,loadStartup]);
  useEffect(()=>{
    if(!authenticated||!snapshot||!online)return;
    const saved=Number(sessionStorage.getItem(cursorKey));
    const initial=Number.isSafeInteger(saved)&&saved>=0&&sessionStorage.getItem(cursorKey)!==null?saved:snapshot.seq;
    return subscribeEvents({cursor:initial,onEvent:event=>{sessionStorage.setItem(cursorKey,String(event.seq));void refreshState().catch(()=>{});},onReset:async()=>{const fresh=await refreshState();sessionStorage.setItem(cursorKey,String(fresh.seq));return fresh.seq;},onConnection:value=>{setConnected(value);if(value)void refreshState().catch(()=>{});}});
    // Snapshot changes invalidate views without restarting the SSE subscription.
  },[authenticated,online,api,refreshState,!!snapshot]);
  async function action(work:()=>Promise<void>){setBusy(true);setError('');try{await work();}catch(cause){fail(cause);throw cause;}finally{setBusy(false);}}
  const run=(work:()=>Promise<void>)=>action(work).catch(()=>{});
  async function command(work:()=>Promise<void>){await action(work);void refreshState().catch(()=>{});}
  const disabled=busy||!online||!connected;
  const openDocument=(path:string)=>navigate({page:'knowledge',entity:path});
  const selectedTask=snapshot?.tasks.find(t=>t.id===selections.current.tasks)??snapshot?.tasks.find(t=>!t.parentTaskId);
  const chats=snapshot?recentConversations(snapshot):[];
  const selectedChat=chats.find(s=>s.session.id===selections.current.conversations)??chats.find(s=>s.session.id===defaultConversation.current)??chats[0];
  // Keep implicit selection across feature remounts without opening mobile detail
  // or changing the bare route. Skill trials select their own explicit context.
  if(route.page==='conversations'&&selectedChat&&!route.entity)defaultConversation.current=selectedChat.session.id;
  useEffect(()=>{if(authenticated&&online&&startup?.phase==='ready')void loadInbox();return()=>{inboxGeneration.current++;};},[authenticated,online,connected,snapshot?.seq,loadInbox,startup?.phase]);
  const resultReads=useResultReads(api,snapshot?.instanceId??'',authenticated&&startup?.phase==='ready',online,loadInbox,fail);
  const connection=!online?'Unavailable offline':authenticated?(startup?.phase!=='ready'?'Paired · choose a vault':connected?'Connected · local instance':'Reconnecting to instance…'):'Local instance connection';
  function page() {
    if(!authenticated)return <Login busy={busy} offline={!online} connect={secret=>run(async()=>{await api.login(secret);setAuthenticated(true);sessionStorage.removeItem(cursorKey);await loadStartup();})}/>;
    if(startup&&startup.phase!=='ready')return <VaultSetup api={api} startup={startup} disabled={busy||!online} onReady={async value=>{setStartup(value);checkedSetup.current=false;await refreshState();}}/>;
    if(!snapshot)return <main className="loading-state"><span className="loading-dot"/><p>Loading your workspace…</p></main>;
    const common={api,snapshot,disabled};
    switch(route.page) {
      case 'projects':return <Projects {...common} route={route} navigate={navigate}/>;
      case 'setup':return <Onboarding {...common} refresh={refreshState} onOpenConversation={id=>navigate({page:'conversations',entity:id})} onOpenTask={id=>navigate({page:'tasks',entity:id})}/>;
      case 'groups':return <Groups {...common} route={route} navigate={navigate} refresh={refreshState}/>;
      case 'agents':return <Agents {...common} route={route} navigate={navigate} refresh={refreshState} onOpenConversation={id=>navigate({page:'conversations',entity:id})}/>;
      case 'settings':return <Settings {...common} refresh={refreshState} appearance={appearance} setAppearance={setAppearance} vaultDir={startup?.vaultDir}/>;
      case 'inbox':return <Inbox items={attention} disabled={disabled} error={inboxError} loading={inboxLoading} retry={()=>void loadInbox()}/>;
      case 'results':return route.entity?<ResultDetail key={route.entity} api={api} id={route.entity} currentRevision={attention.find(i=>i.id===route.entity)?.revision}/>:<main><h1>Result not found</h1></main>;
      case 'routines':case 'schedules':return <Schedules {...common}/>;
      case 'remote-status':return <RemoteStatus {...common} openLocal={async agentId=>{await command(async()=>{const created=await api.createSession({agentId});navigate({page:'conversations',entity:created.id});});}}/>;
      case 'knowledge':return <Knowledge api={api} requestedPath={route.entity??''} onOpenDocument={openDocument}/>;
      case 'skills':return <Skills api={api} requested={route.entity} requestedContext={route.skillContext} snapshot={snapshot} navigate={navigate} openDocument={openDocument}/>;
      case 'learning':return <Learning api={api} snapshot={snapshot} openDocument={openDocument}/>;
      case 'tasks':return <TaskWorkspace {...common} route={route} online={online} connected={connected} command={command} navigate={navigate} drafts={drafts.current}/>;
      case 'conversations':return <ConversationWorkspace {...common} route={route} selectedId={selectedChat?.session.id} command={command} navigate={navigate} drafts={drafts.current}/>;
      default:return <main className="operations"><h1>Page not found</h1><p>The link does not match a page in this workspace.</p><a href="#conversations">Go to conversations</a></main>;
    }
  }
  return <ResultReadContext.Provider value={resultReads}><AppShell inboxCount={attention.length} route={route} name={snapshot?.name??'Lorecrew'} connection={connection} authenticated={authenticated&&startup?.phase==='ready'} disabled={busy||!online} linkFor={page=>routeHash({page,...(selections.current[page]?{entity:selections.current[page]}:{})})} disconnect={()=>void run(async()=>{await api.logout();clearDefinitionDrafts();clearProjectDrafts();clearTabDrafts();drafts.current.clear();setAttention([]);setInboxLoading(true);selections.current={};defaultConversation.current=undefined;setAuthenticated(false);setSnapshot(undefined);setStartup(undefined);checkedSetup.current=false;sessionStorage.removeItem(cursorKey);})}>
    {error&&<div className="error" role="alert">{error}<button className="text-button" onClick={()=>setError('')} aria-label="Dismiss error">Dismiss</button></div>}
    {refreshError&&<div className="error" role="alert">{refreshError}<button className="text-button" disabled={busy||!online} onClick={()=>void refreshState().catch(()=>{})}>Refresh team state</button></div>}
    {agentUse}<Suspense fallback={<main className="loading-state"><p>Loading team workspace…</p></main>}>{page()}</Suspense>
  </AppShell></ResultReadContext.Provider>;
}
