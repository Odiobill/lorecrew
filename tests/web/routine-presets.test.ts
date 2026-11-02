import {expect,it} from 'vitest';
import {routinePresetToCron,cronToRoutinePreset,previewRoutine} from '../../web/features/routine-presets.js';
import {nextOccurrence} from '../../src/schedules/recurrence.js';
import type {Schedule} from '../../src/schedules/types.js';
it('preset_round_trip_and_custom_cron_preservation',()=>{
 for(const [preset,cron] of [[{kind:'daily',hour:9,minute:5},'5 9 * * *'],[{kind:'weekdays',hour:17,minute:30},'30 17 * * 1-5'],[{kind:'weekly',hour:2,minute:0,weekday:0},'0 2 * * 0']] as const){expect(routinePresetToCron(preset)).toBe(cron);expect(cronToRoutinePreset(cron)).toEqual(preset);}
 for(const custom of ['*/15 8-18 * * 1,3','05 09 * * *',' 0 9 * * * ','0 9 1 * *','0 9 * * 7'])expect(cronToRoutinePreset(custom)).toBeNull();
 for(const invalid of [{kind:'daily',hour:24,minute:0},{kind:'daily',hour:9,minute:-1},{kind:'weekly',hour:9,minute:0,weekday:7}] as const)expect(()=>routinePresetToCron(invalid)).toThrow();
});
it('timezone_dst_preview_matches_existing_scheduler',()=>{
 const schedule:Schedule={id:'daily',revision:'r',ownerId:'o',agentId:'ada',cron:'30 2 * * *',timeZone:'Europe/Rome',instructions:'Review',enabled:true,overlap:'skip',missed:'coalesce',effectiveFrom:'2026-01-01T00:00:00Z'};
 for(const [after,want] of [['2026-03-28T02:00:00Z','2026-03-30T00:30:00Z'],['2026-10-24T01:00:00Z','2026-10-25T00:30:00Z'],['2026-10-25T00:30:00Z','2026-10-26T01:30:00Z'],['2026-10-25T01:00:00Z','2026-10-26T01:30:00Z']]){
  expect(previewRoutine(schedule,after!,1)[0]).toBe(want);expect(nextOccurrence(schedule,after!)?.utc).toBe(want);
 }
 expect(()=>previewRoutine({...schedule,timeZone:'Mars/Olympus'},'2026-01-01T00:00:00Z')).toThrow();
});
