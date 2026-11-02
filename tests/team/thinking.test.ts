import {afterEach,expect,it} from 'vitest';
import {localTeam} from '../helpers/local-team.js';
import {thinkingCapture} from '../helpers/thinking-provider.js';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
it.each(['high','alien'])('native root and delegated helper honor thinking admission %s',async level=>{
 const f=await localTeam();closes.push(f.close);const capture=thinkingCapture();f.faux.setResponses(Array.from({length:10},()=>capture.response));
 for(const [name,choice] of [['ada','low'],['lin',level]]){const c=await f.vault.read('agents/'+name+'.md'),agent=c.metadata.lorecrew as any;await f.vault.propose({id:'thinking-'+name,path:c.path,expectedRevision:c.revision,actor:'fixture',content:{metadata:{lorecrew:{...agent,model:{...agent.model,thinkingLevel:choice}}}}});}
 const root=await f.runtime.team.createTask({requestId:'root',projectId:'project',leadAgentId:'agent-ada',objective:'Native thinking root'});await expect.poll(()=>capture.requests.length).toBe(1);expect(capture.requests[0]!.reasoning).toBe('low');
 const input={requestId:'helper',parentTaskId:root.id,agentId:'agent-lin',objective:'Native thinking helper',deliverable:'Review',contextPaths:[],dependsOn:[]};
 if(level==='alien'){await expect(f.runtime.team.delegate(input)).rejects.toMatchObject({code:'UNSUPPORTED_THINKING_LEVEL'});expect(capture.requests).toHaveLength(1);expect((await f.ctx.store.list<any>('runtime-session')).filter(s=>s.agent.id==='agent-lin')).toEqual([]);}else{const helper=await f.runtime.team.delegate(input);await expect.poll(()=>capture.requests.length).toBe(2);expect(capture.requests[1]!.reasoning).toBe('high');expect((await f.runtime.snapshot(helper.executingSessionId)).session).toMatchObject({thinkingPreference:{kind:'explicit',level:'high'}});}
},20000);
