import {expect,it} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {remoteFixture} from '../helpers/repository-remote.js';
import {openRepositories} from '../../src/repositories/service.js';
import {acceptedHeadKey} from '../../src/repositories/remote.js';
import {hash} from '../../src/repositories/inspect.js';

it.each(['rewind','foreign-owner','changed-target'] as const)('does not accept an interrupted unseen fetch across %s',async boundary=>{
 const f=await remoteFixture();try{
  const target=await f.target(),a=await f.gitAt(['rev-parse','HEAD']);await f.service.fetch(f.repo,target,'accepted-a');
  const other=join(f.root,'other');await f.run(f.root,['clone',f.remote,other]);await writeFile(join(other,'remote.md'),'unseen rewritten history\n');await f.run(other,['add','remote.md']);const tree=await f.run(other,['write-tree']),c=await f.run(other,['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit-tree',tree,'-m','Unrelated root']);await f.run(other,['push','--force',f.remote,c+':refs/heads/main']);expect((await f.git.run(other,['merge-base','--is-ancestor',a,c])).exitCode).toBe(1);
  let lose=true;const service=openRepositories({state:f.state,git:{async run(cwd,args,options){const result=await f.git.run(cwd,args,options);if(lose&&cwd===f.path&&args.includes('fetch')){lose=false;throw Error('lost successful fetch acknowledgement');}return result;}}});
  await expect(service.fetch(f.repo,target,'interrupted-fetch')).rejects.toThrow('lost successful fetch acknowledgement');expect(await f.state.store.read('accepted-remote-head',acceptedHeadKey(f.repo,target))).toEqual({commit:a});
  const saved=(await f.state.store.read<{ref:string;commit:string}>('repository-fetch','interrupted-fetch'))!;expect(saved.commit).toBe(c);expect(await f.gitAt(['rev-parse',saved.ref])).toBe(c);const lease=join(f.path,'.git/lorecrew-operation.lock');let foreign:string|undefined;
  if(boundary==='foreign-owner'){const original=JSON.parse(await readFile(lease,'utf8'));foreign=JSON.stringify({...original,token:'foreign-fetch-owner',instanceId:'other-instance'});await writeFile(lease,foreign);}
  if(boundary==='changed-target'){const replacement=join(f.root,'replacement.git');await f.run(f.root,['init','--bare','--template=','--initial-branch=main',replacement]);await f.gitAt(['remote','set-url','origin',replacement]);}
  await f.reopen();await expect(f.service.fetch(f.repo,target,'interrupted-fetch')).rejects.toMatchObject({code:boundary==='foreign-owner'?'REPOSITORY_BUSY':boundary==='changed-target'?'REMOTE_TARGET_CHANGED':'REMOTE_REWIND'});
  expect(await f.state.store.read('accepted-remote-head',acceptedHeadKey(f.repo,target))).toEqual({commit:a});expect(await f.gitAt(['rev-parse',saved.ref])).toBe(c);expect(await f.state.store.read('repository-fetch','interrupted-fetch')).not.toMatchObject({completed:true});
  if(foreign)expect(await readFile(lease,'utf8')).toBe(foreign);
  else{await writeFile(join(f.path,'local.md'),'durable local work');await expect(f.service.checkpoint({repo:f.repo,expected:(await f.service.inspect(f.path)).snapshot!,files:[{path:'local.md',hash:hash('durable local work')}],purpose:'vault_batch',message:'Local capture after refused fetch'},'later-local')).resolves.toHaveProperty('commit');}
 }finally{await f.close();}
},15000);
