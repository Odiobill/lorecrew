import type { Json } from '../contracts/base.js';
import type { HistoryEntry, SessionSnapshot } from './types.js';
function record(value:Json|undefined):Record<string,Json>{return value && typeof value==='object' && !Array.isArray(value)?value:{};}
function publicContent(value:Json|undefined):Json[] {
  if(typeof value==='string')return [{type:'text',text:value}];
  if(!Array.isArray(value))return [];
  return value.flatMap<Json>(item=>{const part=record(item);if(part.type==='text' && typeof part.text==='string')return [{type:'text',text:part.text}];
    if(part.type==='toolCall' && typeof part.id==='string' && typeof part.name==='string')return [{type:'toolCall',id:part.id,name:part.name,arguments:part.arguments??null}];return [];
  });
}
/** Whitelist transcript content; provider headers, signatures, handles and raw envelopes stay local. */
export function publicEntry(entry:HistoryEntry):HistoryEntry {
    const raw=record(entry.data);const model=Array.isArray(raw.model)?record(raw.model[0]):raw;
    const data:Record<string,Json>={content:publicContent(model.content)};
    for(const key of ['toolCallId','toolName','isError'])if(model[key]!==undefined)data[key]=model[key]!;
    return {...entry,data};
}
export function publicSnapshot(snapshot:SessionSnapshot):SessionSnapshot {
  const messages=snapshot.messages.map(publicEntry);
  const usage=record(snapshot.usage);const publicUsage:Record<string,Json>={};
  for(const bucket of ['models','tools'])publicUsage[bucket]=Object.fromEntries(Object.entries(record(usage[bucket])).map(([name,raw])=>{
    const input=record(raw);const counters:Record<string,Json>={};
    for(const key of ['input','output','cacheRead','cacheWrite','totalTokens'])if(typeof input[key]==='number')counters[key]=input[key]!;
    const cost=record(input.cost);counters.cost=Object.fromEntries(['input','output','cacheRead','cacheWrite','total'].filter(key=>typeof cost[key]==='number').map(key=>[key,cost[key]!]));
    return [name,counters];
  }));
  return {...snapshot,messages,tools:messages.filter(m=>m.kind==='tool').map(m=>m.data),usage:publicUsage};
}

/** Reconcile durable pre-exporter records as well as newly timestamped history.
 * Recovery timestamps describe discovery; they never claim an unknown original time.
 */
export async function controlHistory(ctx:import('../instance/open.js').InstanceContext,sessionId:string,afterSequence=0):Promise<{entries:HistoryEntry[];sequence:number}> {
 if(!await ctx.store.read('runtime-control-backfilled',sessionId)){
  const [saved,tasks,decisions,messages,reports,envelopes]=await Promise.all([
    ctx.store.scan<{sessionId:string;entry:HistoryEntry}>('team-history',{field:'sessionId',value:sessionId}),
    ctx.store.scan<import('../team/types.js').TaskRecord>('team-task',{field:'executingSessionId',value:sessionId}),
    Promise.resolve([] as import('../team/types.js').Decision[]),
    Promise.all(['fromSessionId','toSessionId'].map(field=>ctx.store.scan<import('../team/types.js').MessageInput>('team-message',{field,value:sessionId}))).then(items=>items.flat()),
    Promise.resolve([] as import('../team/types.js').ReportInput[]),
    ctx.store.scan<{id:string;sessionId:string;text:string}>('team-envelope',{field:'sessionId',value:sessionId}),
  ]);
  const direct=[...tasks];for(const task of direct){decisions.push(...await ctx.store.scan<import('../team/types.js').Decision>('team-decision',{field:'taskId',value:task.id}));tasks.push(...await ctx.store.scan<import('../team/types.js').TaskRecord>('team-task',{field:'parentTaskId',value:task.id}));}
  const returned=await ctx.store.scan<import('../team/types.js').TaskRecord>('team-task',{field:'returnSessionId',value:sessionId});for(const task of [...tasks,...returned])reports.push(...await ctx.store.scan<import('../team/types.js').ReportInput>('team-report',{field:'taskId',value:task.id}));
  const history=saved.filter(r=>r.sessionId===sessionId).map(r=>r.entry);const ids=new Set(history.map(e=>e.id));
  const append=(id:string,kind:HistoryEntry['kind'],data:Json)=>{if(!ids.has(`team:${id}`)){history.push({id:`team:${id}`,kind,at:new Date(ctx.clock.now()).toISOString(),data:{record:data,timestampProvenance:'recovered; original record time unavailable'}});ids.add(`team:${id}`);}};
  for(const task of tasks)if(task.executingSessionId===sessionId||tasks.find(p=>p.id===task.parentTaskId)?.executingSessionId===sessionId)append(`assignment:${task.id}`,'delegation',JSON.parse(JSON.stringify(task)) as Json);
  for(const decision of decisions)if(tasks.find(t=>t.id===decision.taskId)?.executingSessionId===sessionId){
    const {answer,answerRequestId:_,...question}=decision;append(`decision:${decision.id}`,'decision',{...question,state:'pending'});
    if(answer!==undefined)append(`answer:${decision.id}`,'decision',{id:decision.id,taskId:decision.taskId,state:'answered',answer});
  }
  for(const message of messages)if(message.fromSessionId===sessionId||message.toSessionId===sessionId)append(`message:${message.id}`,'user',{content:[{type:'text',text:message.text}],fromSessionId:message.fromSessionId,toSessionId:message.toSessionId});
  for(const report of reports){const task=[...tasks,...returned].find(t=>t.id===report.taskId);if(task?.executingSessionId===sessionId||task?.returnSessionId===sessionId)append(`report:${report.taskId}:${report.requestId}`,'delegation',JSON.parse(JSON.stringify(report)) as Json);}
  for(const envelope of envelopes)if(envelope.sessionId===sessionId&&envelope.id.startsWith('steer:')){
    const data=JSON.parse(envelope.text) as {taskId:string;requestId:string;text:string};append(`steer:${data.taskId}:${data.requestId}`,'user',{content:[{type:'text',text:data.text}]});
  }
  await ctx.store.transact(tx=>{for(const entry of history){const key=`${sessionId}:${entry.id}`;if(!tx.get('team-history-stream-id:'+sessionId,entry.id))tx.put('team-history',key,{sessionId,entry});}tx.put('runtime-control-backfilled',sessionId,{version:1});});
 }
 const rows=await ctx.store.scan<{sequence:number;entry:HistoryEntry}>('team-history-stream:'+sessionId,{after:String(afterSequence).padStart(16,'0')});
 return {entries:rows.map(row=>row.entry),sequence:rows.at(-1)?.sequence??afterSequence};
}
