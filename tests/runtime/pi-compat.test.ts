import { expect, it } from 'vitest';
import { join } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';
import { openPiDatabase } from '../../src/runtime/pi-host.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
it('verifies FULL on the live Pi SQLite connection after initialization',async()=>{
  const f=await temporaryInstance();const host=await openPiDatabase(join(f.root,'pi.sqlite'));
  try {expect((await host.database.get<{synchronous:number}>('PRAGMA synchronous'))?.synchronous).toBe(2);
    expect((await host.database.get<{journal_mode:string}>('PRAGMA journal_mode'))?.journal_mode).toBe('wal');
  }finally{await host.storage.close(BACKGROUND_CONTEXT);await f.cleanup();}
});
it('gates Pi compaction requests before provider dispatch and permits cancellation while parked',async()=>{
  const {gateModelContinuations}=await import('../../src/runtime/providers.js');
  const {scriptedProvider,fauxAssistantMessage}=await import('../helpers/scripted-provider.js');
  const provider=scriptedProvider();provider.faux.setResponses([fauxAssistantMessage('summary')]);
  const abort=new AbortController();let entered!:()=>void;const waiting=new Promise<void>(r=>entered=r);
  const models=gateModelContinuations(provider.models,async identity=>{
    entered();expect(identity.sessionId).toBe('provider-session');
    await new Promise<void>((_r,reject)=>identity.signal?.addEventListener('abort',()=>reject(new Error('parked cancelled')),{once:true}));
  });
  const request=models.completeSimple(provider.faux.getModel(),{messages:[]},{sessionId:'provider-session',signal:abort.signal});
  // A microtask boundary is sufficient: the unchanged provider dispatches synchronously.
  await new Promise<void>(r=>setTimeout(r,10));
  expect(provider.faux.state.callCount).toBe(0);
  await waiting;abort.abort();await expect(request).rejects.toThrow('parked cancelled');
});
