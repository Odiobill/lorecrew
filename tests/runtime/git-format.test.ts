import {expect,it} from 'vitest';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {repositoryFixture} from '../helpers/repository.js';
import {assertCurrentExecutionState} from '../../src/runtime/compatibility.js';
import {readStoppedExecutionProof} from '../../src/runtime/stopped-proof.js';
it('format1 and incomplete conversion fence activation without starting Pi',async()=>{const f=await repositoryFixture();try{await f.state.close();const db=new DatabaseSync(join(f.state.stateDir,'control.sqlite'));db.exec('PRAGMA user_version=1');db.close();await f.reopen();await expect(assertCurrentExecutionState(f.state)).rejects.toMatchObject({code:'MIGRATION_REQUIRED'});expect(await f.state.store.list('runtime-session')).toEqual([]);}finally{await f.close();}});
it('cold proof rejects active plain work and unresolved effects without creating a Pi database',async()=>{const f=await repositoryFixture();try{expect(await readStoppedExecutionProof(f.state)).toEqual({quiescent:true});await f.state.store.transact(tx=>tx.put('runtime-effect','pending',{state:'started'}));expect(await readStoppedExecutionProof(f.state)).toMatchObject({quiescent:false});}finally{await f.close();}});
it('cold migration proof refuses a pending task envelope even before Pi/session allocation',async()=>{const f=await repositoryFixture();try{await f.state.store.transact(tx=>{tx.put('team-task','pending',{id:'pending',projectId:'p',state:'pending'});tx.put('team-task-outbox','pending',{taskId:'pending'});});expect(await readStoppedExecutionProof(f.state)).toMatchObject({quiescent:false});}finally{await f.close();}});
