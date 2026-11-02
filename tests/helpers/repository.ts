import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openState } from '../../src/instance/state.js';
import { GitClient } from '../../src/git/client.js';
import { openRepositories } from '../../src/repositories/service.js';
export async function repositoryFixture(){
 const root=await mkdtemp(join(tmpdir(),'lorecrew-repository-'));const path=join(root,'repo');await mkdir(path);const git=new GitClient();
 const gitAt=async(args:string[])=>{const r=await git.run(path,args);if(r.exitCode)throw new Error(r.stderr);return r.stdout.trim();};
 await gitAt(['init','--template=','--initial-branch=main']);await writeFile(join(path,'base.md'),'base\n');await gitAt(['add','base.md']);await gitAt(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','base']);
 let state=await openState({stateDir:join(root,'state')});let repositories=openRepositories({state,git});
 return {root,path,git,gitAt,get state(){return state;},get repositories(){return repositories;},async reopen(){await state.close();state=await openState({stateDir:join(root,'state')});repositories=openRepositories({state,git});},async close(){await state.close();await rm(root,{recursive:true,force:true});}};
}
