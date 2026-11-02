import {skillPreview} from './skill-preview.js';
export async function dailyPreview(){
 const crew=await skillPreview();
 async function until(check:()=>Promise<boolean>){const end=Date.now()+15_000;while(!await check()){if(Date.now()>end)throw new Error('Scripted preview did not reach its expected state.');await new Promise(r=>setTimeout(r,20));}}
const doc=(metadata:object,body:string)=>`---\n${JSON.stringify(metadata)}\n---\n${body}\n`;
 try{
  const finished=await crew.runtime.team.createTask({requestId:'preview-result',projectId:'project',leadAgentId:'agent-ada',objective:'Review daily notes'});
  await until(async()=>(await crew.runtime.snapshot(finished.executingSessionId)).status==='completed');
  await crew.runtime.team.report({taskId:finished.id,requestId:'preview-result-report',state:'completed',outcome:{summary:'Daily notes reviewed by the scripted fixture. Inspect the captured evidence before relying on the result.'}});
  const failed=await crew.runtime.team.createTask({requestId:'preview-failure',projectId:'project',leadAgentId:'agent-ada',objective:'Inspect failed daily check'});
  await until(async()=>(await crew.runtime.snapshot(failed.executingSessionId)).status==='completed');
  await crew.runtime.team.report({taskId:failed.id,requestId:'preview-failure-report',state:'failed',outcome:{summary:'Scripted example: the daily check failed. No real provider or external check ran.'}});
  await crew.runtime.team.createTask({requestId:'preview-decision',projectId:'project',leadAgentId:'agent-ada',objective:'Improve team greeting'});
  await until(async()=>(await crew.ctx.store.list('team-decision')).length>0);
  await crew.vault.propose({id:'preview-evidence',path:'learning/daily-evidence.md',expectedRevision:null,actor:'fixture',content:doc({type:'LearningProvenance',title:'Captured daily review'},'Scripted source evidence: this preview demonstrates provenance, not real-model validation or reuse.')});
  await crew.vault.propose({id:'preview-lesson',path:'lessons/daily-review.md',expectedRevision:null,actor:'fixture',content:doc({type:'Lesson',title:'Check the captured context',evidenceState:'contested',sourcePaths:['learning/daily-evidence.md']},'A contested example lesson. Inspect its recorded source and applicability.')});
  await crew.vault.propose({id:'preview-proposal',path:'learning/daily-proposal.md',expectedRevision:null,actor:'fixture',content:doc({type:'LearningProposal',title:'Daily learning proposal',sourcePaths:['learning/daily-evidence.md']},'An unresolved fixture proposal, with no invented improvement metric.')});
  await crew.vault.propose({id:'preview-remote',path:'status/remote/daily.md',expectedRevision:null,actor:'fixture',content:doc({type:'TaskStatus',lorecrew:{originId:'Example remote laptop',taskId:'remote-example',sessionId:'remote-session',sequence:3,reportedAt:'2026-10-28T17:00:00Z',state:'running',summary:'Last shared remote report'}},'A historical report; no reachability or control channel is implied.')});
  // A disabled definition is editable without accidentally starting model work.
  const schedule={id:'daily-review',revision:'preview-routine',ownerId:crew.ctx.instanceId,agentId:'agent-ada',cron:'30 2 * * *',timeZone:'Europe/Rome',instructions:'Review shared knowledge and cite the source evidence.',enabled:false,overlap:'skip' as const,missed:'coalesce' as const,effectiveFrom:new Date().toISOString()};
  await crew.schedules.save(schedule,null);
  return crew;
 }catch(error){await crew.close();throw error;}
}
