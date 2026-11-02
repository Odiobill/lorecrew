import type { SseMessage } from '../src/api/schemas.js';
import type { AppEvent } from './api.js';
interface Options {cursor:number;onEvent:(event:AppEvent)=>void;onReset:()=>Promise<number>;onConnection?:(connected:boolean)=>void}
/** Fetch streams support every named event kind, cookies, and an explicit reconnect cursor. */
export function subscribeEvents({cursor,onEvent,onReset,onConnection}:Options):()=>void {
  const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const delay=()=>new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);abort.signal.addEventListener('abort',()=>{clearTimeout(timer);resolve();},{once:true});});
  void (async()=>{
    while(!abort.signal.aborted){
      let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
      try {
        const response=await fetch(`/api/v1/events?after=${cursor}`,{credentials:'same-origin',cache:'no-store',signal:abort.signal});
        if(!response.ok||!response.body)throw new Error('Event connection unavailable');
        onConnection?.(true);reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';let reset=false;
        while(!abort.signal.aborted&&!reset){
          const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});
          let boundary:number;
          while((boundary=buffer.indexOf('\n\n'))>=0){
            const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
            const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!data)continue;
            const event=frame.split('\n').find(line=>line.startsWith('event:'))?.slice(6).trim()??'message';
            if(event==='reset'){
              const message={event,data:JSON.parse(data)} as Extract<SseMessage,{event:'reset'}>;void message;
              cursor=await onReset();reset=true;break;
            }
            const item=JSON.parse(data) as AppEvent;if(item.seq<=cursor)continue;cursor=item.seq;onEvent(item);
          }
        }
        if(!reset&&!abort.signal.aborted){onConnection?.(false);await delay();}
      }catch {if(!abort.signal.aborted){onConnection?.(false);await delay();}}
      finally{await reader?.cancel().catch(()=>{});}
    }
  })();
  return ()=>{abort.abort();clearTimeout(timer);};
}
