import { CronExpressionParser } from 'cron-parser';
import { AppError } from '../contracts/base.js';
import type { Schedule } from './types.js';
const formatters=new Map<string,Intl.DateTimeFormat>();
function formatter(zone:string){
 let value=formatters.get(zone);
 if(!value){value=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatters.set(zone,value);}
 return value;
}
function wall(format:Intl.DateTimeFormat,time:number){
 const p=Object.fromEntries(format.formatToParts(time).map(p=>[p.type,p.value]));
 return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
export function validateRecurrence(schedule:Pick<Schedule,'cron'|'timeZone'>){
 try{
  if(typeof schedule.timeZone!=='string'||!schedule.timeZone.trim()||/^[+-]/.test(schedule.timeZone))throw new Error('Use an IANA time zone');
  if(typeof schedule.cron!=='string'||schedule.cron.trim().split(/\s+/).length!==5||!/^[\d*\/,\-\s]+$/.test(schedule.cron))throw new Error('Use five numeric cron fields');
  formatter(schedule.timeZone);return CronExpressionParser.parse(schedule.cron,{tz:schedule.timeZone});
 }catch(error){throw new AppError('INVALID_SCHEDULE',error instanceof Error?error.message:'Invalid time zone or cron expression');}
}
/** Library DST gap normalization is rejected; fold candidates use the first physical instant. */
export function* occurrencesAfter(schedule:Schedule,afterUtc:string):Generator<{utc:string;localKey:string}>{
 validateRecurrence(schedule);
 if(!Number.isFinite(Date.parse(afterUtc)))throw new AppError('INVALID_TIME','Invalid UTC instant');
 const expression=CronExpressionParser.parse(schedule.cron,{currentDate:afterUtc,tz:schedule.timeZone});const format=formatter(schedule.timeZone);
 while(expression.hasNext()){
  const next=expression.next();const time=next.toDate().getTime();const local=wall(format,time);
  if(!expression.fields.hour.values.some(value=>value===Number(local.slice(11,13)))||!expression.fields.minute.values.some(value=>value===Number(local.slice(14,16))))continue;
  const offset=Date.parse(`${local}:00Z`)-time;const earlier=time-48*3600_000;
  const previousOffset=Date.parse(`${wall(format,earlier)}:00Z`)-earlier;
  if(previousOffset>offset&&wall(format,time-(previousOffset-offset))===local)continue;
  yield {utc:new Date(time).toISOString().replace('.000Z','Z'),localKey:`${schedule.timeZone}:${local}`};
 }
}
export function nextOccurrence(schedule:Schedule,afterUtc:string):{utc:string;localKey:string}|null{return occurrencesAfter(schedule,afterUtc).next().value??null;}
