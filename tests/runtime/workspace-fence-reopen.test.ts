import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitTaskFixture} from '../helpers/git-task-fixture.js';
import {openRuntime} from '../../src/runtime/pi-host.js';
import {openVault} from '../../src/vault/write.js';
import type {SessionRecord} from '../../src/runtime/types.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
it('reopens a positively stopped project workspace as blocked without admitting a successor or model work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lorecrew-workspace-fence-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const f=await gitTaskFixture(root);cleanup.push(f.close);
 const session=await f.runtime.createSession({requestId:'stopped-workspace-tail',agentId:'piren',projectId:'code'});
 const record=(await f.ctx.store.read<SessionRecord>('runtime-session',session.id))!;
 expect(record.workspaceId).toBeTruthy();expect(record.executionContextId).toBeTruthy();
 expect(await f.supervisor.stopWorkspace(record.workspaceId!)).toMatchObject({quiescent:true});
 await f.runtime.close();
 const fence=await f.ctx.store.read('workspace-process-fence',record.workspaceId!),contexts=await f.ctx.store.list('execution-context'),calls=f.faux.state.callCount;
 const restored=await openRuntime({ctx:f.ctx,vault:openVault(f.ctx),ownership:f.ownership,workspaces:f.workspaces,supervisor:f.supervisor,models:f.models});cleanup.push(restored.close);
 expect(await restored.snapshot(session.id)).toMatchObject({status:'blocked',blockedReason:'context_stopped'});
 expect(await f.ctx.store.read<SessionRecord>('runtime-session',session.id)).toMatchObject({workspaceBlockedReason:'workspace_stopped'});
 expect(await f.ctx.store.read('workspace-process-fence',record.workspaceId!)).toEqual(fence);
 expect(await f.ctx.store.list('execution-context')).toEqual(contexts);expect(f.faux.state.callCount).toBe(calls);
});
