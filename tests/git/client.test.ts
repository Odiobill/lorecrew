import { expect, it } from 'vitest';
import { GitClient } from '../../src/git/client.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
it.skipIf(process.platform!=='linux')('cancels a stalled Git transport and its helper without treating interruption as confirmation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'lorecrew-git-cancel-'));const controller=new AbortController();
 try{const git=new GitClient();const pending=git.run(root,['-c',`alias.stall=!echo $$ > helper.pid; exec sleep 30`,'stall'],{signal:controller.signal});const result=pending.catch(error=>error);let pid=0;await expect.poll(async()=>{try{pid=Number(await readFile(join(root,'helper.pid'),'utf8'));return pid>0;}catch{return false;}}).toBe(true);controller.abort();expect(await result).toMatchObject({code:'GIT_CANCELLED'});await expect.poll(async()=>{try{const stat=await readFile(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).startsWith('Z');}catch{return true;}}).toBe(true);
 }finally{await rm(root,{recursive:true,force:true});}
});

it.skipIf(process.platform==='win32')('preserves Unicode when Git splits a character across output chunks',async()=>{
 const git=new GitClient();const result=await git.run(process.cwd(),['-c',`alias.split=!printf '\\342'; sleep 0.05; printf '\\202\\254'`,'split']);expect(result).toEqual({exitCode:0,stdout:'€',stderr:''});
});
