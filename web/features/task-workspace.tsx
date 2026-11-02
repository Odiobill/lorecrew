import {RepositoryStatus} from './repository-status.js';
import {SessionResults} from './session-results.js';
import { lazy,Suspense,useState } from 'react';
import type { ApiClient,Snapshot } from '../api.js';
import type { Route } from '../navigation.js';
import { Icon } from '../components/icon.js';
import { StopWork } from '../components/stop-work.js';
import { Tasks,status } from './tasks.js';
import { Decisions } from './decisions.js';
import { Conversation } from './conversation.js';
import type { ConversationState } from './conversation-state.js';
const Changes=lazy(()=>import('./changes.js'));

export function TaskWorkspace({api,snapshot,route,disabled,online,connected,command,navigate,drafts}: {
  api:ApiClient;snapshot:Snapshot;route:Route;disabled:boolean;online:boolean;connected:boolean;
  command:(work:()=>Promise<void>)=>Promise<void>;navigate:(route:Route)=>void;drafts:ConversationState;
}) {
  const [diff,setDiff]=useState<{workspaceId:string;text:string}>();const [error,setError]=useState('');
  const task=route.entity?snapshot.tasks.find(t=>t.id===route.entity):snapshot.tasks.find(t=>!t.parentTaskId);
  const taskSession=snapshot.sessions.find(s=>s.session.id===task?.executingSessionId);
  const subtree=new Set(task?[task.id]:[]);
  for(let added=true;added;){added=false;for(const item of snapshot.tasks)if(item.parentTaskId&&subtree.has(item.parentTaskId)&&!subtree.has(item.id)){subtree.add(item.id);added=true;}}
  const sessionIds=new Set(snapshot.tasks.filter(item=>subtree.has(item.id)).map(item=>item.executingSessionId));
  const stopState=snapshot.sessions.some(s=>sessionIds.has(s.session.id)&&s.stopState==='requested')?'requested':task?.state==='cancelled'?'confirmed':undefined;
  return <main className={'workspace task-workspace'+(route.entity?' has-selection':'')}>
    <div className="primary"><Tasks snapshot={snapshot} selected={task?.id??''} select={id=>{setDiff(undefined);navigate({page:'tasks',entity:id});}} disabled={disabled} assign={async(objective,projectId,leadAgentId)=>{await command(async()=>{const created=await api.assign({objective,projectId,leadAgentId});navigate({page:'tasks',entity:created.id});});}}/></div>
    <div className="detail"><a className="back-link" href="#tasks"><Icon name="back"/>All tasks</a><Decisions drafts={drafts} decisions={snapshot.decisions} disabled={disabled} answer={(id,text)=>command(async()=>{await api.answer(id,text);})}/>
      <section className="panel task-detail">{task?<><div className="detail-title"><div><p className="eyebrow">TASK WORKSPACE</p><h2>{task.objective}</h2></div><span className="badge">{status(task.state)}</span></div><p className="muted">{snapshot.agents.find(a=>a.id===task.agentId)?.name??task.agentId} · {task.parentTaskId?'Delegated task':'Lead task'}</p>
        <RepositoryStatus api={api} kind="project" id={task.projectId} snapshot={snapshot}/>{task.blockedReason&&<p role="status">Blocked: {task.blockedReason}</p>}
        {snapshot.tasks.some(t=>t.parentTaskId===task.id)&&<div className="related-tasks"><h3>Delegated work</h3>{snapshot.tasks.filter(t=>t.parentTaskId===task.id).map(t=><button className="secondary" key={t.id} onClick={()=>navigate({page:'tasks',entity:t.id})}>{t.objective}</button>)}</div>}
        {task.parentTaskId?(task.outcome!==undefined&&<section aria-label="Task result"><h3>Result</h3><pre className="outcome">{JSON.stringify(task.outcome,null,2)}</pre></section>):<SessionResults api={api} sessionId={task.executingSessionId} sequence={snapshot.seq} embedded fallback={task.outcome!==undefined&&<section aria-label="Task result"><h3>Result</h3><pre className="outcome">{JSON.stringify(task.outcome,null,2)}</pre></section>}/>}
        <button className="secondary" disabled={!online||!connected||!task.workspaceId} onClick={()=>{setError('');void api.diff(task.workspaceId).then(result=>setDiff({workspaceId:task.workspaceId,text:result.diff})).catch(cause=>setError(cause instanceof Error?cause.message:'Could not inspect changes.'));}}>Inspect changes</button>
        <StopWork key={'stop:'+task.id} kind="task" active={!['completed','cancelled','failed'].includes(task.state)} disabled={disabled} stopState={stopState} stop={async()=>{let proof!:{quiescent:boolean;reason?:string};await command(async()=>{proof=await api.cancelTask(task.id);});return proof;}}/>
        {error&&<p role="alert">{error}</p>}{diff?.workspaceId===task.workspaceId&&<Suspense fallback={<p>Loading changes…</p>}><Changes diff={diff.text}/></Suspense>}
        <h3>Output &amp; guidance</h3><Conversation key={task.id} session={taskSession} disabled={disabled||['completed','cancelled','failed'].includes(task.state)} drafts={drafts} label="Task guidance" button="Send guidance" send={text=>command(async()=>{await api.steer(task.id,text);})}/>
      </>:<div className="workspace-empty"><div className="empty-emblem"><Icon name="tasks"/></div><h2>{route.entity?'Task not found':'Ready for your first task'}</h2><p>{route.entity?'This task is not available on this instance.':'Choose a project and lead agent to begin.'}</p></div>}</section>
    </div>
  </main>;
}
