import {occurrencesAfter} from '../../src/schedules/recurrence.js';
import type {Schedule} from '../../src/schedules/types.js';
export type RoutinePreset={kind:'daily'|'weekdays'|'weekly';hour:number;minute:number;weekday?:number};
export function routinePresetToCron(input:RoutinePreset):string {
 if(!Number.isInteger(input.hour)||input.hour<0||input.hour>23||!Number.isInteger(input.minute)||input.minute<0||input.minute>59||!['daily','weekdays','weekly'].includes(input.kind)||input.kind==='weekly'&&(!Number.isInteger(input.weekday)||input.weekday!<0||input.weekday!>6))throw new Error('Choose a valid local time and weekday.');
 return `${input.minute} ${input.hour} * * ${input.kind==='weekdays'?'1-5':input.kind==='weekly'?input.weekday:'*'}`;
}
export function cronToRoutinePreset(cron:string):RoutinePreset|null {
 const match=/^(\d|[1-5]\d) (\d|1\d|2[0-3]) \* \* (\*|1-5|[0-6])$/.exec(cron);if(!match)return null;
 const day=match[3]!;return {kind:day==='*'?'daily':day==='1-5'?'weekdays':'weekly',hour:Number(match[2]),minute:Number(match[1]),...(day!=='*'&&day!=='1-5'?{weekday:Number(day)}:{})};
}
export function previewRoutine(input:Pick<Schedule,'cron'|'timeZone'>,after=new Date().toISOString(),count=3):string[]{
 const iterator=occurrencesAfter({...input,id:'preview',revision:'preview',ownerId:'preview',agentId:'preview',instructions:'preview',enabled:true,overlap:'skip',missed:'coalesce',effectiveFrom:after},after);
 return Array.from({length:count},()=>iterator.next().value?.utc).filter((value):value is string=>!!value);
}
