import {useState} from 'react';
import {ApiError,type ApiClient,type Snapshot} from '../api.js';
import type {AgentDefinition} from '../../src/agents/types.js';
import {useDefinitionDrafts,pendingSave,type DefinitionDraft} from './definition-drafts.js';
import {withGroupMembership} from './group-membership.js';
export function GroupMembers({api,snapshot,groupId,disabled,refresh,allowAdd=true}:{api:ApiClient;snapshot:Snapshot;groupId:string;disabled:boolean;refresh:()=>Promise<Snapshot>;allowAdd?:boolean}){
 const {drafts,put,storageError}=useDefinitionDrafts<AgentDefinition>(snapshot.instanceId,'memberships:'+groupId);
 const [query,setQuery]=useState(''),[states,setStates]=useState<Record<string,{busy?:boolean;error?:string;conflict?:boolean;ready?:boolean}>>({});
 const all=[...snapshot.agents,...Object.values(drafts).filter(d=>!snapshot.agents.some(a=>a.id===d.value.id)).map(d=>d.base??d.value)];
 const filtered=all.filter(a=>allowAdd||a.groups.includes(groupId)||drafts[a.id]).filter(a=>drafts[a.id]||`${a.name} ${a.id}`.toLowerCase().includes(query.toLowerCase())).sort((a,b)=>Number(b.groups.includes(groupId))-Number(a.groups.includes(groupId))||a.name.localeCompare(b.name));
 async function change(agent:AgentDefinition,member:boolean){const id=agent.id;const existing=drafts[id];if(disabled||states[id]?.busy||states[id]?.conflict||!allowAdd&&member)return;
  const next=existing?.value??withGroupMembership(agent,groupId,member);if(next===agent)return;
  const active:DefinitionDraft<AgentDefinition>=existing??{base:agent,value:next};const pending=pendingSave(active);const queued={...active,pending};put(id,queued);setStates(s=>({...s,[id]:{busy:true}}));
  try{await api.operateWithKey('/agents/'+encodeURIComponent(id),pending.body,pending.key,'PUT');await refresh();put(id,undefined,queued);setStates(s=>({...s,[id]:{}}));}
  catch(cause){const conflict=cause instanceof ApiError&&cause.status===409;if(cause instanceof ApiError&&cause.status<500&&cause.status!==408)put(id,{...active,pending:undefined},queued);setStates(s=>({...s,[id]:{error:conflict?'Agent definition changed. Reload the current definition before retrying this membership action.':cause instanceof Error?cause.message:'Could not change membership.',conflict}}));}
 }
 async function reload(id:string){setStates(s=>({...s,[id]:{...s[id],busy:true}}));try{const fresh=await refresh();const agent=fresh.agents.find(a=>a.id===id);if(!agent)throw new Error('Agent not found. The membership action is retained.');const member=drafts[id]!.value.groups.includes(groupId);const value=withGroupMembership(agent,groupId,member);if(value===agent){put(id,undefined);setStates(s=>({...s,[id]:{}}));return;}put(id,{base:agent,value});setStates(s=>({...s,[id]:{ready:true}}));}catch(cause){setStates(s=>({...s,[id]:{conflict:true,error:cause instanceof Error?cause.message:'Could not reload agent.'}}));}}
 return <section aria-label="Group members" className="team-related"><h3>Members</h3><p className="muted">Each action saves one agent with a revision check. Group name and description save separately.</p><label>Search members<input type="search" value={query} onChange={e=>setQuery(e.target.value)}/></label>{storageError&&<p role="alert" className="error">{storageError}</p>}
 {!all.length&&<p className="muted">No agents yet. Create an agent to add a member.</p>}{all.length>0&&!filtered.length&&<p className="muted">No matching agents.</p>}
 {filtered.map(agent=>{const draft=drafts[agent.id],state=states[agent.id];const shown=draft?.base??agent;const member=draft?draft.value.groups.includes(groupId):agent.groups.includes(groupId);const stale=!!draft?.base&&draft.base.revision!==agent.revision&&!draft.pending;
 return <article key={agent.id} aria-label={'Member '+shown.name} className="member-row"><div><a href={'#agents/'+encodeURIComponent(agent.id)}>{shown.name}</a><p>{agent.groups.includes(groupId)?'Member':'Not a member'} · {shown.model.provider} / {shown.model.modelId}</p><details><summary>Membership revision</summary><code>{draft?.base?.revision??agent.revision}</code></details></div>
 {state?.error&&<p role="alert" className="error">{state.error}</p>}{draft&&!state?.error&&<p className="muted">Membership action retained. {draft.pending?'Retry to recover its outcome.':'Review the current definition before retrying.'}</p>}
 {(state?.conflict||stale)&&<button disabled={disabled||state?.busy} className="secondary" onClick={()=>void reload(agent.id)}>Reload current definition</button>}
 {state?.ready&&<p className="muted">Current saved fields are loaded; only this membership will change on retry.</p>}
 <button className={agent.groups.includes(groupId)?'secondary':''} disabled={disabled||state?.busy||state?.conflict||stale} onClick={()=>void change(shown,draft?member:!member)}>{state?.busy?<><span className="busy-spinner"/> Saving membership…</>:draft?member?'Retry add member':'Retry remove member':member?'Remove member':'Add member'}</button>
 {draft&&!state?.busy&&<button className="text-button" disabled={disabled||!!draft.pending} onClick={()=>{put(agent.id,undefined);setStates(s=>({...s,[agent.id]:{}}));}}>Discard membership action</button>}
 </article>;})}</section>;
}
