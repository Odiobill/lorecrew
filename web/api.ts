import type {openProjectCatalogView,ProjectCatalogItem} from '../src/projects/catalog-view.js';
export type {ProjectCatalogItem};
export type ProjectCatalog=Awaited<ReturnType<ReturnType<typeof openProjectCatalogView>['list']>>;
export type ProjectDetailView=Awaited<ReturnType<ReturnType<typeof openProjectCatalogView>['detail']>>;
import type { AgentUseTarget } from '../src/setup/agent-use.js';
import type { StartupView } from '../src/setup/types.js';
import {registerPendingSource} from './draft-guard.js';
import type { ScopeTarget,SkillDraftFields,SkillDraftInput,DraftReview,DraftResult,openSkillManagement } from '../src/skills/manage.js';
import type { GitHubSourceInput,SourceSnapshot,NativeImportPreview } from '../src/skills/import/types.js';
import type { LocalImportPreview } from '../src/skills/import.js';
export type SkillManager=ReturnType<typeof openSkillManagement>;
export type SkillAuthoring=Awaited<ReturnType<SkillManager['authoring']>>;
export type ScopePreview=Awaited<ReturnType<SkillManager['scopePreview']>>;
export type SkillOperations=Awaited<ReturnType<SkillManager['operations']>>;
export type RemoteSkillPreview=LocalImportPreview&{nativeImport:NativeImportPreview};
export type SkillResourceView={path:string;revision:string;originalPath:string;kind:string;contentText:string;sha256:string;links:Array<{originalTarget:string;resourcePath:string;available:boolean}>};
import type { Static } from 'typebox';
import type { SnapshotSchema, SessionRefSchema, SessionSnapshotSchema, TaskSchema, DecisionSchema, AuthSessionSchema, TaskInput, SessionInput, DiffSchema, EventSchema, KnowledgeSearchSchema, KnowledgeDocumentSchema, SkillPageSchema, SkillInspectionSchema, LoadedSkillSchema, LearningPageSchema, LearningReviewsSchema } from '../src/api/schemas.js';
export type Snapshot=Static<typeof SnapshotSchema>;
export type Session=Static<typeof SessionSnapshotSchema>;
export type Task=Static<typeof TaskSchema>;
export type Decision=Static<typeof DecisionSchema>;
export type AppEvent=Static<typeof EventSchema>;
export type KnowledgeSearch=Static<typeof KnowledgeSearchSchema>;
export type KnowledgeDocument=Static<typeof KnowledgeDocumentSchema>;
export type SkillPage=Static<typeof SkillPageSchema>;
export type SkillInspection=Static<typeof SkillInspectionSchema>;
export type LoadedSkill=Static<typeof LoadedSkillSchema>;
export type LearningPage=Static<typeof LearningPageSchema>;
export type LearningReviews=Static<typeof LearningReviewsSchema>;
type Auth=Static<typeof AuthSessionSchema>;
export class ApiError extends Error {constructor(public status:number,message:string){super(message);}}
export interface ApiClient {
  setAgentUseHandler?(handler:((target:AgentUseTarget)=>Promise<void>)|undefined):void;
  startup():Promise<StartupView>;
  confirmOperation(path:string,body?:unknown,method?:'POST'|'PUT'):boolean;
  reconcileSnapshot(snapshot:Snapshot):Array<{id:string;text:string}>;
  reviewSkill(input:SkillDraftFields):Promise<DraftReview>;
  saveSkill(input:SkillDraftInput,key:string):Promise<DraftResult>;
  skillAuthoring(path:string):Promise<SkillAuthoring>;
  resolveSkillSource(input:GitHubSourceInput):Promise<SourceSnapshot>;
  previewSkill(input:{markdown:string}):Promise<LocalImportPreview>;
  previewSkill(input:{sourceId:string;skillPath:string}):Promise<RemoteSkillPreview>;
  discardSkillPreview(id:string):Promise<{ok:boolean}>;
  previewSkillFile(id:string,path:string):Promise<{originalPath:string;kind:string;contentText:string;sha256:string}>;
  skillResource(input:{qualifiedId:string;skillRevision:string;resourcePath:string}):Promise<SkillResourceView>;
  scopePreview(path:string,target:ScopeTarget):Promise<ScopePreview>;
  changeSkillScope(input:{path:string;expectedRevision:string;target:ScopeTarget;managementRevision:string},key:string):Promise<{qualifiedId:string;revision:string;previousQualifiedId:string;historyPath:string|null;noop:boolean}>;
  operations<T>(path:string):Promise<T>;
  providerAction<T>(path:string,body:unknown):Promise<T>;
  operateWithKey<T>(path:string,body:unknown,key:string,method?:'POST'|'PUT'):Promise<T>;
  operate<T>(path:string,body:unknown,method?:'POST'|'PUT'):Promise<T>;
  restore():Promise<void>;
  login(secret:string):Promise<void>;
  logout():Promise<void>;
  snapshot():Promise<Snapshot>;
  assign(input:TaskInput):Promise<Task>;
  createSession(input:SessionInput):Promise<Static<typeof SessionRefSchema>>;
  message(id:string,text:string):Promise<unknown>;
  steer(id:string,text:string):Promise<unknown>;
  cancelSession(id:string):Promise<{ok:boolean}>;
  cancelTask(id:string):Promise<{quiescent:boolean;reason?:string}>;
  answer(id:string,text:string):Promise<unknown>;
  diff(id:string):Promise<Static<typeof DiffSchema>>;
  searchKnowledge(input:{q:string;framework?:string;version?:string;cursor?:string;limit?:number}):Promise<KnowledgeSearch>;
  knowledgeDocument(path:string):Promise<KnowledgeDocument>;
  skills(input?:{q?:string;cursor?:string;limit?:number}):Promise<SkillPage>;
  skillInspection(input:{qualifiedId:string;sessionId?:string;candidatePath?:string;historyCursor?:string;historyLimit?:number}):Promise<SkillInspection>;
  loadSkill(input:{sessionId:string;qualifiedId:string;revision?:string;trial?:boolean}):Promise<LoadedSkill>;
  activateSkill(input:{proposalId:string;expectedActiveRevision:string|null;mode:'explicit_unvalidated'}):Promise<{revision:string}>;
  rollbackSkill(input:{qualifiedId:string;expectedActiveRevision:string;targetRevision:string}):Promise<{ok:boolean}>;
  learningProposals(input?:{q?:string;cursor?:string;limit?:number}):Promise<LearningPage>;
  learningReviews(input?:{q?:string;cursor?:string;limit?:number}):Promise<LearningReviews>;
}
/** getRandomValues also works on explicitly configured HTTP LAN origins. */
export function newOperationKey():string{return Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('');}
/** Only unacknowledged, explicitly retried commands keep an in-memory key. Nothing is queued. */
export function createApiClient():ApiClient {
  let agentUse:((target:AgentUseTarget)=>Promise<void>)|undefined;const preflighted=new Set<string>();
  let csrf='';const pending=new Map<string,string>();let activeMutations=0;
  registerPendingSource(()=>pending.size>0||activeMutations>0);
  async function request<T>(path:string,body?:unknown,key?:string,method:'POST'|'PUT'|'DELETE'='POST'):Promise<T> {
    if(body!==undefined&&!navigator.onLine)throw new Error('Unavailable offline. Reconnect before making changes.');
    if(body!==undefined&&key&&agentUse&&!preflighted.has(key)&&method==='POST'){
      let target:AgentUseTarget|undefined;const input=body as {agentId?:string;leadAgentId?:string};
      if(path==='/sessions'&&input.agentId)target={agentId:input.agentId};
      else if(path==='/tasks'&&input.leadAgentId)target={agentId:input.leadAgentId};
      else {const message=/^\/sessions\/([^/]+)\/messages$/.exec(path),steer=/^\/tasks\/([^/]+)\/steer$/.exec(path),answer=/^\/decisions\/([^/]+)\/answer$/.exec(path);
       if(message)target={sessionId:decodeURIComponent(message[1]!)};
       else if(steer||answer){const current=await request<Snapshot>('/snapshot');const taskId=steer?decodeURIComponent(steer[1]!):current.decisions.find(d=>d.id===decodeURIComponent(answer![1]!))?.taskId;const task=current.tasks.find(t=>t.id===taskId);if(task)target={sessionId:task.executingSessionId};}
      }
      if(target){try{await agentUse(target);}catch(e){if(e instanceof Error)Object.defineProperty(e,'beforeAdmission',{value:true});throw e;}preflighted.add(key);}
    }
    if(body!==undefined)activeMutations++;
    try{
    let response:Response;
    try {response=await fetch('/api/v1'+path,{method:body===undefined?'GET':method,credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf,...key?{'idempotency-key':key}:{}},...body===undefined?{}:{body:JSON.stringify(body)}});}
    catch {throw new Error('Connection lost. Retry this action to check its outcome.');}
    const data=await response.json();
    if(!response.ok)throw new ApiError(response.status,data.error?.message??'The instance could not complete this action.');
    return data as T;
    }finally{if(body!==undefined)activeMutations--;}
  }
  async function mutation<T>(path:string,body:unknown,method:'POST'|'PUT'='POST'):Promise<T> {
    const fingerprint=method+'\0'+path+'\0'+JSON.stringify(body);const previous=pending.get(fingerprint);const key=previous??newOperationKey();pending.set(fingerprint,key);
    try{const result=await request<T>(path,body,key,method);pending.delete(fingerprint);return result;}catch(e){if(e instanceof Error&&'beforeAdmission' in e||e instanceof ApiError&&e.status<500&&e.status!==408&&(e.status!==401||!previous))pending.delete(fingerprint);throw e;}
  }
  const confirmOperation=(path:string,body?:unknown,method:'POST'|'PUT'='POST')=>{
    if(body!==undefined)return pending.delete(method+'\0'+path+'\0'+JSON.stringify(body));
    let settled=false;for(const fingerprint of pending.keys())if(fingerprint.startsWith(method+'\0'+path+'\0')){pending.delete(fingerprint);settled=true;}return settled;
  };
  function reconcileSnapshot(snapshot:Snapshot):Array<{id:string;text:string}>{
    const answered:Array<{id:string;text:string}>=[];
    for(const fingerprint of pending.keys()){
      const [method,path,raw]=fingerprint.split('\0');if(method!=='POST'||!path)continue;
      const decision=/^\/decisions\/([^/]+)\/answer$/.exec(path);
      if(decision){const id=decodeURIComponent(decision[1]!);if(snapshot.decisions.some(d=>d.id===id&&d.state==='answered')){pending.delete(fingerprint);answered.push({id,text:(JSON.parse(raw??'{}') as {text:string}).text});}continue;}
      const session=/^\/sessions\/([^/]+)\/cancel$/.exec(path);
      if(session&&snapshot.sessions.some(s=>s.session.id===decodeURIComponent(session[1]!)&&s.stopState==='confirmed'))pending.delete(fingerprint);
      const task=/^\/tasks\/([^/]+)\/cancel$/.exec(path);
      if(task){const id=decodeURIComponent(task[1]!);const ids=new Set([id]);for(let changed=true;changed;){changed=false;for(const t of snapshot.tasks)if(t.parentTaskId&&ids.has(t.parentTaskId)&&!ids.has(t.id)){ids.add(t.id);changed=true;}}
        const sessions=new Set(snapshot.tasks.filter(t=>ids.has(t.id)).map(t=>t.executingSessionId));if(snapshot.tasks.some(t=>t.id===id&&t.state==='cancelled')&&snapshot.sessions.filter(s=>sessions.has(s.session.id)).every(s=>s.stopState==='confirmed'||['completed','failed','cancelled'].includes(s.status)&&s.stopState!=='requested'))pending.delete(fingerprint);
      }
    }
    return answered;
  }
  const params=(input:Record<string,string|number|undefined>)=>{const p=new URLSearchParams();for(const [key,value] of Object.entries(input))if(value!==undefined)p.set(key,String(value));return p.toString();};
  return {
    setAgentUseHandler:handler=>{agentUse=handler;},confirmOperation,reconcileSnapshot,startup:()=>request<StartupView>('/startup'),
    // Secret-bearing provider requests never enter the retry Map or browser storage.
    providerAction:(path,body)=>request(path,body,newOperationKey()),
    operations:path=>request(path),operateWithKey:(path,body,key,method)=>request(path,body,key,method),operate:(path,body,method)=>mutation(path,body,method),
    async restore(){csrf=(await request<Auth>('/auth/session')).csrfToken;},
    async login(secret){csrf=(await request<Auth>('/auth/login',{secret})).csrfToken;},
    async logout(){await request('/auth/logout',{});csrf='';pending.clear();},
    reviewSkill:input=>request('/skills/draft-preview',input,newOperationKey()),saveSkill:(input,key)=>request('/skills/drafts',input,key),
    skillAuthoring:path=>request('/skills/authoring?'+params({path})),resolveSkillSource:input=>request('/skills/import-sources',input,newOperationKey()),
    previewSkill:((input:{markdown:string}|{sourceId:string;skillPath:string})=>request('/skills/import-preview',input,newOperationKey())) as ApiClient['previewSkill'],
    discardSkillPreview:id=>request('/skills/import-previews/'+encodeURIComponent(id),{},newOperationKey(),'DELETE'),
    previewSkillFile:(id,path)=>request('/skills/import-previews/'+encodeURIComponent(id)+'/file?'+params({path})),skillResource:input=>request('/skills/resource?'+params(input)),
    scopePreview:(path,target)=>request('/skills/scope-preview',{path,target},newOperationKey()),changeSkillScope:(input,key)=>request('/skills/scope',input,key),
    snapshot:()=>request('/snapshot'),assign:input=>mutation('/tasks',input),createSession:input=>mutation('/sessions',input),
    message:(id,text)=>mutation(`/sessions/${encodeURIComponent(id)}/messages`,{text}),
    steer:(id,text)=>mutation(`/tasks/${encodeURIComponent(id)}/steer`,{text}),
    cancelSession:id=>mutation(`/sessions/${encodeURIComponent(id)}/cancel`,{}),
    cancelTask:id=>mutation(`/tasks/${encodeURIComponent(id)}/cancel`,{}),
    answer:(id,text)=>mutation(`/decisions/${encodeURIComponent(id)}/answer`,{text}),
    diff:id=>request(`/workspaces/${encodeURIComponent(id)}/diff`),
    searchKnowledge:input=>request('/knowledge/search?'+params(input)),knowledgeDocument:path=>request('/knowledge/document?'+params({path})),
    skills:(input={})=>request('/skills?'+params(input)),loadSkill:input=>mutation('/skills/load',input),
    skillInspection:input=>request('/skills/inspection?'+params(input)),
    activateSkill:input=>mutation('/skills/activate',input),rollbackSkill:input=>mutation('/skills/rollback',input),
    learningProposals:(input={})=>request('/learning/proposals?'+params(input)),learningReviews:(input={})=>request('/learning/reviews?'+params(input)),
  };
}
