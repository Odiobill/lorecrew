import { expect, it } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repositoryFixture } from '../helpers/repository.js';
import { openState } from '../../src/instance/state.js';
import { withRepositoryOperation } from '../../src/repositories/coordination.js';

it('two worktrees and independent instances share one common-dir operation gate', async()=>{
 const f=await repositoryFixture();try {
  const linked=join(f.root,'linked');await f.gitAt(['worktree','add','-b','helper',linked]);
  let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const hold=new Promise<void>(r=>release=r);let secondWriterEntered=false;
  const first=withRepositoryOperation(f.state,{kind:'project',id:'p',path:f.path},{requestId:'one',kind:'checkpoint',inputHash:'one'},async()=>{entered();await hold;return 'one';});await ready;
  const otherState=await openState({stateDir:join(f.root,'other-state')});
  const second=withRepositoryOperation(otherState,{kind:'project',id:'p',path:linked},{requestId:'two',kind:'checkpoint',inputHash:'two'},async()=>{secondWriterEntered=true;return 'two';});
  expect(await f.repositories.inspect(linked)).toMatchObject({kind:'git'});expect(secondWriterEntered).toBe(false);
  release();expect(await first).toBe('one');expect(await second).toBe('two');await otherState.close();
 }finally{await f.close();}
});
it('changed input conflicts and completed input replays without callback',async()=>{const f=await repositoryFixture();try{
 const repo={kind:'project' as const,id:'p',path:f.path};const input={requestId:'same',kind:'checkpoint' as const,inputHash:'a'};
 expect(await withRepositoryOperation(f.state,repo,input,async()=>42)).toBe(42);
 expect(await withRepositoryOperation(f.state,repo,input,async()=>{throw new Error('replayed');})).toBe(42);
 await expect(withRepositoryOperation(f.state,repo,{...input,inputHash:'b'},async()=>0)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
 }finally{await f.close();}});
it('external index/branch change defers mutation',async()=>{const f=await repositoryFixture();try{
 const snapshot=(await f.repositories.inspect(f.path)).snapshot!;await writeFile(join(f.path,'external'),'user');await f.gitAt(['add','external']);let entered=false;
 await expect(withRepositoryOperation(f.state,{kind:'project',id:'p',path:f.path},{requestId:'race',kind:'checkpoint',inputHash:'a',expected:snapshot},async()=>{entered=true;})).rejects.toMatchObject({code:'REPOSITORY_CHANGED'});expect(entered).toBe(false);expect(await f.gitAt(['diff','--cached','--name-only'])).toBe('external');
 }finally{await f.close();}});
it('unknown owner keeps evidence while unrelated repo remains responsive',async()=>{const f=await repositoryFixture();try{
 const snapshot=(await f.repositories.inspect(f.path)).snapshot!;await mkdir(join(snapshot.commonDir,'lorecrew-operation.lock'));await writeFile(join(snapshot.commonDir,'lorecrew-operation.lock','owner.json'),'{}');
 await expect(withRepositoryOperation(f.state,{kind:'project',id:'p',path:f.path},{requestId:'unknown',kind:'checkpoint',inputHash:'a'},async()=>0)).rejects.toMatchObject({code:'REPOSITORY_BUSY'});
 expect(await f.state.store.read('repository-operation','unknown')).toMatchObject({state:'uncertain'});
 expect(await readFile(join(snapshot.commonDir,'lorecrew-operation.lock','owner.json'),'utf8')).toBe('{}');
 const other=join(f.root,'other');await mkdir(other);expect(await f.repositories.inspect(other)).toMatchObject({kind:'empty'});
 }finally{await f.close();}});
it('rejects nested, symlink, bare and malformed roots without mutation',async()=>{const f=await repositoryFixture();try{
 await mkdir(join(f.path,'nested'));expect(await f.repositories.inspect(join(f.path,'nested'))).toMatchObject({kind:'invalid_git'});
 await symlink(f.path,join(f.root,'alias'));expect(await f.repositories.inspect(join(f.root,'alias'))).toMatchObject({kind:'invalid_git'});
 const broken=join(f.root,'broken');await mkdir(broken);await writeFile(join(broken,'.git'),'gitdir: missing');expect(await f.repositories.inspect(broken)).toMatchObject({kind:'invalid_git'});
 const bare=join(f.root,'bare');await f.git.run(f.root,['init','--bare',bare]);expect(await f.repositories.inspect(bare)).toMatchObject({kind:'invalid_git'});
 }finally{await f.close();}});
it('concurrent identical requests perform one mutation',async()=>{const f=await repositoryFixture();try{let mutations=0;const run=()=>withRepositoryOperation(f.state,{kind:'project',id:'p',path:f.path},{requestId:'duplicate',kind:'checkpoint',inputHash:'same'},async()=>++mutations);expect(await Promise.all([run(),run()])).toEqual([1,1]);expect(mutations).toBe(1);}finally{await f.close();}});
it('uncertain callback retains the common gate against a different request',async()=>{const f=await repositoryFixture();try{const repo={kind:'project' as const,id:'p',path:f.path};await expect(withRepositoryOperation(f.state,repo,{requestId:'lost',kind:'checkpoint',inputHash:'a'},async()=>{throw new Error('child outcome unknown');})).rejects.toThrow('child outcome unknown');expect(await f.state.store.read('repository-operation','lost')).toMatchObject({state:'uncertain'});await expect(withRepositoryOperation(f.state,repo,{requestId:'next',kind:'checkpoint',inputHash:'b'},async()=>1)).rejects.toMatchObject({code:'REPOSITORY_BUSY'});}finally{await f.close();}});
