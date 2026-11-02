import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The smoke entry point is JavaScript, and must be safely importable without starting work.
const smoke = () => import('../../scripts/platform-smoke.mjs');
it('exports a reusable report runner without treating absent hardware or package inputs as passing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lorecrew-smoke-contract-'));
  try {
    const {runPlatformSmoke}=await smoke();
    const report=await runPlatformSmoke({stateDir:dir,mode:'platform'});
    expect(report.platform).toBe(process.platform);expect(report.arch).toBe(process.arch);
    expect(report.runtime.node).toBe(process.versions.node);
    expect(report.checks).toContainEqual(expect.objectContaining({name:'installed-artifact',state:'unavailable'}));
    expect(report.checks).toContainEqual(expect.objectContaining({name:'rpi4-arm64',state:'unavailable'}));
    expect(report.rss).toMatchObject({idleBytes:null,activeBytes:null});
    expect(JSON.parse(await readFile(report.artifacts.report,'utf8'))).toEqual(report);
  }finally{await rm(dir,{recursive:true,force:true});}
});
it('refuses a claimed two-model demonstration with the same model configuration',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lorecrew-smoke-distinct-'));
  try {
    const {runPlatformSmoke}=await smoke();const report=await runPlatformSmoke({stateDir:dir,mode:'providers',modelA:'openai/example',modelB:'openai/example'});
    expect(report.checks).toContainEqual(expect.objectContaining({name:'distinct-models',state:'fail'}));
    expect(report.checks.some((c:{name:string;state:string})=>c.name==='learning-transfer'&&c.state==='pass')).toBe(false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
it('reports explicitly unconfigured selected models unavailable without running a model call',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'lorecrew-smoke-unavailable-'));
  try {
    const {writeFile}=await import('node:fs/promises');await writeFile(join(dir,'providers.json'),'[]');
    const {runPlatformSmoke}=await smoke();
    const report=await runPlatformSmoke({stateDir:dir,providerStateDir:dir,mode:'providers',modelA:'openai/unconfigured-a',modelB:'anthropic/unconfigured-b'});
    expect(report.checks).toContainEqual(expect.objectContaining({name:'configured-models',state:'unavailable'}));
    expect(report.checks.some((c:{name:string})=>c.name==='learning-transfer')).toBe(false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
it('loads ESM-only exports relative to the installed package without resolving checkout dependencies',async()=>{
  const {mkdir,writeFile}=await import('node:fs/promises');
  const dir=await mkdtemp(join(tmpdir(),'lorecrew-smoke-esm-'));
  try {
    const packageDir=join(dir,'node_modules/lorecrew');const dependency=join(dir,'node_modules/@smoke/esm-only');
    await mkdir(packageDir,{recursive:true});await mkdir(dependency,{recursive:true});
    await writeFile(join(packageDir,'package.json'),JSON.stringify({name:'lorecrew',type:'module'}));
    await writeFile(join(dependency,'package.json'),JSON.stringify({name:'@smoke/esm-only',type:'module',exports:{'./models':{import:'./models.mjs'}}}));
    await writeFile(join(dependency,'models.mjs'),'export const installedMarker = "isolated-installed-dependency";');
    const {loadInstalledModule}=await smoke();
    await expect(loadInstalledModule(packageDir,'@smoke/esm-only/models')).resolves.toMatchObject({installedMarker:'isolated-installed-dependency'});
  }finally{await rm(dir,{recursive:true,force:true});}
});
it.each(['failed publication','failed export','missing exact message'])('does not certify installed Git synchronization after %s despite a successful earlier fetch',async failure=>{
  const {gitFleet}=await import('../helpers/git-fleet.js');
  const {scriptedProvider,fauxAssistantMessage}=await import('../helpers/scripted-provider.js');
  const {openVault}=await import('../../src/vault/write.js');
  const {parseConcept}=await import('../../src/vault/parse.js');
  const {openRuntime}=await import('../../src/runtime/pi-host.js');
  const {openOwnership}=await import('../../src/projects/ownership.js');
  const {WorkspaceManager}=await import('../../src/workspaces/manager.js');
  const {ProcessSupervisor}=await import('../../src/workspaces/processes.js');
  const {openVaultSync}=await import('../../src/sync/service.js');
  const f=await gitFleet();let runtime:Awaited<ReturnType<typeof openRuntime>>|undefined;let sync:Awaited<ReturnType<typeof openVaultSync>>|undefined;
  try {
    const ctx=f.a.ctx,vault=openVault(ctx),provider=scriptedProvider();provider.faux.setResponses([fauxAssistantMessage('History published')]);
    await vault.propose({id:'agent',path:'agents/check.md',expectedRevision:null,actor:'human:owner',content:'---\n'+JSON.stringify({type:'Agent',title:'Check',lorecrew:{id:'check',name:'Check',personality:'Precise',responsibilities:['Verify'],groups:[],model:{provider:'scripted',modelId:'test-model'}}})+'\n---\nVerify history.\n'});
    const r=runtime=await openRuntime({ctx,vault,ownership:openOwnership(ctx,f.a.git,f.remote),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models:provider.models});
    const session=await r.createSession({requestId:'history',agentId:'check'});const text='Exact smoke history message';
    await r.submit({sessionId:session.id,requestId:'history-message',text});await expect.poll(async()=>(await r.snapshot(session.id)).status).toBe('completed');
    const entry=(await r.history(session.id)).find(e=>e.kind==='user')!;
    let failPush=false,failExport=false;
    let blockedPushes=0;const git={run:async(cwd:string,args:string[],options?:import('../../src/git/client.js').GitRunOptions)=>{if(failPush&&args.includes('push')){blockedPushes++;return {stdout:'',stderr:'simulated transport rejection',exitCode:128};}return f.a.git.run(cwd,args,options);}};
    sync=await openVaultSync({ctx,vault,git,runtime:{history:async(...args:Parameters<typeof r.history>)=>{if(failExport)throw new Error('simulated export failure');return r.history(...args);}},publicationMs:600000,retryMs:600000});await sync.flush();
    const {verifyGitHistory}=await smoke();const input={sync,git,vaultDir:ctx.vaultDir,expected:{instanceId:ctx.instanceId,sessionId:session.id,entryId:entry.id,text},parseConcept};
    await expect.poll(async()=>{await sync!.flush();try{await verifyGitHistory(input);return true;}catch(error){console.info('Initial smoke publication pending:',error instanceof Error?error.message:'unconfirmed');return false;}},{timeout:10000}).toBe(true);
    if(failure==='missing exact message')input.expected.entryId='a-message-that-was-never-exported';
    else {
      if(failure==='failed publication'){
        failPush=true;await vault.propose({id:'unpublished',path:'lessons/unpublished.md',expectedRevision:null,actor:'human:owner',content:'---\ntype: Lesson\n---\nMust not be called synchronized.\n'});
      }else failExport=true;
      await sync.flush();if(failure==='failed publication')await expect.poll(async()=>{if(!blockedPushes)await sync!.flush();return blockedPushes;},{timeout:10000}).toBeGreaterThan(0);const status=await sync.status();expect(status.lastFetchAt).toEqual(expect.any(String));
      expect(failure==='failed publication'?status.pending:status.exportError).toBeTruthy();
    }
    await expect(verifyGitHistory(input)).rejects.toThrow();
  }finally{await sync?.close();await runtime?.close();await f.cleanup();}
},30_000);
it('refuses an installed ESM dependency symlink that resolves to checkout modules',async()=>{
 const {mkdir,writeFile,symlink}=await import('node:fs/promises');const dir=await mkdtemp(join(tmpdir(),'lorecrew-smoke-link-'));
 try{
  const packageDir=join(dir,'node_modules/lorecrew');await mkdir(packageDir,{recursive:true});
  await writeFile(join(packageDir,'package.json'),'{"name":"lorecrew","type":"module"}');
  await mkdir(join(dir,'node_modules/@earendil-works'),{recursive:true});
  await symlink(new URL('../../node_modules/@earendil-works/pi-ai',import.meta.url),join(dir,'node_modules/@earendil-works/pi-ai'));
  const {loadInstalledModule}=await smoke();
  await expect(loadInstalledModule(packageDir,'@earendil-works/pi-ai/models')).rejects.toMatchObject({code:'INSTALLED_PATH_ESCAPE'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
