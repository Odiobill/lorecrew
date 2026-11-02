import {readFile,writeFile} from 'node:fs/promises';
import {openInstance} from '../../src/instance/open.ts';
import {GitClient} from '../../src/git/client.ts';
import {openConfiguredOwnership} from '../../src/projects/configured-ownership.ts';
import {openProjectWorkflows} from '../../src/projects/workflows.ts';
const [requestFile,mode]=process.argv.slice(2),request=JSON.parse(await readFile(requestFile,'utf8')),ctx=await openInstance(request),native=new GitClient();let paused=false;
const git={run(cwd,args,options={}){return native.run(cwd,args,mode==='pause'&&!paused&&args.includes('fetch')?{...options,onSpawn:async pid=>{paused=true;process.kill(-pid,'SIGSTOP');await options.onSpawn?.(pid);const stat=await readFile('/proc/'+pid+'/stat','utf8');await writeFile(requestFile+'.paused',JSON.stringify({parent:process.pid,pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],token:options.processToken}));}}:options);}};
try{const flow=openProjectWorkflows({ctx,git,ownership:openConfiguredOwnership(ctx,git)});const result=mode==='pause'?await flow.confirm({selection:request.selection,expectedPreviewRevision:request.revision},'physical'):await flow.resume('physical');await writeFile(requestFile+'.'+mode+'.result',JSON.stringify({result,children:await ctx.store.list('repository-child'),intent:await ctx.store.read('project-flow','physical')}));}finally{await ctx.close();}
