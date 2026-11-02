import { expect, it } from 'vitest';
import { assertSingleAdmission, runLearningTransfer, type AdmissionObservation } from '../fixtures/learning-transfer/scenario.js';
it('retrieves an exact cross-device lesson, adapts a distinct project and records receipt-backed reuse', async () => {
  const artifactDir=process.env.LORECREW_ACCEPTANCE_ARTIFACT_DIR;
  const report = await runLearningTransfer(artifactDir?{retain:true,artifactDir}:{});
  expect(report.projectABefore).toBe('fail');
  expect(report.projectBBefore).toBe('fail');
  expect(report.projectATests).toBe('pass');
  expect(report.projectBLoadedLessons).toContain(report.lessonRevision);
  expect(report.projectBTests).toBe('pass');
  expect(report.reuseEvidence.subjectHash).toBe(report.lessonSubjectHash);
  expect(report.reuseEvidence.outcome).toBe('pass');
  expect(report.duplicateAdmissions).toBe(0);
  expect(report.admissionEvidence.replay).toEqual(report.admissionEvidence.first);
  expect(report.admissionEvidence.taskIds).toHaveLength(1);
  expect(report.admissionEvidence.sessionIds).toHaveLength(1);
  expect(report.admissionEvidence.submissions).toHaveLength(1);
  expect(report.admissionEvidence.assignmentMessages).toHaveLength(1);
  expect(report.remoteMutationAvailable).toBe(false);
  expect(report.projectBPrompt).not.toContain('bindings');
  expect(report.projectBPrompt).not.toContain('source:');
}, 60_000);

const oneAdmission=():AdmissionObservation=>({first:{taskId:'task',sessionId:'session'},replay:{taskId:'task',sessionId:'session'},taskIds:['task'],sessionIds:['session'],submissions:[{id:'admission',sessionId:'session',requestId:'team:assignment:task',piId:7}],assignmentMessages:[{id:'message',sessionId:'session',taskId:'task'}]});
it.each(['changed replay identity','extra stored task/session','duplicate Pi user message','extra dispatch receipt'])('rejects %s instead of reporting zero duplicate admissions',kind=>{
  const observed=oneAdmission();
  if(kind==='changed replay identity')observed.replay={taskId:'other-task',sessionId:'other-session'};
  if(kind==='extra stored task/session'){observed.taskIds.push('other-task');observed.sessionIds.push('other-session');}
  if(kind==='duplicate Pi user message')observed.assignmentMessages.push({id:'second-message',sessionId:'session',taskId:'task'});
  if(kind==='extra dispatch receipt')observed.submissions.push({id:'second-admission',sessionId:'session',requestId:'team:assignment:task',piId:8});
  expect(()=>assertSingleAdmission(observed)).toThrow('Admission invariant');
});
