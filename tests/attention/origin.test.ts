import { expect,it } from 'vitest';
import { classifyOrigin } from '../../src/attention/origin.js';
import { stableId } from '../../src/runtime/admission.js';
import type { TaskRecord } from '../../src/team/types.js';
import type { Occurrence } from '../../src/schedules/types.js';
const occurrence=(project=false)=>({id:'occ',scheduleId:'routine',requestId:'occ-request',schedule:{id:'routine',...project?{projectId:'p'}:{}}}) as Occurrence;
it('scheduled project origin survives the missing dispatch receipt and child parent traversal',()=>{const id=stableId('local','team-task','occ-request');const root={id,executingSessionId:stableId('local',id)} as TaskRecord,child={id:'helper',executingSessionId:'helper-session',parentTaskId:id} as TaskRecord;expect(classifyOrigin('local',[root,child],[occurrence(true)],{sessionId:child.executingSessionId})).toEqual({kind:'schedule',occurrenceId:'occ',scheduleId:'routine'});expect(classifyOrigin('local',[root],[],{sessionId:root.executingSessionId})).toEqual({kind:'user_task',rootTaskId:id});});
it('ordinary scheduled session is predicted from the actual occurrence request',()=>{expect(classifyOrigin('local',[],[occurrence()],{sessionId:stableId('local','occ-request')})).toEqual({kind:'schedule',occurrenceId:'occ',scheduleId:'routine'});expect(classifyOrigin('local',[],[occurrence()],{sessionId:'scheduled-by-name'})).toEqual({kind:'conversation',sessionId:'scheduled-by-name'});});
