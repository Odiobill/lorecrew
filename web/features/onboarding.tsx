import {ThinkingFields,validThinkingChoice} from './agent-form.js';
import { Icon } from '../components/icon.js';
import { useCallback,useEffect,useRef,useState } from 'react';
import type { ApiClient,Snapshot } from '../api.js';
import { ApiError,newOperationKey } from '../api.js';
import type { SetupView,SetupSaveInput,SetupPreference } from '../../src/setup/types.js';
import {useTabDraftState,getTabDraft,clearTabDrafts} from './tab-drafts.js';
import { SetupOperations } from './onboarding-state.js';
import { ProjectSetup } from './project-setup.js';
import { ProviderPanel } from './providers.js';

type Props={api:ApiClient;snapshot:Snapshot;disabled:boolean;refresh:()=>Promise<unknown>;onOpenConversation:(id:string)=>void;onOpenTask:(id:string)=>void};
const starters={
 personal:{name:'Personal assistant',instructions:'Be a thoughtful personal assistant. Help me plan, draft, reason, and find useful knowledge. Ask focused questions when context is missing. Be clear about uncertainty and the actions you can actually take.',responsibilities:'Planning and prioritization\nWriting and editing\nReasoning and knowledge retrieval',message:'Help me plan my day. Start by asking what matters most to me.'},
 coding:{name:'Coding lead',instructions:'Be a careful coding lead. Understand the goal and existing project before proposing changes. Keep work focused, preserve user changes, verify outcomes, and explain risks and evidence clearly.',responsibilities:'Understand and plan project work\nImplement and review focused changes\nVerify results and report evidence',message:'Help me understand this project and choose a useful first improvement.'},
};
const modelKey=(model:{provider:string;modelId:string})=>model.provider+'\0'+model.modelId;
const initialStep=(view:SetupView)=>view.state?.agentId?(view.state.preference==='coding'&&!view.state.completed&&!view.state.projectId?3:4):view.state?.preference?1:0;
const entityId=(kind:string,key:string)=>`setup-${kind}-${key}`;
const labels=['Starting point','Model','Agent','Project','Start'];
function Readiness({view}:{view:SetupView}){
 const text={missing_model:'Choose a model',missing_credential:'Credential needed',unverified:'Model unverified',verified:'Model response recorded',failed:'Model response failed'}[view.readiness.model];
 return <div className="setup-readiness" aria-live="polite"><span className={'status-badge '+(view.readiness.model==='verified'?'state-completed':'')}>{text}</span>{view.readiness.verifiedAt?<p>Last successful response: <time dateTime={view.readiness.verifiedAt}>{new Date(view.readiness.verifiedAt).toLocaleString()}</time>. This records a past response; availability can change.</p>:<p className="muted">Your first message checks the selected model. There is no separate test request.</p>}</div>;
}
export function SetupReadiness({api,snapshot}:{api:ApiClient;snapshot:Snapshot}){
 const [view,setView]=useState<SetupView>();
 useEffect(()=>{let active=true;void api.operations<SetupView>('/setup').then(v=>{if(active)setView(v);}).catch(()=>{});return()=>{active=false;};},[api,snapshot.seq]);
 return <section className="panel setup-entry"><div><p className="eyebrow">GET STARTED</p><h2>Setup & readiness</h2><p className="muted">Review your starting point, model connection, agent, and optional coding project.</p>{view?.state?.agentId&&<Readiness view={view}/>}</div><a className="button-link" href="#setup">Open setup wizard</a></section>;
}
export function Onboarding({api,snapshot,disabled,refresh,onOpenConversation,onOpenTask}:Props){
 const draftKey='setup:'+snapshot.instanceId+':';
 const operations=useRef(new SetupOperations(snapshot.instanceId));
 const creationKey=useRef<string|undefined>(undefined);
 const [reviewed,setReviewed]=useTabDraftState(draftKey+'vault-reviewed',false);
 const [view,setView]=useState<SetupView>(),[step,setStep]=useTabDraftState(draftKey+'step',0),[preference,setPreference]=useState<SetupPreference>('personal');
 const [providerId,setProviderId]=useTabDraftState(draftKey+'providerId','openai'),[chosenModel,setChosenModel]=useTabDraftState(draftKey+'chosenModel',''),[showUnavailable,setShowUnavailable]=useTabDraftState(draftKey+'showUnavailable',false),[name,setName]=useTabDraftState<string|undefined>(draftKey+'name',undefined),[instructions,setInstructions]=useTabDraftState<string|undefined>(draftKey+'instructions',undefined),[responsibilities,setResponsibilities]=useTabDraftState<string|undefined>(draftKey+'responsibilities',undefined);
 const [thinkingLevel,setThinkingLevel]=useTabDraftState<string|undefined>(draftKey+'thinkingLevel',undefined);
 const [existing,setExisting]=useTabDraftState(draftKey+'existing',''),[groupName,setGroupName]=useTabDraftState(draftKey+'groupName',''),[extraName,setExtraName]=useTabDraftState(draftKey+'extraName',''),[withTeam,setWithTeam]=useTabDraftState(draftKey+'withTeam',false),[message,setMessage]=useTabDraftState<string|undefined>(draftKey+'message',undefined);
 const [error,setError]=useState(''),[conflict,setConflict]=useState(false),[busy,setBusy]=useState(false),[working,setWorking]=useState('');
 const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
 const template=starters[preference];
 const candidates=snapshot.models.filter(m=>showUnavailable||m.available);
 const chosen=chosenModel?snapshot.models.find(m=>modelKey(m)===chosenModel):candidates.find(m=>m.provider===providerId)??candidates[0];
 const modelChoice=chosen?{provider:chosen.provider,modelId:chosen.modelId,...thinkingLevel===undefined?{}:{thinkingLevel}}:undefined;
 const modelOptions=chosen&&!candidates.includes(chosen)?[chosen,...candidates]:candidates;
 let suggestedName=template.name;for(let suffix=2;snapshot.agents.some(a=>a.name.trim().toLowerCase()===suggestedName.toLowerCase());suffix++)suggestedName=template.name+' '+suffix;
 useEffect(()=>{if(step===2&&!chosenModel&&chosen)setChosenModel(modelKey(chosen));},[step,chosenModel,chosen]);
 const agent=snapshot.agents.find(a=>a.id===view?.state?.agentId);
 const session=snapshot.sessions.find(s=>s.session.id===view?.state?.sessionId);
 const matchingSession=session&&agent&&modelKey(session.session.model)===modelKey(agent.model)&&session.session.agentRevision===agent.revision&&!['cancelled'].includes(session.status)?session:undefined;
 const locked=disabled||busy;
 const load=useCallback(async()=>{const v=await api.operations<SetupView>('/setup');operations.current.reconcile(v.state?.pendingOperations??{});setView(v);return v;},[api]);
 useEffect(()=>{void load().then(v=>{setStep(getTabDraft<number>(draftKey+'step')??initialStep(v));setPreference(v.state?.preference??'personal');setExisting(v.state?.agentId??'');}).catch(e=>setError(e.message));},[load]);
 async function run(work:()=>Promise<void>){setBusy(true);setError('');setConflict(false);try{await work();}catch(e){if(alive.current){setError(e instanceof Error?e.message:'Setup could not be completed.');setConflict(e instanceof ApiError&&e.status===409);}}finally{if(alive.current){setBusy(false);setWorking('');}}}
 async function save(choices:SetupSaveInput['choices'],pendingOperations=view?.state?.pendingOperations??{},base=view){
  const v=await api.operateWithKey<SetupView>('/setup',{expectedRevision:base?.state?.revision??null,choices,pendingOperations},newOperationKey(),'PUT');setView(v);operations.current.reconcile(v.state?.pendingOperations??{});return v;
 }
 async function reserve(kind:string,base=view,rotate=false){const pending={...base?.state?.pendingOperations};if(rotate)delete pending[kind];const key=rotate?newOperationKey():operations.current.key(kind,pending);const v=await save({}, {...pending,[kind]:key},base);return {key,view:v};}
 async function createFirst(){
  if(existing){const v=await save({agentId:existing,completed:false});setStep(v.state?.preference==='coding'?3:4);return;}
  if(!chosen||!modelChoice||!validThinkingChoice(modelChoice,snapshot.models))return;
  // The revision guard and reserved IDs precede every portable publication.
  let current=view;let groups:string[]=[];
  if(withTeam&&groupName.trim()){
   const op=await reserve('group',current);current=op.view;const id=entityId('group',op.key);
   const known=await api.operations<Array<{id:string}>>('/groups');if(!known.some(g=>g.id===id))await api.operateWithKey('/groups',{id,name:groupName.trim(),description:'Shared context for this starter team.'},op.key);
   current=await load();if(current.state?.groupId!==id)current=await save({groupId:id},undefined,current);groups=[id];
  }
  const key=creationKey.current??(current?.state?.agentId?newOperationKey():operations.current.key('agent',current?.state?.pendingOperations??{}));creationKey.current=key;
  const op={key,view:await save({}, {...current?.state?.pendingOperations,agent:key},current)},id=entityId('agent',key);current=op.view;
  const fresh=await api.snapshot();if(!fresh.agents.some(a=>a.id===id))await api.operateWithKey('/agents',{id,name:(name??suggestedName).trim(),personality:(instructions??template.instructions).trim(),responsibilities:(responsibilities??template.responsibilities).split('\n').map(s=>s.trim()).filter(Boolean),groups,model:modelChoice},op.key);
  current=await load();if(current.state?.agentId!==id)current=await save({agentId:id},undefined,current);
  if(withTeam&&extraName.trim()){
   const extra=await reserve('additionalAgent',current),extraId=entityId('additionalAgent',extra.key);current=extra.view;
   const known=await api.snapshot();if(!known.agents.some(a=>a.id===extraId))await api.operateWithKey('/agents',{id:extraId,name:extraName.trim(),personality:'Offer a careful second perspective. Explain uncertainty and support the lead agent.',responsibilities:['Review and offer a second perspective'],groups,model:modelChoice},extra.key);
   current=await load();if(!current.state?.additionalAgentIds.includes(extraId))current=await save({additionalAgentIds:[...current.state!.additionalAgentIds,extraId]},undefined,current);
  }
  setExisting(id);setName(undefined);creationKey.current=undefined;await refresh();setStep(preference==='coding'?3:4);
 }
 async function ensureSession(){
  let current=await load();const fresh=await api.snapshot();const selected=fresh.agents.find(a=>a.id===current.state?.agentId);if(!selected)throw new Error('Choose an agent before starting.');
  const existingSession=fresh.sessions.find(s=>s.session.id===current.state?.sessionId&&s.session.agentId===selected.id&&modelKey(s.session.model)===modelKey(selected.model)&&s.session.agentRevision===selected.revision&&s.status!=='cancelled');
  if(existingSession&&(current.readiness.model==='missing_credential'||current.readiness.sessionId===existingSession.session.id))return {id:existingSession.session.id,view:current};
  const op=await reserve('session',current,!!current.state?.sessionId);current=op.view;
  const created=await api.operateWithKey<{id:string}>('/sessions',{agentId:selected.id},op.key);current=await load();if(current.state?.sessionId!==created.id)current=await save({sessionId:created.id},undefined,current);
  await refresh();return {id:created.id,view:current};
 }
 async function finish(send:boolean){
  const first=await ensureSession();let current=first.view;
  if(send){
   const snapshot=await api.operations<import('../api.js').Session>('/sessions/'+first.id);
   const op=await reserve('message',current,snapshot.status==='failed'||snapshot.status==='blocked'||snapshot.status==='completed'&&current.readiness.model!=='verified');current=op.view;
   setWorking('Your agent is working…');await api.operateWithKey('/sessions/'+first.id+'/messages',{text:(message??template.message).trim()},op.key);
   for(;;){
    if(!alive.current)return;
    const latest=await api.operations<import('../api.js').Session>('/sessions/'+first.id);
    if(['failed','blocked','cancelled'].includes(latest.status)){await refresh();await load();throw new Error('The model did not complete your message. Your agent and draft are preserved. Repair the provider connection, then retry.');}
    current=await load();
    if(current.state?.agentId!==first.view.state?.agentId||current.state?.sessionId!==first.id)throw new ApiError(409,'Setup selection changed while your agent was working. Your draft is preserved. Reload saved progress before retrying.');
    if(current.readiness.model==='verified'&&current.readiness.sessionId===first.id)break;
    if(latest.status==='completed')throw new ApiError(409,'This response could not verify the current agent selection. Your draft is preserved. Reload saved progress or repair the provider before retrying.');
    await new Promise(resolve=>setTimeout(resolve,500));
   }
  }
  const pending={...current.state?.pendingOperations};if(send)delete pending.message;
  await save({completed:true},pending,current);await refresh();clearTabDrafts(draftKey);onOpenConversation(first.id);
 }
 async function assign(){
  const current=await load();if(current.readiness.project!=='ready')throw new Error('The project needs a valid ownership grant and binding before assignment.');
  const op=await reserve('task',current);setWorking('Assigning your first task…');const task=await api.operateWithKey<{id:string}>('/tasks',{projectId:current.state!.projectId,leadAgentId:current.state!.agentId,objective:(message??template.message).trim()},op.key);await save({completed:true},undefined,op.view);await refresh();clearTabDrafts(draftKey);onOpenTask(task.id);
 }
 if(!view)return <main className="operations"><h1>Setup</h1>{error?<p role="alert">{error}</p>:<p>Loading saved progress…</p>}</main>;
 const firstMessage=message??template.message;
 const projectStatus={not_selected:'No project selected',ready:'Project ready',claimed_unbound:'Ownership confirmed · repair binding',unavailable:'Project unavailable'}[view.readiness.project];
 return <main className="setup-page">
  <header className="setup-heading"><a href="#conversations" className="setup-exit"><Icon name="back"/>Workspace</a><p className="eyebrow">A WORKSPACE THAT STARTS WITH YOU</p><p className="setup-kicker">Set up Lorecrew <span>· {snapshot.name}</span></p><ol className="setup-steps" aria-label="Setup progress">{labels.filter(label=>preference==='coding'||label!=='Project').map(label=><li key={label} aria-current={labels[step]===label?'step':undefined}><span>{label}</span></li>)}</ol></header>
  {error&&<div className="error" role="alert">{error}{conflict&&<button className="secondary" disabled={locked} onClick={()=>void run(async()=>{await load();await refresh();})}>Reload saved progress</button>}</div>}
  {working&&<p className="setup-working" role="status"><span className="working-spinner" aria-hidden="true"/>{working}</p>}
  <section className="setup-card" aria-label="Setup wizard" aria-busy={busy}>
   <p>Knowledge vault: <code>{view.vault.path}</code></p>
   {view.entry==='workspace'&&!reviewed?<><h1>Your knowledge vault</h1><p>This instance is bound to this folder. Continue to review optional setup.</p><button disabled={locked} onClick={()=>setReviewed(true)}>Continue setup</button></>:<>

   {step===0&&<><p className="eyebrow">01 / YOUR STARTING POINT</p><h1>Make room for your next idea</h1><p className="setup-intro">A thoughtful assistant for everyday life, or a focused team for your code. Start where you need help today.</p><div className="setup-paths">{(['personal','coding'] as const).map(value=><button key={value} type="button" aria-label={value==='personal'?'Personal assistance':'Coding'} className={'setup-path '+(preference===value?'selected':'')} aria-pressed={preference===value} disabled={locked} onClick={()=>{setPreference(value);}}><span className="setup-path-symbol" aria-hidden="true">{value==='personal'?'✦':'⌘'}</span><strong>{value==='personal'?'Personal assistance':'Coding'}</strong><span>{value==='personal'?'Plan your day, shape a draft, think things through, and find knowledge.':'Understand a project, make changes, and verify work with a coding lead.'}</span><span className="setup-choice-marker" aria-hidden="true">{preference===value?'Selected':'Choose'}</span></button>)}</div><p className="muted">This sets your starting defaults. You can use both paths at any time.</p><div className="setup-actions"><button disabled={locked} onClick={()=>void run(async()=>{await save({preference,completed:false});setStep(1);})}>Continue to model <span aria-hidden="true">→</span></button></div></>}
   {step===1&&<><p className="eyebrow">02 / CONNECT A MODEL</p><h1>Connect a model</h1><p className="setup-intro">Choose a provider and use its sign-in or API-key flow. Detected credentials can be used as they are.</p><ProviderPanel api={api} disabled={locked} refresh={async()=>{await refresh();await load();}} onSelectProvider={setProviderId}/><p className="setup-note">Credentials alone do not verify a model. Sending your first message makes the actual request.</p><div className="setup-actions"><button className="secondary" disabled={locked} onClick={()=>setStep(0)}><Icon name="back"/>Back</button><button disabled={locked} onClick={()=>setStep(2)}>Continue to agent <span aria-hidden="true">→</span></button></div></>}
   {step===2&&<><p className="eyebrow">03 / {snapshot.agents.length?'YOUR AGENTS':'YOUR FIRST AGENT'}</p><h1>A helper with a clear purpose</h1><p className="setup-intro">{snapshot.agents.length?'Choose an existing agent or add another helper with its own purpose.':'Start with one agent. Give it a name and shape the instructions to suit you.'}</p>{snapshot.agents.length>0&&<label>Use an existing agent<select aria-label="Use an existing agent" value={existing} disabled={locked} onChange={e=>{setExisting(e.target.value);if(!e.target.value){creationKey.current=undefined;setName(undefined);setInstructions(undefined);setResponsibilities(undefined);setWithTeam(false);}}}><option value="">{snapshot.agents.length?'Create another agent':'Create a starter agent'}</option>{snapshot.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}{!existing&&<><label>Agent name<input value={name??suggestedName} disabled={locked} onChange={e=>setName(e.target.value)}/></label><label>Agent model<select aria-label="Agent model" value={chosen?modelKey(chosen):''} disabled={locked} onChange={e=>setChosenModel(e.target.value)}>{!chosen&&<option value="">Choose an available model</option>}{modelOptions.map(m=><option key={modelKey(m)} value={modelKey(m)}>{m.provider} · {m.name}{m.available?'':' · credential needed'}</option>)}</select></label>{modelChoice&&<ThinkingFields model={modelChoice} models={snapshot.models} disabled={locked} onChange={next=>setThinkingLevel(next.thinkingLevel)}/>}<label className="checkbox-row"><input type="checkbox" checked={showUnavailable} disabled={locked} onChange={e=>setShowUnavailable(e.target.checked)}/>Show models without available credentials</label>{!chosen&&<p className="error">{snapshot.models.length?'No models have available credentials. Connect a provider, or show unavailable models to configure for later.':'No models are configured. Return to the provider connection step.'}</p>}{chosen&&!chosen.available&&<p className="setup-note">The selected model needs credentials. Your selection is preserved; connect its provider before sending.</p>}<label>Starter instructions<textarea rows={5} value={instructions??template.instructions} disabled={locked} onChange={e=>setInstructions(e.target.value)}/></label><label>Responsibilities (one per line)<textarea rows={3} value={responsibilities??template.responsibilities} disabled={locked} onChange={e=>setResponsibilities(e.target.value)}/></label><details><summary>Optional starter team</summary><label className="checkbox-row"><input type="checkbox" checked={withTeam} disabled={locked} onChange={e=>setWithTeam(e.target.checked)}/>Add a group or a second agent</label>{withTeam&&<><label>Starter group name (optional)<input value={groupName} disabled={locked} onChange={e=>setGroupName(e.target.value)}/></label><label>Second agent name (optional)<input value={extraName} disabled={locked} onChange={e=>setExtraName(e.target.value)}/></label><p className="muted">A group organizes shared context. Conversations remain with one agent. Curator assignment is separate.</p></>}</details></>}<div className="setup-actions"><button className="secondary" disabled={locked} onClick={()=>setStep(1)}><Icon name="back"/>Back</button><button disabled={locked||(!existing&&(!chosen||!modelChoice||!validThinkingChoice(modelChoice,snapshot.models)||!(name??suggestedName).trim()||!(instructions??template.instructions).trim()))} onClick={()=>void run(createFirst)}>{existing?'Use selected agent':snapshot.agents.length?'Create agent':'Create first agent'}</button></div></>}
   {(preference==='coding'||step===3)&&<div hidden={step!==3}><p className="eyebrow">04 / OPTIONAL PROJECT</p><h1>Connect a project</h1><p className="setup-intro">Choose an optional managed project for any agent, or come back when you are ready.</p><ProjectSetup instanceId={snapshot.instanceId} onBusy={setBusy} draftKey={draftKey+'project:'} api={api} view={view} disabled={locked} run={run} refresh={refresh} reserve={async key=>{await save({}, {...view.state?.pendingOperations,project:key});}} onSelect={async projectId=>{const current=await load();await save({projectId},undefined,current);await refresh();setStep(4);}}/><div className="setup-actions"><button className="secondary" disabled={locked} onClick={()=>setStep(2)}><Icon name="back"/>Back</button><button className="secondary" disabled={locked} onClick={()=>setStep(4)}>Configure later</button>{view.readiness.project==='ready'&&<button disabled={locked} onClick={()=>setStep(4)}>Continue to start</button>}</div></div>}
   {step===4&&<><p className="eyebrow">{preference==='coding'?'05':'04'} / READY WHEN YOU ARE</p><h1>Your first conversation</h1><p className="setup-intro">{agent?`${agent.name} is ready to meet you.`:'Choose an agent to get started.'} Edit the opening message, then send it when you are ready.</p>{agent&&<div className="setup-agent-summary"><span className="avatar" aria-hidden="true">{agent.name.slice(0,1)}</span><div><strong>{agent.name}</strong><p className="muted">{agent.model.provider} · {agent.model.modelId}</p></div><button className="text-button" disabled={locked} onClick={()=>{setExisting(agent.id);setStep(2);}}>Change agent</button></div>}<Readiness view={view}/>{['failed','missing_credential','missing_model'].includes(view.readiness.model)&&<button className="secondary" disabled={locked} onClick={()=>setStep(1)}>Repair provider connection</button>}{<div className="setup-note"><p>{projectStatus}</p><button className="text-button" disabled={locked} onClick={()=>setStep(3)}>Review project</button></div>}<label>First message<textarea value={firstMessage} disabled={locked} rows={4} onChange={e=>setMessage(e.target.value)}/></label><p className="muted">Every agent can use shell, files, knowledge and memory with this instance’s OS permissions. Projects add managed coordination. External application connectors are deferred.</p>{matchingSession?.messages.some(m=>m.kind==='user')&&<p className="setup-note">This setup conversation already has a submitted message. Finish to open it, or explicitly send the text above as another message.</p>}<div className="setup-actions"><button className="secondary" disabled={locked} onClick={()=>setStep(preference==='coding'?3:2)}><Icon name="back"/>Back</button><button className="secondary" disabled={locked||!agent} onClick={()=>void run(()=>finish(false))}>Finish without sending</button><button disabled={locked||!agent||!firstMessage.trim()||['missing_model','missing_credential'].includes(view.readiness.model)} onClick={()=>void run(()=>finish(true))}>Send first message</button>{view.readiness.project==='ready'&&<button disabled={locked||!agent||!firstMessage.trim()||['missing_model','missing_credential'].includes(view.readiness.model)} onClick={()=>void run(assign)}>Assign first task</button>}</div></>}
  </>} </section><footer className="setup-footer"><span>Saved to this instance. Secrets and message drafts stay out of setup progress.</span><span>Pi Durable execution</span></footer>
 </main>;
}
