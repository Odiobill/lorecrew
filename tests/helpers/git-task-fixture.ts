import {INITIAL_VAULT_INDEX} from '../../src/vault/start.js';
import {mkdir,access,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {openState} from '../../src/instance/state.js';
import {attachVault} from '../../src/instance/open.js';
import {openVault} from '../../src/vault/write.js';
import {GitClient} from '../../src/git/client.js';
import {openRepositories} from '../../src/repositories/service.js';
import {planVaultIdentity,readVaultIdentity} from '../../src/repositories/identity.js';
import {ensureLocalAuthority} from '../../src/projects/authority-domain.js';
import {openConfiguredOwnership} from '../../src/projects/configured-ownership.js';
import {bindProject} from '../../src/projects/bindings.js';
import {WorkspaceManager} from '../../src/workspaces/manager.js';
import {ProcessSupervisor} from '../../src/workspaces/processes.js';
import {openRuntime} from '../../src/runtime/pi-host.js';
import {scriptedProvider,fauxAssistantMessage,fauxToolCall} from './scripted-provider.js';
import {gitProject} from './git-project.js';
export async function gitTaskFixture(root:string,scenario='single',pausePhase?:string){
 const state=await openState({stateDir:join(root,'state')}),git=new GitClient(),vaultDir=join(root,'vault'),project=join(root,'project');
 try{await access(join(vaultDir,'.git'));}catch{const identity=await planVaultIdentity(state,vaultDir,'vault');await openRepositories({state,git}).create({repo:{kind:'vault',id:identity.vaultId,path:vaultDir},parentPath:root,folderName:'vault',scaffold:[{path:'index.md',content:INITIAL_VAULT_INDEX},{path:'.lorecrew/vault.json',content:JSON.stringify(identity)+'\n'}]},'vault');}
 const ctx=await attachVault(state,vaultDir);await ensureLocalAuthority(ctx,await readVaultIdentity(vaultDir),'authority');const ownership=openConfiguredOwnership(ctx,git);
 try{await access(join(project,'.git'));}catch{await gitProject(project);}
 if(!await ctx.store.read('assignment-grants','code'))await ownership.claim({id:'code',repositoryKey:'fork:git-task-fixture',title:'Code'},'claim');await bindProject(ctx,{projectId:'code',path:project});
 await mkdir(join(vaultDir,'agents'),{recursive:true});await writeFile(join(vaultDir,'agents','piren.md'),'---\ntype: Agent\ntitle: Piren\nlorecrew:\n  id: piren\n  name: Piren\n  personality: Direct\n  responsibilities: [Implementation]\n  groups: []\n  model: {provider: scripted, modelId: test-model}\n---\n');
 if(pausePhase){const transact=ctx.store.transact.bind(ctx.store);let paused=false;ctx.store.transact=async fn=>{const result=await transact(fn);if(!paused){const tasks=await ctx.store.list<{parentTaskId?:string;state:string}>('team-task'),workspaces=await ctx.store.list<{taskId:string;state:string}>('workspace');const child=tasks.some(t=>!!t.parentTaskId);const match=pausePhase==='workspace-creating'?workspaces.some(w=>w.state==='creating'):pausePhase==='workspace-active'?workspaces.some(w=>w.state==='active'):pausePhase==='child-queued'?child:pausePhase==='child-active'?child&&workspaces.filter(w=>w.state==='active').length>1:pausePhase==='completed'?tasks.some(t=>!t.parentTaskId&&t.state==='completed'):false;if(match){paused=true;await writeFile(join(root,'paused'),pausePhase);await new Promise<void>(()=>{});}}return result;};}
 const supervisor=new ProcessSupervisor(ctx),workspaces=new WorkspaceManager(ctx),provider=scriptedProvider();const observations:Array<{objective:string;input:string}>=[];
 const delegate=(objective:string,dependsOn='[]')=>`tools.team_delegate({agentId:'piren',objective:'${objective}',deliverable:'edit and report',contextPaths:[],dependsOn:${dependsOn}})`;
 const shell=(role:string)=>`printf '${role}\\n' >> order`;
 provider.faux.setResponses(Array.from({length:100},()=>async(context:import('@earendil-works/pi-ai').Context)=>{const input=JSON.stringify(context.messages[0]),id=input.match(/Team assignment: ([a-f0-9]+)/)?.[1];const task=id?await ctx.store.read<{id:string;objective:string;state:string}>('team-task',id):undefined;if(!task)throw Error('Actual Git assignment required');observations.push({objective:task.objective,input});if(['completed','failed','cancelled'].includes(task.state))return fauxAssistantMessage('Finished');
  let code:string;
  if(context.messages.some(m=>m.role==='toolResult')){for(let n=0;n<1000;n++){const children=(await ctx.store.list<{parentTaskId?:string;state:string}>('team-task')).filter(t=>t.parentTaskId===id);if(children.every(t=>['completed','failed','cancelled'].includes(t.state)))break;await new Promise(r=>setTimeout(r,10));}code="text(await tools.team_report({state:'completed',outcome:{summary:'done'}}));";}
  else if(task.objective==='root')code=`text(await tools.bash({command:${JSON.stringify(shell('parent-before'))}}));const first=JSON.parse(await ${delegate('child-one')});${scenario==='siblings'?`text(await ${delegate('child-two','[first.id]')});`:''}text(await tools.bash({command:${JSON.stringify(shell('parent-after'))}}));`;
  else code=`${scenario==='nested'&&task.objective==='child-one'?`text(await ${delegate('grandchild')});`:''}text(await tools.write({path:'child.txt',content:'before'}));text(await tools.edit({path:'child.txt',oldText:'before',newText:'after'}));text(await tools.bash({command:${JSON.stringify(shell(task.objective))}}));`;
  return fauxAssistantMessage(fauxToolCall('codemode',{code}),{stopReason:'toolUse'});
 }));
 const runtime=await openRuntime({ctx,vault:openVault(ctx),ownership,workspaces,supervisor,models:provider.models});return {ctx,runtime,supervisor,project,workspaces,ownership,observations,...provider,async run(){return runtime.team.createTask({requestId:'root',projectId:'code',leadAgentId:'piren',objective:'root'});},async close(){for(const task of await ctx.store.list<{executingSessionId:string;parentTaskId?:string}>('team-task'))if(!task.parentTaskId)await runtime.cancel(task.executingSessionId);await runtime.close();await ctx.close();}};
}
