import type { InstanceContext } from '../instance/open.js';
import { AppError } from '../contracts/base.js';
import type { Runtime, SessionRecord, SessionSnapshot } from '../runtime/types.js';
import type { SseMessage } from './schemas.js';
import { createHash } from 'node:crypto';
const encodeSse=(message:SseMessage)=>`${'id' in message?`id: ${message.id}\n`:''}event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
/** Bounded reads share the ordered control connection with event-producing state changes. */
export function eventStream(ctx:InstanceContext,cursor:string|undefined,authorized:()=>Promise<boolean>,signal:AbortSignal):Response {
  if(cursor!==undefined && !/^(0|[1-9][0-9]*)$/.test(cursor))throw new AppError('INVALID_CURSOR','Event cursor must be a nonnegative integer');
  let after=Number(cursor??0);if(!Number.isSafeInteger(after))throw new AppError('INVALID_CURSOR','Event cursor is too large');
  let stopped=false;let timer:ReturnType<typeof setTimeout>|undefined;let wake:(()=>void)|undefined;
  const stop=()=>{stopped=true;if(timer)clearTimeout(timer);wake?.();};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const encoder=new TextEncoder();let heartbeat=0;
  const stream=new ReadableStream<Uint8Array>({
    async pull(controller){
      try{
        while(!stopped){
          if(!await authorized()){stop();controller.close();break;}
          const page=await ctx.store.eventPage(after,1);
          if(after>page.maxSeq || (page.minSeq>0 && after<page.minSeq-1)){
            controller.enqueue(encoder.encode(encodeSse({event:'reset',data:{instanceId:ctx.instanceId,seq:page.maxSeq,snapshot:'/api/v1/snapshot'}})));stop();controller.close();break;
          }
          const event=page.events[0];if(event){after=event.seq;controller.enqueue(encoder.encode(encodeSse({id:String(event.seq),event:event.kind,data:event})));return;}
          if(++heartbeat===75){controller.enqueue(encoder.encode(': heartbeat\n\n'));heartbeat=0;return;}
          await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,200);});wake=undefined;
        }
      }catch{if(!stopped){stop();controller.close();}}
      finally{if(stopped)signal.removeEventListener('abort',stop);}
    },cancel(){stop();signal.removeEventListener('abort',stop);},
  });
  return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-store','x-accel-buffering':'no'}});
}
interface ReconciledSession {snapshot:SessionSnapshot;settled:boolean;source?:{sessionId:string;generation:number}}
interface Projection extends ReconciledSession {hash:string}
/** Pi is authoritative. This durable public projection and invalidation share only a control-store transaction. */
export function startEventReconciliation(ctx:InstanceContext,snapshots:()=>Promise<Array<SessionSnapshot|ReconciledSession>>,onError:(error:unknown)=>void=()=>console.error('Lorecrew session event reconciliation failed')) {
  let closing=false;let running:Promise<void>|undefined;
  const reconcile=():Promise<void>=>{
    if(closing)return Promise.resolve();
    return running??=(async()=>{
      for(const item of await snapshots()){
        if(closing)break;
        const {snapshot,settled,source}:ReconciledSession='snapshot' in item?item:{snapshot:item,settled:false};
        const hash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
        await ctx.store.transact(tx=>{
          if(source)tx.put('api-source',snapshot.session.id,source);
          const previous=tx.get<Projection>('api-session-snapshot',snapshot.session.id);
          if(previous?.hash===hash&&previous.settled===settled)return;
          tx.put<Projection>('api-session-snapshot',snapshot.session.id,{hash,snapshot,settled});
          if(previous?.hash===hash)return;
          tx.emit('session.updated',{sessionId:snapshot.session.id,status:snapshot.status,revision:hash});
        });
      }
    })().finally(()=>{running=undefined;});
  };
  const timer=setInterval(()=>{void reconcile().catch(onError);},1000);timer.unref();
  return {reconcile,async close(){closing=true;clearInterval(timer);await running;}};
}

/** Shared by the app and lifecycle tests; selects the next bounded snapshot batch. */
export function createSessionSnapshotSource(ctx:InstanceContext,runtime:Runtime,project:(snapshot:SessionSnapshot)=>SessionSnapshot) {
  let offset=0;
  return async()=>{
    const sources=await ctx.store.list<{sessionId:string;generation:number}>('session-source');
    const observed=new Map((await ctx.store.list<{sessionId:string;generation:number}>('api-source')).map(item=>[item.sessionId,item.generation]));
    const saved=new Set(await ctx.store.keys('api-session-snapshot'));const changed=sources.filter(item=>observed.get(item.sessionId)!==item.generation||!saved.has(item.sessionId));
    if(offset>=changed.length)offset=0;const batch=changed.slice(offset,offset+64);offset+=batch.length;
    return Promise.all(batch.map(async item=>{
      const record=await ctx.store.read<SessionRecord>('runtime-session',item.sessionId);if(!record)throw new AppError('SESSION_NOT_FOUND','Observation source has no session');
      const snapshot=project(await runtime.snapshot(item.sessionId));
      return {snapshot,source:item,settled:!!(record.cancelled?record.cancellationSettled:record.finished)};
    }));
  };
}
