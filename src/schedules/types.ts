export interface Schedule {
 id:string;revision:string;ownerId:string;agentId:string;projectId?:string;cron:string;timeZone:string;instructions:string;
 enabled:boolean;overlap:'skip';missed:'coalesce';effectiveFrom:string;
}
export interface Occurrence {
 authority?:import('../projects/authority-domain.js').AuthorityScope;
 id:string;scheduleId:string;revision:string;utc:string;localKey:string;generation:number;
 skipped?:{fromUtc:string;toUtc:string;count:number};state:'pending'|'running'|'completed'|'failed'|'cancelled';
 requestId:string;schedule:Schedule;sessionId?:string;taskId?:string;
}
export interface ScheduleService {
 save(schedule:Schedule,expectedRevision?:string|null):Promise<void>;list():Promise<Schedule[]>;tick(nowUtc:string):Promise<void>;
 disable(id:string,expectedRevision?:string):Promise<void>;transfer(id:string,targetOwner:string):Promise<void>;close():Promise<void>;
}
