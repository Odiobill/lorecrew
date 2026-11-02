import {mkdir,writeFile,access} from 'node:fs/promises';
import {join} from 'node:path';
import {GitClient} from '../../src/git/client.js';
/** Real, independent code repository. Never use the vault as an execution fixture. */
export async function gitProject(path:string,files:Record<string,string>={'README.md':'# Fixture\n'}){await mkdir(path,{recursive:true});try{await access(join(path,'.git'));return path;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const git=new GitClient();const run=async(args:string[])=>{const r=await git.run(path,args);if(r.exitCode)throw new Error('Git fixture failed: '+r.stderr);};await run(['init','--template=','--initial-branch=main']);for(const [name,content] of Object.entries(files))await writeFile(join(path,name),content);await run(['add','--',...Object.keys(files)]);await run(['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','base']);return path;}
