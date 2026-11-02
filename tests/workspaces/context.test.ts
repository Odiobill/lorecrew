import { afterEach, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';
import { openInstance } from '../../src/instance/open.js';
const cleanup:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const f of cleanup.splice(0).reverse())await f();});
export async function fixture(){const f=await temporaryInstance();cleanup.push(f.cleanup);const ctx=await openInstance(f.paths);cleanup.push(()=>ctx.close());const home=join(f.root,'home');await mkdir(home);const mod=await import('../../src/workspaces/context.js').catch(()=>({ensureExecutionContext:undefined,currentExecutionContext:undefined,assertExecutionContext:undefined}));expect(mod.ensureExecutionContext,'durable execution epochs').toBeTypeOf('function');return {...f,ctx,home,mod};}
it('records cwd durably and never revives a stopped epoch',async()=>{
 const f=await fixture();const a=await f.mod.ensureExecutionContext!(f.ctx,{sessionId:'ordinary',cwd:f.home,owner:{kind:'session'}});
 expect(await f.mod.currentExecutionContext!(f.ctx,'ordinary')).toEqual(a);expect(a.epoch).toBe(1);
 await expect(f.mod.ensureExecutionContext!(f.ctx,{sessionId:'ordinary',cwd:f.paths.vaultDir,owner:{kind:'session'}})).rejects.toMatchObject({code:'CONTEXT_CONFLICT'});
 await f.ctx.store.transact(tx=>tx.put('execution-context',a.id,{...a,state:'stopped'}));
 await expect(f.mod.ensureExecutionContext!(f.ctx,{sessionId:'ordinary',cwd:f.home,owner:{kind:'session'}})).rejects.toMatchObject({code:'CONTEXT_STOPPED'});
 const b=await f.mod.ensureExecutionContext!(f.ctx,{sessionId:'ordinary',cwd:f.home,owner:{kind:'session'},afterStoppedContextId:a.id});expect(b.epoch).toBe(2);expect(b.id).not.toBe(a.id);
 await expect(f.mod.assertExecutionContext!(f.ctx,a.id)).rejects.toMatchObject({code:'CONTEXT_STOPPED'});
});
it('refuses missing or relative cwd instead of using the vault',async()=>{const f=await fixture();for(const cwd of ['relative',join(f.home,'missing')])await expect(f.mod.ensureExecutionContext!(f.ctx,{sessionId:cwd,cwd,owner:{kind:'session'}})).rejects.toMatchObject({code:'EXECUTION_CWD_UNAVAILABLE'});});
