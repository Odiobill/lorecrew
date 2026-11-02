import {RepositoryStatus} from './repository-status.js';
import type { Appearance } from '../appearance.js';
import { Icon } from '../components/icon.js';
import { useEffect,useState } from 'react';
import { ProviderPanel } from './providers.js';
import { SetupReadiness } from './onboarding.js';
import type { Static } from 'typebox';
import type { AssignmentViewSchema } from '../../src/api/schemas.js';
import type { ApiClient,Snapshot } from '../api.js';
type Assignment=Static<typeof AssignmentViewSchema>;
export function Settings({api,snapshot,disabled,refresh,appearance,setAppearance,vaultDir}:{appearance:Appearance;setAppearance:(value:Appearance)=>void;vaultDir?:string|undefined;api:ApiClient;snapshot:Snapshot;disabled:boolean;refresh:()=>Promise<unknown>}){
 const [assignment,setAssignment]=useState<Assignment>(),[curatorSelection,setCuratorSelection]=useState<string>(),[message,setMessage]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 // Only explicit choices are state; defaults use the returned assignment and latest snapshot.
 const curator=curatorSelection??assignment?.pending?.agentId??assignment?.assignment?.agentId??snapshot.agents[0]?.id??'';
 const locked=disabled||busy;
 const fail=(e:unknown)=>setError(e instanceof Error?e.message:'Cannot load settings');
 useEffect(()=>{void api.operations<Assignment>('/learning/assignment').then(setAssignment).catch(fail);},[api]);

 async function run(work:()=>Promise<void>,notice:string){setBusy(true);setError('');setMessage('');try{await work();setMessage(notice);await refresh();}catch(e){fail(e);}finally{setBusy(false);}}
 return <main className="operations"><div className="page-heading"><p className="eyebrow">THIS INSTANCE</p><h1>Settings</h1><p className="muted">Portable definitions are shared. Credentials and project paths belong to this instance.</p></div>{error&&<p role="alert" className="error">{error}</p>}{message&&<p role="status">{message}</p>}<SetupReadiness api={api} snapshot={snapshot}/><div className="operations-grid">
 <section className="panel"><h2>Appearance</h2><div role="group" aria-label="Appearance" className="appearance-choices">{(['system','light','dark'] as const).map(value=><button key={value} className={appearance===value?'selected':'secondary'} aria-pressed={appearance===value} onClick={()=>setAppearance(value)}><Icon name={value==='system'?'monitor':value==='light'?'sun':'moon'}/>{value.slice(0,1).toUpperCase()+value.slice(1)}</button>)}</div><p className="muted">Saved for this browser. System follows your device appearance.</p></section>
 <section className="panel" aria-label="Knowledge vault"><h2>Knowledge vault</h2><RepositoryStatus api={api} kind="vault" id="current" snapshot={snapshot}/>{vaultDir&&<p className="vault-path"><Icon name="folder"/><code>{vaultDir}</code></p>}<p className="muted">Readable shared Markdown. Private state and credentials stay separate.</p></section>
 <section className="panel"><h2>Team definitions</h2><p>Manage instructions, models, memberships and session revisions in the dedicated team pages.</p><div className="definition-actions"><a href="#agents">Manage agents</a><a href="#groups">Manage groups</a></div></section>
 <ProviderPanel api={api} disabled={locked} refresh={refresh}/>
 <section className="panel"><h2>Learning curator</h2>{assignment&&<><p>Execution owner: {assignment.assignment?.ownerId??'Unassigned'}</p>{assignment.pending&&<p role="status">Pending curator reassignment. Resume the selected change to settle its recorded intent.</p>}<label>Curator agent<select value={curator} onChange={e=>setCuratorSelection(e.target.value)}>{snapshot.agents.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p className="muted">Changing the curator pauses admission and settles existing work. Prior sessions retain their original identity.</p><button disabled={locked||!curator||!!assignment.assignment&&assignment.assignment.ownerId!==snapshot.instanceId} onClick={()=>void run(async()=>setAssignment(await api.operate<Assignment>('/learning/assignment',{agentId:curator,expectedRevision:assignment.pending?.expectedRevision??assignment.revision},'PUT')),'Curator assignment saved.')}>Assign curator here</button></>}</section>
 <section className="panel"><h2>Projects</h2><p>Review recorded projects, local checkouts and execution readiness in Projects.</p><a href="#projects">Manage projects</a></section>
 </div></main>;
}
