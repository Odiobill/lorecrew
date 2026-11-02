import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporaryInstance } from '../helpers/temp.js';
import { crashTools } from '../helpers/crash-tools.js';
import { scriptedProvider, fauxAssistantMessage } from '../helpers/scripted-provider.js';
import { openInstance } from '../../src/instance/open.js';
import { openVault } from '../../src/vault/write.js';
import { openOwnership } from '../../src/projects/ownership.js';
import { GitClient } from '../../src/git/client.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
for(const stage of ['admission','journal','uncertain'])it(`recovers SIGKILL at ${stage} without duplicating admitted work or effects`,async()=>{
  const f=await temporaryInstance();
  try {
    await cp('tests/fixtures/vault',f.paths.vaultDir,{recursive:true});
    const path=join(f.paths.vaultDir,'agents/ada.md');
    await writeFile(path,(await readFile(path,'utf8')).replace('local-openai','scripted').replace('coding-model','test-model'));
    const killed=await new Promise<{code:number|null;signal:NodeJS.Signals|null;stderr:string}>((done,reject)=>{
      const child=spawn(process.execPath,['--experimental-transform-types',resolve('tests/helpers/pi-crash-worker.mjs'),f.root,stage],{stdio:['ignore','ignore','pipe']});
      let stderr='';child.stderr.on('data',data=>stderr+=String(data));child.on('error',reject);child.on('close',(code,signal)=>done({code,signal,stderr}));
    });
    expect(killed.signal,killed.stderr).toBe('SIGKILL');
    const ctx=await openInstance(f.paths);const provider=scriptedProvider();provider.faux.setResponses([fauxAssistantMessage('Recovered')]);
    const runtime=await openRuntime({ctx,vault:openVault(ctx),ownership:openOwnership(ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models,extensions:[crashTools(f.root,stage,false)]});
    try {
      const session=await runtime.createSession({requestId:'create',agentId:'agent-ada'});
      if(stage==='uncertain') {
        expect((await runtime.snapshot(session.id)).blockedReason).toBe('uncertain_tool_outcome');
        expect(provider.faux.state.callCount).toBe(0);
      } else {
        const input={sessionId:session.id,requestId:'submit',text:'Run once'};
        expect(await runtime.submit(input)).toEqual(await runtime.submit(input));
        await expect.poll(async()=>(await runtime.snapshot(session.id)).status).toBe('completed');
        const snap=await runtime.snapshot(session.id);
        expect(snap.messages.filter(m=>m.kind==='user')).toHaveLength(1);
        if(stage==='journal')expect(JSON.stringify(snap.tools)).toContain('resumed journal');
      }
      if(stage!=='admission')expect(await readFile(join(f.root,'effects.log'),'utf8')).toBe('effect\n');
    }finally{await runtime.close();await ctx.close();}
  }finally{await f.cleanup();}
},15000);
