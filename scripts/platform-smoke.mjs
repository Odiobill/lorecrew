#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const here=fileURLToPath(import.meta.url), repository=resolve(dirname(here),'..');
const check=(name,state,details)=>({name,state,details});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const moduleAt=(root,path)=>import(pathToFileURL(join(root,path)).href);
export async function loadInstalledModule(packageDir,specifier){
  // Evaluate ESM resolution from the installed package directory. require.resolve
  // selects CommonJS conditions and cannot resolve Pi's import-only exports.
  const resolved=spawnSync(process.execPath,['--input-type=module','-e','process.stdout.write(import.meta.resolve(process.argv[1]))',specifier],{cwd:packageDir,encoding:'utf8',timeout:10000});
  if(resolved.error||resolved.status!==0||!resolved.stdout?.startsWith('file:'))throw Object.assign(new Error('Installed ESM dependency could not be resolved'),{code:resolved.error?.code??'INSTALLED_ESM_RESOLUTION'});
  const dependency=await realpath(fileURLToPath(resolved.stdout.trim())),modules=dirname(await realpath(packageDir));
  const rel=relative(modules,dependency);
  if(modules.split(sep).at(-1)!=='node_modules'||isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw Object.assign(new Error('Dependency escapes installed tree'),{code:'INSTALLED_PATH_ESCAPE'});
  return import(pathToFileURL(dependency).href);
}
async function repositoryProviders(){const {tsImport}=await import('tsx/esm/api');return tsImport(pathToFileURL(join(repository,'src/runtime/providers.ts')).href,import.meta.url);}

/** Repository-only verification runner. It never installs, publishes, or selects credentials. */
export async function runPlatformSmoke(options) {
  const stateDir=resolve(options.stateDir);await mkdir(stateDir,{recursive:true});
  const git=spawnSync('git',['--version'],{encoding:'utf8'});
  const report={platform:process.platform,arch:process.arch,runtime:{node:process.versions.node,git:git.status===0?git.stdout.trim():null,dependencies:{}},checks:[],rss:{idleBytes:null,activeBytes:null,workload:'Not measured'},artifacts:{report:join(stateDir,'smoke-report.json')}};
  const add=(...args)=>report.checks.push(check(...args));
  add('node24',process.versions.node.split('.')[0]==='24'?'pass':'fail','Actual executing Node runtime');
  add('git',git.status===0?'pass':'fail','Actual host Git prerequisite');
  const hostText=async path=>readFile(path,'utf8').catch(()=>'');
  const board=process.platform==='linux'&&process.arch==='arm64'?await hostText('/proc/device-tree/model'):'';
  const kernel=process.platform==='linux'?await hostText('/proc/sys/kernel/osrelease'):'';
  const actualHosts=[['linux-x64',process.platform==='linux'&&process.arch==='x64'&&!/microsoft/i.test(kernel)],['macos',process.platform==='darwin'],['wsl2',/microsoft.*WSL2|microsoft-standard/i.test(kernel)],['rpi4-arm64',/Raspberry Pi 4/.test(board)]];
  for(const [name,available] of actualHosts)add(name,'unavailable',available?'This is the current host; installed-artifact checks below determine verification.':'No actual verified host evidence supplied; architecture simulation is not evidence.');
  if(options.mode==='providers') {
    if(!options.modelA||!options.modelB)add('distinct-models','unavailable','Specify two explicit PROVIDER/MODEL configurations; no model or credentials are auto-selected.');
    else if(options.modelA===options.modelB)add('distinct-models','fail','Two different model configurations are required.');
    else {
      add('distinct-models','pass','Two explicit configurations selected.');
      // A fresh directory defaults to installed provider modules. An explicit directory may
      // provide providers.json with environment references; values are never copied/reported.
      try {
      const {openProviders,listModels}=await repositoryProviders();
      const models=await openProviders(options.providerStateDir??join(stateDir,'unconfigured-providers'));
      const available=await listModels(models);
      const ready=[options.modelA,options.modelB].every(id=>available.some(m=>`${m.provider}/${m.modelId}`===id&&m.available));
      add('configured-models',ready?'pass':'unavailable',ready?'Both selected models have configured authentication.':'One or both selected models are unavailable; no provider requests were sent.');
      if(ready){
        try {
          const child=await runWorker({stateDir,kind:'providers',modelA:options.modelA,modelB:options.modelB,providerStateDir:options.providerStateDir,timeoutMs:options.timeoutMs??120000},options.timeoutMs??120000);
          report.checks.push(...child.checks);Object.assign(report.artifacts,child.artifacts);
        }catch{add('learning-transfer','fail','The bounded scenario failed or exceeded its deadline. Provider exception text is omitted to avoid credential disclosure.');}
      }
      }catch{add('configured-models','fail','Explicit provider configuration could not be loaded; no exception text or credential values are reported.');}
    }
  }else if(!options.packageDir)add('installed-artifact','unavailable','Supply --package-dir for a clean installation of the final packed artifact.');
  else {
    try {
      const packageDir=await realpath(options.packageDir);
      if(packageDir===await realpath(repository))throw new Error('Source checkout is not an installed artifact');
      const manifest=await json(join(packageDir,'package.json'));
      if(manifest.name!=='lorecrew')throw new Error('Not a Lorecrew package');
      report.runtime.dependencies=manifest.dependencies??{};
      const child=await runWorker({stateDir,packageDir,...options.vaultRemote?{vaultRemote:options.vaultRemote}:{}},options.timeoutMs??90000);
      report.checks.push(...child.checks);report.rss=child.rss;Object.assign(report.artifacts,child.artifacts);
      add('installed-artifact',child.checks.every(c=>c.state==='pass')?'pass':'fail',`Installed Lorecrew ${manifest.version}; modules, CLI and PWA loaded from the supplied package.`);
      for(const [name,actual] of actualHosts)if(actual){const local=report.checks.find(c=>c.name===name);local.state=child.checks.every(c=>c.state==='pass')?'pass':'fail';local.details='Actual host installed smoke only; live providers, service deployment and full platform process supervision require separate verification.';}
    }catch{add('installed-artifact','fail','Installed smoke failed or exceeded its deadline. Inspect local artifact paths; command output is withheld to avoid accidental secret disclosure.');}
  }
  await writeFile(report.artifacts.report,JSON.stringify(report,null,2)+'\n',{mode:0o600});return report;
}

async function runWorker(input,timeoutMs) {
  const request=join(input.stateDir,'worker-input.json');await writeFile(request,JSON.stringify(input),{mode:0o600});
  return new Promise((done,reject)=>{
    const child=spawn(process.execPath,[here,'--worker',request],{stdio:['ignore','ignore','ignore']});
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeoutMs);timer.unref();
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',async code=>{clearTimeout(timer);if(code!==0)return reject(new Error('Worker failed'));try{done(await json(join(input.stateDir,'worker-report.json')));}catch(error){reject(error);}});
  });
}

async function providerWorker(input) {
  // tsx/fixtures are repository development dependencies, never installed CLI features.
  const {openProviders}=await repositoryProviders();
  const models=await openProviders(input.providerStateDir??join(input.stateDir,'unconfigured-providers'));
  const {tsImport}=await import('tsx/esm/api');
  const {runLearningTransfer}=await tsImport(pathToFileURL(join(repository,'tests/fixtures/learning-transfer/scenario.ts')).href,import.meta.url);
  const result=await runLearningTransfer({models,modelA:input.modelA,modelB:input.modelB,timeoutMs:input.timeoutMs,retain:true,artifactDir:input.stateDir});
  const valid=result.projectABefore==='fail'&&result.projectBBefore==='fail'&&result.projectATests==='pass'&&result.projectBTests==='pass'&&result.projectBLoadedLessons.includes(result.lessonRevision)&&result.reuseEvidence.subjectHash===result.lessonSubjectHash&&result.reuseEvidence.outcome==='pass'&&result.duplicateAdmissions===0&&!result.remoteMutationAvailable;
  await writeFile(join(input.stateDir,'worker-report.json'),JSON.stringify({checks:[check('learning-transfer',valid?'pass':'fail','Actual two-model retrieval, adaptation and executed reuse evidence; see scenario artifact.')],artifacts:{learning:join(input.stateDir,'learning-transfer.json'),vault:join(result.root,'b')}},null,2));
}

export async function verifyGitHistory({sync,git,vaultDir,expected,parseConcept}) {
  const status=await sync.status();
  if(!status.lastFetchAt||status.state!=='synchronized'||status.pending>0||status.error!=null||status.exportError!=null)throw new Error('Git synchronization reports an incomplete export or publication: '+JSON.stringify({state:status.state,pending:status.pending,error:status.error??null,exportError:status.exportError??null}));
  const run=async args=>{const result=await git.run(vaultDir,args);if(result.exitCode!==0)throw new Error('Remote history verification failed');return result.stdout;};
  // Read the remote's current main object, never the authored local vault bytes
  // or the publisher's own receipts. Fetching alone is not publication evidence.
  const remoteHead=(await run(['ls-remote','origin','refs/heads/main'])).trim().split(/\s+/)[0];
  if(!/^[a-f0-9]{40,64}$/.test(remoteHead??''))throw new Error('Remote history commit is unavailable');
  await run(['fetch','--no-tags','--no-write-fetch-head','origin','refs/heads/main']);
  const component=value=>encodeURIComponent(value).replaceAll('.','%2E');
  const entryHash=createHash('sha256').update(expected.entryId).digest('hex');
  const historyPath=`history/${component(expected.instanceId)}/${component(expected.sessionId)}/${entryHash}.md`;
  const content=await run(['show',`${remoteHead}:${historyPath}`]);
  const concept=parseConcept(historyPath,content),metadata=concept.metadata.lorecrew;
  if(concept.metadata.type!=='History'||!metadata||metadata.originId!==expected.instanceId||metadata.sessionId!==expected.sessionId||metadata.entryId!==expected.entryId||metadata.kind!=='user'||!concept.body.includes(expected.text))throw new Error('Remote history does not contain the exact admitted session message');
  return {remoteHead,historyPath,instanceId:expected.instanceId,sessionId:expected.sessionId,entryId:expected.entryId,text:expected.text,documentHash:createHash('sha256').update(content).digest('hex')};
}

async function platformWorker({stateDir,packageDir,vaultRemote}) {
  const root=await mkdtemp(join(stateDir,'installed spazio è-'));const vaultDir=join(root,'vault'),instanceDir=join(root,'state');
  const checks=[];const add=(...args)=>checks.push(check(...args));
  const git=(cwd,args)=>{const result=spawnSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});if(result.status!==0)throw new Error('Git smoke failed');return result.stdout;};
  if(vaultRemote)git(root,['clone',vaultRemote,vaultDir]);
  else {
    const native=spawnSync(process.execPath,[join(packageDir,'dist/cli.js'),'init','--state-dir',instanceDir,'--vault',vaultDir],{encoding:'utf8'});if(native.status!==0)throw new Error('Installed native Git vault init failed');
    const remote=join(root,'remote.git');git(root,['init','--bare','--template=','--initial-branch=main',remote]);git(vaultDir,['remote','add','origin',remote]);
    git(vaultDir,['config','user.name','Platform smoke']);git(vaultDir,['config','user.email','smoke@example.test']);
    await writeFile(join(vaultDir,'index.md'),'---\nokf_version: "0.2"\n---\n# Platform smoke vault\n');git(vaultDir,['add','index.md']);git(vaultDir,['commit','-m','Platform fixture']);git(vaultDir,['push','origin','main']);
  }
  const cli=spawnSync(process.execPath,[join(packageDir,'dist/cli.js'),'init','--state-dir',instanceDir,'--vault',vaultDir],{encoding:'utf8'});
  if(cli.status!==0)throw new Error('Installed CLI init failed');add('installed-cli','pass','Compiled installed CLI initialized Unicode-safe local state.');
  const {openInstance}=await moduleAt(packageDir,'dist/instance/open.js');const {openVault}=await moduleAt(packageDir,'dist/vault/write.js');
  const {openRuntime}=await moduleAt(packageDir,'dist/runtime/pi-host.js');const {openOwnership}=await moduleAt(packageDir,'dist/projects/ownership.js');
  const {WorkspaceManager}=await moduleAt(packageDir,'dist/workspaces/manager.js');const {ProcessSupervisor}=await moduleAt(packageDir,'dist/workspaces/processes.js');
  const {GitClient}=await moduleAt(packageDir,'dist/git/client.js');const {openVaultSync}=await moduleAt(packageDir,'dist/sync/service.js');
  const {createModels}=await loadInstalledModule(packageDir,'@earendil-works/pi-ai/models');
  const {fauxProvider,fauxAssistantMessage,fauxToolCall}=await loadInstalledModule(packageDir,'@earendil-works/pi-ai/providers/faux');
  const provider=fauxProvider({provider:'scripted',models:[{id:'platform'}],tokensPerSecond:Infinity});const models=createModels();models.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage(fauxToolCall('codemode',{code:'const page=JSON.parse(await tools.knowledge_search({query:"Platform"})); if(!page.items.length)throw new Error("No platform knowledge"); text(await tools.knowledge_load({path:page.items[0].path,revision:page.items[0].revision})); text(await tools.skill_search({}));'}),{stopReason:'toolUse'}),fauxAssistantMessage('Platform CodeMode completed')]);
  let ctx=await openInstance({stateDir:instanceDir,vaultDir});let runtime;let sync;let app;
  let activeBytes=process.memoryUsage().rss;const samples=setInterval(()=>{activeBytes=Math.max(activeBytes,process.memoryUsage().rss);},20);
  try {
    await writeFile(join(instanceDir,'providers.json'),'[]\n');const vault=openVault(ctx);
    await vault.propose({id:'agent',path:'agents/platform.md',expectedRevision:null,actor:'user:smoke',content:'---\n'+JSON.stringify({type:'Agent',title:'Platform',lorecrew:{id:'platform',name:'Platform',personality:'Precise',responsibilities:['Check'],groups:[],model:{provider:'scripted',modelId:'platform'}}})+'\n---\nRun platform tools.\n'});
    const options={ctx,vault,ownership:openOwnership(ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models};
    runtime=await openRuntime(options);const session=await runtime.createSession({requestId:'platform',agentId:'platform'});
    await runtime.submit({sessionId:session.id,requestId:'platform-run',text:'Execute the platform tools'});
    const until=Date.now()+20000;while(Date.now()<until&&(await runtime.snapshot(session.id)).status==='running')await delay(25);
    const snapshot=await runtime.snapshot(session.id);if(snapshot.status!=='completed'||!(await ctx.store.list('knowledge-load')).some(load=>load.sessionId===session.id))throw new Error('CodeMode did not execute');
    add('installed-codemode','pass','Actual installed Pi and CodeMode executed discovery tools with a scripted provider.');
    sync=await openVaultSync({ctx,vault,runtime,git:new GitClient(),publicationMs:600000,retryMs:600000});await sync.flush();
    const entry=(await runtime.history(session.id)).find(item=>item.kind==='user');if(!entry)throw new Error('No actual admitted user message');
    const {parseConcept}=await moduleAt(packageDir,'dist/vault/parse.js');
    const gitEvidence=await verifyGitHistory({sync,git:new GitClient(),vaultDir,expected:{instanceId:ctx.instanceId,sessionId:session.id,entryId:entry.id,text:'Execute the platform tools'},parseConcept});
    await writeFile(join(stateDir,'git-history-evidence.json'),JSON.stringify(gitEvidence,null,2));
    add('installed-git-sync','pass','No export/publication errors; independently read the exact admitted session/user-message identity and text from the remote main commit.');await sync.close();sync=undefined;
    await runtime.close();runtime=undefined;await ctx.close();
    ctx=await openInstance({stateDir:instanceDir,vaultDir});runtime=await openRuntime({...options,ctx,vault:openVault(ctx),ownership:openOwnership(ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx)});
    if((await runtime.snapshot(session.id)).messages.filter(m=>m.kind==='user').length!==1)throw new Error('SQLite restart duplicated admission');
    add('installed-sqlite-restart','pass','Installed runtime reopened its real Pi/control databases and retained one admitted message.');
    await runtime.close();runtime=undefined;await ctx.close();
    const {startApp}=await moduleAt(packageDir,'dist/app.js');let secret;
    app=await startApp({stateDir:instanceDir,vaultDir,port:0,syncRemote:false,onBootstrap:value=>{secret=value;}});
    const unauth=await fetch(app.url+'/api/v1/instance');if(unauth.status!==401)throw new Error('Authentication not enforced');
    const login=await fetch(app.url+'/api/v1/auth/login',{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json'},body:JSON.stringify({secret})});if(!login.ok)throw new Error('Login failed');
    const cookie=login.headers.get('set-cookie').split(';')[0];const html=await fetch(app.url+'/');if(!html.ok||!(await html.text()).includes('<html'))throw new Error('Installed PWA unavailable');
    for(let i=0;i<10;i++){const result=await fetch(app.url+'/api/v1/sessions',{headers:{Cookie:cookie}});if(!result.ok)throw new Error('Authenticated API failed');activeBytes=Math.max(activeBytes,process.memoryUsage().rss);}
    add('installed-http-pwa','pass','Actual installed server served built PWA assets, enforced authentication and returned durable sessions.');
    clearInterval(samples);await delay(1000);const idleBytes=process.memoryUsage().rss;await app.close();app=undefined;
    const index=await readFile(join(vaultDir,'index.md'),'utf8');if(!index.includes('0.2'))throw new Error('Standalone OKF index missing');
    add('stopped-vault','pass','Ordinary Markdown vault remains readable after every runtime and HTTP listener closed.');
    await writeFile(join(stateDir,'worker-report.json'),JSON.stringify({checks,rss:{idleBytes,activeBytes,workload:'Installed process RSS: idle after 1s; active peak sampled during scripted Pi/CodeMode, SQLite restart, Git sync and authenticated HTTP. No RAM cap asserted.'},artifacts:{vault:vaultDir,instance:instanceDir,gitHistory:join(stateDir,'git-history-evidence.json')}},null,2));
  }catch{
    add('installed-worker','fail','Installed worker stopped after the last reported successful check; retained state and vault support diagnosis.');
    await writeFile(join(stateDir,'worker-report.json'),JSON.stringify({checks,rss:{idleBytes:null,activeBytes,workload:'Incomplete installed workload; no idle sample'},artifacts:{vault:vaultDir,instance:instanceDir}},null,2));
  }finally{clearInterval(samples);await app?.close();await sync?.close();await runtime?.close();await ctx.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===here){
  const {values}=parseArgs({options:{worker:{type:'string'},mode:{type:'string'},'state-dir':{type:'string'},'package-dir':{type:'string'},'vault-remote':{type:'string'},'provider-state-dir':{type:'string'},'model-a':{type:'string'},'model-b':{type:'string'},'timeout-ms':{type:'string'}}});
  if(values.worker){
    const input=await json(values.worker);
    try{await (input.kind==='providers'?providerWorker(input):platformWorker(input));}
    catch(error){
      // Preserve an actionable failure class even before the worker initializes
      // its ordinary report. Never include exception text, stderr or credentials.
      const safeCodes=['ERR_PACKAGE_PATH_NOT_EXPORTED','ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND','INSTALLED_ESM_RESOLUTION','ENOENT','EACCES','EPERM'];
      const code=safeCodes.includes(error?.code)?error.code:'WORKER_FAILED';
      await writeFile(join(input.stateDir,'worker-report.json'),JSON.stringify({checks:[check(input.kind==='providers'?'learning-transfer':'installed-worker-setup','fail',`Worker could not complete: ${code}. Raw exception output is withheld.`)],rss:{idleBytes:null,activeBytes:null,workload:'Worker did not complete'},artifacts:{workerInput:values.worker}},null,2));
    }
  }
  else {
    const report=await runPlatformSmoke({stateDir:values['state-dir']??await mkdtemp(join(tmpdir(),'lorecrew-smoke-')),mode:values.mode??'platform',packageDir:values['package-dir'],vaultRemote:values['vault-remote'],providerStateDir:values['provider-state-dir'],modelA:values['model-a'],modelB:values['model-b'],timeoutMs:values['timeout-ms']?Number(values['timeout-ms']):undefined});
    console.log(JSON.stringify(report,null,2));process.exitCode=report.checks.some(c=>c.state==='fail')?1:report.checks.some(c=>c.state==='unavailable'&&['installed-artifact','configured-models','distinct-models'].includes(c.name))?2:0;
  }
}
