import { execFile,spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
export async function firstRunBrowser(){
 const root=await mkdtemp(join(tmpdir(),'lorecrew-first-run-browser-'));await mkdir(join(root,'auth'),{mode:0o700});await writeFile(join(root,'auth','auth.json'),'{}',{mode:0o600});
 let child:ReturnType<typeof spawn>,closed:Promise<number|null>,stderr='';
 async function start(){stderr='';child=spawn(process.execPath,[resolve('dist/cli.js'),'serve','--state-dir',join(root,'state'),'--port','0'],{env:{PATH:'/usr/bin:/bin',HOME:root,LORECREW_AUTH_FILE:join(root,'auth','auth.json'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});child.stderr!.on('data',b=>stderr+=b);closed=new Promise(r=>child.once('close',r));for(let i=0;i<1000;i++){const url=stderr.match(/Lorecrew serving (http:\/\/\S+)/)?.[1],secret=stderr.match(/Lorecrew login secret .*: ([A-Za-z0-9_-]+)/)?.[1];if(url&&secret)return {url,secret};if(child.exitCode!==null)throw new Error('Compiled first-run service exited: '+stderr.replace(/(login secret .*: )\S+/g,'$1[redacted]'));await new Promise(r=>setTimeout(r,10));}throw new Error('Compiled first-run service did not become available');}
 async function stop(){if(child.exitCode===null)child.kill('SIGTERM');const code=await closed;if(code!==0)throw new Error('Compiled first-run service did not stop cleanly');}
 const first=await start();return {...first,root,stateDir:join(root,'state'),vaultDir:join(root,'Lorecrew vault'),stop,async makeVault(path:string){await new Promise<void>((done,reject)=>execFile(process.execPath,[resolve('dist/cli.js'),'init','--state-dir',join(root,'fixture-state-'+path.split('/').at(-1)),'--vault',path],{env:{...process.env,HOME:root,LORECREW_AUTH_FILE:join(root,'auth','auth.json'),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}},error=>error?reject(error):done()));},restart:async()=>{await stop();return start();},async close(){await stop();await rm(root,{recursive:true,force:true});}};
}
