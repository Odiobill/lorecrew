#!/usr/bin/env node
// Repository-only orchestration. Every executable application/Pi import is installed.
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {cp,lstat,mkdir,open,readFile,readdir,readlink,realpath,rename,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isDeepStrictEqual,parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {loadInstalledModule} from './platform-smoke.mjs';
const here=fileURLToPath(import.meta.url),repo=resolve(dirname(here),'..');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const save=(p,v)=>writeFile(p,JSON.stringify(v,null,2)+'\n',{mode:0o600});
const sha=b=>createHash('sha256').update(b).digest('hex');
const error=code=>Object.assign(new Error(code),{code});
const inside=(root,p)=>{const r=relative(root,p);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));};
const check=(name,details)=>({name,state:'pass',details});
function equal(actual,expected,label){if(!isDeepStrictEqual(actual,expected))throw error('MISMATCH_'+label);}
async function refuses(work,code){try{await work();}catch(e){if(e.code===code)return;throw e;}throw error('EXPECTED_'+code);}

/** Hash actual installed bytes including dependencies, not only declared versions. */
export async function installedIdentity(input){
 const packageDir=resolve(input),actual=await realpath(packageDir);
 if(actual!==packageDir||inside(repo,actual)||dirname(actual).split(sep).at(-1)!=='node_modules')throw error('INSTALLED_PATH_ESCAPE');
 const modules=dirname(actual),hash=createHash('sha256'),packages=[];
 async function walk(dir){for(const name of (await readdir(dir)).sort()){
  const p=join(dir,name),r=relative(modules,p),s=await lstat(p);
  hash.update(JSON.stringify([r,s.mode&0o777,s.isDirectory()?'directory':s.isSymbolicLink()?'link':'file'])+'\n');
  if(s.isSymbolicLink()){
   if(!inside(modules,await realpath(p)))throw error('INSTALLED_PATH_ESCAPE');
   hash.update(await readlink(p));
  }else if(s.isDirectory())await walk(p);
  else if(s.isFile()){
   const bytes=await readFile(p);hash.update(sha(bytes));
   if(name==='package.json'){const m=JSON.parse(bytes.toString());if(m.name&&m.version)packages.push({path:r,name:m.name,version:m.version});}
  }else throw error('INSTALLED_SPECIAL_FILE');
 }}
 await walk(modules);
 const manifest=await json(join(actual,'package.json'));if(manifest.name!=='lorecrew')throw error('NOT_LORECREW');
 return {packageDir:actual,treeSha256:hash.digest('hex'),packages};
}

/** Invented immutable Git objects only. Unknown paths are errors, never live fallback. */
export function scriptedSkillSource(version=1){
 const commit=(version===1?'a':'c').repeat(40),tree=(version===1?'b':'d').repeat(40);
 const files={'sample/SKILL.md':`---\r\nname: recovery-review\r\ndescription: Offline recovery review\r\nlicense: MIT\r\n---\r\nRead [reference](references/guide.md). Revision ${version}.\r\n`,
  'sample/references/guide.md':`Original reference café, revision ${version}.\n`,
  'sample/scripts/check.sh':`#!/bin/sh\nprintf 'inert reference ${version}; never execute'\n`};
 const blobs=new Map(),trees=new Map([[tree,'']]);
 const entries=Object.entries(files).map(([path,text])=>{const id=createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');blobs.set(id,text);return {path,mode:path.endsWith('.sh')?'100755':'100644',type:'blob',sha:id,size:Buffer.byteLength(text)};});
 return {async get(path,_signal){
  if(path==='/repos/example/recovery')return {private:false,default_branch:'main',full_name:'example/recovery'};
  if(['/repos/example/recovery/commits/main',`/repos/example/recovery/commits/${commit}`].includes(path))return {sha:commit,commit:{tree:{sha:tree}}};
  const tm=/^\/repos\/example\/recovery\/git\/trees\/([a-f0-9]{40})(\?recursive=1)?$/.exec(path);
  if(tm&&trees.has(tm[1])){const root=trees.get(tm[1]),selected=entries.filter(e=>e.path.startsWith(root)).map(e=>({...e,path:e.path.slice(root.length)}));
   if(tm[2])return {sha:tm[1],truncated:false,tree:selected};
   const direct=new Map();for(const e of selected){if(e.path.includes('/')){const folder=e.path.split('/')[0],id=createHash('sha1').update('tree:'+root+folder).digest('hex');trees.set(id,root+folder+'/');direct.set(folder,{path:folder,mode:'040000',type:'tree',sha:id});}else direct.set(e.path,e);}
   return {sha:tm[1],truncated:false,tree:[...direct.values()]};
  }
  const bm=/^\/repos\/example\/recovery\/git\/blobs\/([a-f0-9]{40})$/.exec(path);
  if(bm&&blobs.has(bm[1])){const text=blobs.get(bm[1]);return {sha:bm[1],encoding:'base64',size:Buffer.byteLength(text),content:Buffer.from(text).toString('base64')};}
  throw new Error('Unscripted GitHub path: '+path);
 }};
}

function isolatedEnv(home){return {PATH:process.env.PATH,HOME:home,LORECREW_AUTH_FILE:join(home,'auth.json'),PI_CODING_AGENT_DIR:join(home,'pi'),
 GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'protocol.allow',GIT_CONFIG_VALUE_0:'never',GIT_CONFIG_KEY_1:'protocol.file.allow',GIT_CONFIG_VALUE_1:'always'};}
// A deadline is failure, never proof of a stopped child. Keep PID, input, logs and state.
export async function runRecoveryChild(input,label,args,{cwd=input.stateDir,allowed=[0]}={}){
 const out=await open(join(input.stateDir,label+'.stdout'),'wx',0o600),err=await open(join(input.stateDir,label+'.stderr'),'wx',0o600);
 try{return await new Promise((done,reject)=>{
  const child=spawn(args[0],args.slice(1),{cwd,env:isolatedEnv(input.home),stdio:['ignore',out.fd,err.fd]});
  let settled=false;
  const timer=setTimeout(async()=>{
   settled=true;child.unref();
   const failure=Object.assign(error('WORKER_TIMEOUT'),{unresolved:true,pid:child.pid,label});
   // A late successful verifier may unlink restore-quarantine. This existing
   // execution gate is independent of that verifier and is never removed here.
   if(input.restoreStateDir)try{
    await mkdir(input.restoreStateDir,{recursive:true,mode:0o700});
    let marker;
    try{marker=await open(join(input.restoreStateDir,'restore-incomplete.json'),'wx',0o600);}
    catch(e){if(e.code!=='EEXIST')throw e;}
    if(marker)try{await marker.writeFile(JSON.stringify({reason:'unresolved recovery worker',label,pid:child.pid}));await marker.sync();}finally{await marker.close();}
    const dir=await open(input.restoreStateDir,'r');try{await dir.sync();}finally{await dir.close();}
   }catch(e){failure.fenceError={code:e.code??'TIMEOUT_FENCE_WRITE_FAILED'};}
   try{await save(join(input.stateDir,'unresolved-child.json'),{label,pid:child.pid,unresolved:true,reason:'deadline; no cleanup or rollback authorized',...failure.fenceError?{fenceError:failure.fenceError}:{}});}
   catch(e){failure.persistenceError={code:e.code??'TIMEOUT_EVIDENCE_WRITE_FAILED'};}
   // Persistence failure cannot turn an unresolved process into an ordinary error.
   reject(failure);
  },input.timeoutMs??90000);
  child.once('error',e=>{clearTimeout(timer);if(!settled){settled=true;reject(e);}});
  child.once('close',(code,signal)=>{clearTimeout(timer);if(settled)return;settled=true;if(signal||!allowed.includes(code))reject(error('CHILD_FAILED_'+label));else done({code});});
 });}finally{await out.close();await err.close();}
}

// Restore connectivity only after a verifier is known to have exited. A deadline
// leaves the authority offline so a late worker cannot clear quarantine afterward.
export async function withOfflineAuthority(remote,verify){
 await rename(remote,remote+'.offline');
 try{await verify();}
 catch(e){if(!e.unresolved&&e.code!=='WORKER_TIMEOUT')await rename(remote+'.offline',remote);throw e;}
 await rename(remote+'.offline',remote);
}

export async function runInstalledRecovery(options){
 const stateDir=resolve(options.stateDir);
 await mkdir(stateDir,{recursive:true,mode:0o700});
 if((await readdir(stateDir)).length)throw error('EVIDENCE_NOT_EMPTY');
 const report={checks:[],artifacts:{report:join(stateDir,'recovery-report.json'),request:join(stateDir,'request.json')}};
 // Atomically claim even an empty existing root; racing controllers cannot replace identity.
 try{await writeFile(report.artifacts.request,JSON.stringify(options,null,2)+'\n',{flag:'wx',mode:0o600});}
 catch(e){if(e.code==='EEXIST')throw error('EVIDENCE_NOT_EMPTY');throw e;}
 const input={...options,stateDir,home:join(stateDir,'private-home')};await mkdir(input.home,{mode:0o700});
 let phase='installed-package';
 try{
  if(!/^[a-f0-9]{64}$/.test(options.artifactSha256))throw error('ARTIFACT_HASH_REQUIRED');
  const identity=await installedIdentity(options.packageDir);input.packageDir=identity.packageDir;
  await readFile(join(input.packageDir,'dist/cli.js'));
  await save(join(stateDir,'installed-identity.json'),{...identity,artifactSha256:options.artifactSha256});
  report.artifacts.identity=join(stateDir,'installed-identity.json');report.checks.push(check(phase,'Installed tree bytes and package/dependency versions bound to the supplied tarball hash.'));
  let request=join(stateDir,'worker-input.json');await save(request,input);
  phase='seed-and-stop';await runRecoveryChild(input,'seed',[process.execPath,here,'--worker','seed','--input',request]);
  const expected=await json(join(stateDir,'expected.json'));
  report.artifacts.expected=join(stateDir,'expected.json');report.artifacts.original=expected.originalState;report.artifacts.vaultSnapshot=join(stateDir,'stopped-vault');
  report.checks.push(check('original-stopped','Seeding process exited normally after joining API, schedules, Pi runtime, process proof and instance lock.'));
  await cp(expected.vaultDir,report.artifacts.vaultSnapshot,{recursive:true,errorOnExist:true,force:false});
  let cli=join(input.packageDir,'dist/cli.js');
  const restored=join(stateDir,'restored'),archive=join(stateDir,'backup');
  report.artifacts.backup=archive;report.artifacts.restored=restored;
  phase='backup';await runRecoveryChild(input,'backup',[process.execPath,cli,'backup','--state-dir',expected.originalState,'--destination',archive]);
  phase='same-candidate-replacement';
  const replacement=join(stateDir,'replacement','node_modules');
  // All original application processes are closed. Preserve the original install and
  // replace it for recovery with an exact stopped copy in a fresh prefix.
  await cp(dirname(input.packageDir),replacement,{recursive:true,errorOnExist:true,force:false,verbatimSymlinks:true});
  input.packageDir=join(replacement,'lorecrew');
  equal((await installedIdentity(input.packageDir)).treeSha256,identity.treeSha256,'REPLACEMENT_TREE');
  request=join(stateDir,'replacement-input.json');await save(request,input);cli=join(input.packageDir,'dist/cli.js');
  report.artifacts.replacement=input.packageDir;
  report.checks.push(check(phase,'Stopped installed application and dependencies copied into an empty replacement prefix; byte/mode/link tree identity is exact. Restore/reopen use only that replacement. This is not cross-version evidence.'));
  phase='fencing-required';await runRecoveryChild(input,'unfenced-restore',[process.execPath,cli,'restore','--archive',archive,'--state-dir',restored],{allowed:[1]});
  equal(JSON.parse(await readFile(join(stateDir,'unfenced-restore.stderr'),'utf8')).code,'FENCING_REQUIRED','FENCING');
  input.restoreStateDir=restored;
  phase='restore';await runRecoveryChild(input,'restore',[process.execPath,cli,'restore','--archive',archive,'--state-dir',restored,'--original-instance-fenced']);
  report.checks.push(check('positive-fencing','Unfenced restore refused; original process and descendants stopped before explicit fencing acknowledgment.'));
  phase='restore-quarantine';await runRecoveryChild(input,'quarantine-doctor',[process.execPath,cli,'doctor','--json','--state-dir',restored],{allowed:[1]});
  const doctor=await json(join(stateDir,'quarantine-doctor.stdout'));
  if(!doctor.diagnostics.some(d=>d.code==='RESTORE_QUARANTINED'))throw error('QUARANTINE_NOT_DIAGNOSED');
  await runRecoveryChild(input,'quarantine',[process.execPath,here,'--worker','quarantine','--input',request]);
  report.checks.push(check(phase,'Doctor exit 1 and actual installed runtime startup refused before verification.'));
  phase='unreachable-authority';report.artifacts.assignmentRemote=expected.remote;
  await withOfflineAuthority(expected.remote,async()=>{
   await runRecoveryChild(input,'offline-verify',[process.execPath,cli,'restore-verify','--state-dir',restored,'--authoritative-recovery-point'],{allowed:[1]});
   equal(JSON.parse(await readFile(join(stateDir,'offline-verify.stderr'),'utf8')).code,'ASSIGNMENT_UNCONFIRMED','UNREACHABLE');
   await readFile(join(restored,'restore-quarantine.json'));
  });
  report.checks.push(check(phase,'Fresh local assignment fetch failed with ASSIGNMENT_UNCONFIRMED and quarantine remained.'));
  phase='authoritative-verification';await runRecoveryChild(input,'verify',[process.execPath,cli,'restore-verify','--state-dir',restored,'--authoritative-recovery-point']);
  await refuses(()=>readFile(join(restored,'restore-quarantine.json')),'ENOENT');
  report.checks.push(check(phase,'Fresh remote grant confirmation succeeded; no original work occurred after stopped snapshot.'));
  phase='fresh-process-exact-reopen';await runRecoveryChild(input,'reopen',[process.execPath,here,'--worker','reopen','--input',request]);
  report.checks.push(...await json(join(stateDir,'reopen-checks.json')));
  equal((await installedIdentity(input.packageDir)).treeSha256,identity.treeSha256,'INSTALLED_TREE_CHANGED');
  report.checks.push(check('candidate-unchanged','Installed bytes/dependency tree unchanged across recovery; changed trees require fresh evidence.'));
 }catch(e){report.checks.push({name:phase,state:'fail',details:`${e.code??'RECOVERY_FAILED'}${e.unresolved?`; unresolved PID ${e.pid??'unknown'}`:''}${e.persistenceError?`; timeout evidence write failed: ${e.persistenceError.code}`:''}${e.fenceError?`; execution fence write failed: ${e.fenceError.code}`:''}; retained evidence; do not execute another identity or clear locks/quarantine.`});}
 await save(report.artifacts.report,report);return report;
}

async function application(packageDir){
 const module=path=>import(pathToFileURL(join(packageDir,'dist',path+'.js')).href);
 const paths={cli:'cli',authority:'projects/authority-domain',identity:'repositories/identity',configured:'projects/configured-ownership',repositories:'repositories/service',sharing:'projects/sharing',instance:'instance/open',vault:'vault/write',runtime:'runtime/pi-host',ownership:'projects/ownership',workloads:'projects/workload-grants',workspaces:'workspaces/manager',processes:'workspaces/processes',git:'git/client',source:'skills/import/source',manage:'skills/manage',reader:'skills/import/reader',auth:'auth/sessions',api:'api/app',schedules:'schedules/service',binding:'projects/bindings',attention:'attention/service',revision:'attention/revision',admission:'runtime/admission'};
 const m=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await module(path)])));
 m.models=await loadInstalledModule(packageDir,'@earendil-works/pi-ai/models');m.faux=await loadInstalledModule(packageDir,'@earendil-works/pi-ai/providers/faux');return m;
}
const retainedKinds=['assignment-grants','workload-grants','workload-revocations','workload-admission','project-admission','runtime-project-fence','process-fence','fleet','skill-pin','skill-version','skill-load','ui-inbox-seen','api-request','inbox-result','inbox-result-version','inbox-report-request','team-task','team-decision','schedule-occurrence','setup-entry','ui-setup'];
async function records(ctx){const result={};for(const kind of retainedKinds)result[kind]=await ctx.store.list(kind);return result;}
async function runtimeFixture(m,ctx){
 const models=m.models.createModels(),provider=m.faux.fauxProvider({provider:'scripted',models:[{id:'recovery'}],tokensPerSecond:Infinity});models.setProvider(provider.provider);
 const vault=m.vault.openVault(ctx),git=new m.git.GitClient(),ownership=m.configured.openConfiguredOwnership(ctx,git);
 const workspaces=new m.workspaces.WorkspaceManager(ctx),supervisor=new m.processes.ProcessSupervisor(ctx);
 return {ctx,vault,git,ownership,workspaces,supervisor,models,provider,resume:false};
}
async function seed(input,m){
 const {stateDir}=input,vaultDir=join(stateDir,'vault'),originalState=join(stateDir,'original'),remote=join(stateDir,'assignments.git');
 await m.cli.runCli(['init','--state-dir',originalState,'--vault',vaultDir]);const ctx=await m.instance.openInstance({stateDir:originalState,vaultDir});const opts=await runtimeFixture(m,ctx);
 let runtime,schedules,api;let calls=0;
 try{
  const run=async(cwd,args)=>{const r=await opts.git.run(cwd,args);if(r.exitCode!==0)throw error('FIXTURE_GIT');return r.stdout;};
  await run(stateDir,['init','--bare','--initial-branch=main',remote]);
  for(const name of ['receive.denyNonFastForwards','receive.denyDeletes'])await run(remote,['config',name,'true']);
  await m.authority.ensureLocalAuthority(ctx,await m.identity.readVaultIdentity(vaultDir),'native-recovery-authority');await run(vaultDir,['config','user.name','Recovery fixture']);await run(vaultDir,['config','user.email','recovery@example.test']);
  await run(vaultDir,['remote','add','origin',remote]);
  await writeFile(join(vaultDir,'index.md'),'---\nokf_version: "0.2"\n---\n# Installed recovery\n');
  await run(vaultDir,['add','index.md']);await run(vaultDir,['commit','-m','Recovery vault']);await run(vaultDir,['push','origin','main']);
  const promotionRuntime=await m.runtime.openRuntime(opts);try{const repositories=m.repositories.openRepositories({state:ctx,git:opts.git}),binding=await ctx.store.read('authority-binding','current');await m.sharing.openSharing({ctx,vault:opts.vault,repositories,ownership:opts.ownership,workloads:m.configured.openConfiguredWorkloadOwnership(ctx,opts.git),proof:promotionRuntime}).enable({expectedDomain:binding.domainId,expectedEpoch:binding.epoch,target:(await repositories.inspect(vaultDir)).target,protectionAcknowledged:true},'native-recovery-promotion');}finally{await promotionRuntime.close();}
  await opts.ownership.claim({id:'recovery-project',repositoryKey:'fork:installed-recovery',title:'Recovery project'},'claim-project');
  const workloads=m.workloads.openWorkloadOwnership(ctx,opts.git,remote);
  const fenced=await workloads.claim('revoked-fixture','claim-fence');await workloads.revoke(fenced.workloadId,fenced.generation);
  await opts.vault.propose({id:'recovery-agent',path:'agents/recovery.md',expectedRevision:null,actor:'user:fixture',content:'---\n'+JSON.stringify({type:'Agent',title:'Recovery',lorecrew:{id:'recovery',name:'Recovery',personality:'Precise',responsibilities:['Verify'],groups:[],model:{provider:'scripted',modelId:'recovery'}}})+'\n---\nUse scripted replies only.\n'});
  opts.provider.setResponses([()=>{calls++;return m.faux.fauxAssistantMessage(m.faux.fauxToolCall('codemode',{code: `text(await tools.bash({command:'pwd; printf retained > recovery-command.txt'}));`}),{stopReason:'toolUse'});},()=>{calls++;return m.faux.fauxAssistantMessage('Completed installed recovery conversation');}]);
  runtime=await m.runtime.openRuntime(opts);
  const session=await runtime.createSession({requestId:'recovery-session',agentId:'recovery'});
  const management=m.manage.openSkillManagement(ctx,opts.vault);
  async function imported(version,source){const transport=scriptedSkillSource(version),resolved=await m.source.resolveSkillSource(ctx,'fixture',{url:'https://github.com/example/recovery'},transport),preview=await m.source.previewRemoteSkill(ctx,'fixture',{sourceId:resolved.sourceId,skillPath:'sample/SKILL.md'},transport);
   const fields={name:preview.name,description:preview.description,body:preview.body,target:{scope:'global'},resources:[],expectedActiveRevision:null,...source?{source}:{},nativeImport:{previewId:preview.nativeImport.previewId,manifestHash:preview.nativeImport.manifestHash,resourceMappings:[]}};
   const review=await management.review('fixture',fields);return management.save('fixture',{...fields,authoringId:randomUUID(),reviewId:review.reviewId,reviewRevision:review.reviewRevision});}
  const saved=await imported(1),root=await opts.vault.read(saved.path);
  const load={sessionId:session.id,taskId:session.id,qualifiedId:saved.qualifiedId,revision:root.revision,trial:true,requestId:'recovery-trial'};
  const loaded=await runtime.skills.loadSkill(load);
  equal(calls,0,'IMPORT_MADE_MODEL_CALL');
  const resources=[];for(const r of loaded.resources)resources.push(await m.reader.readImportedResource(ctx,{qualifiedId:saved.qualifiedId,skillRevision:loaded.revision,resourcePath:r.path}));
  const newer=await imported(2,{path:saved.path,revision:root.revision});
  const newRoot=await opts.vault.read(newer.path);if(newRoot.revision===root.revision)throw error('UPDATE_NOT_DISTINCT');
  const reportDirectory=join(stateDir,'report-project');await m.repositories.openRepositories({state:ctx,git:opts.git}).create({repo:{kind:'project',id:'recovery-project',path:reportDirectory},parentPath:stateDir,folderName:'report-project',scaffold:[{path:'README.md',content:'# Native recovery code\n'}]},'native-recovery-code');await m.binding.bindProject(ctx,{projectId:'recovery-project',path:reportDirectory});
  let schedule={id:'rome-recovery',revision:'rome-v1',ownerId:ctx.instanceId,agentId:'recovery',projectId:'recovery-project',cron:'30 2 * * *',timeZone:'Europe/Rome',instructions:'Inspect offline recovery',enabled:true,overlap:'skip',missed:'coalesce',effectiveFrom:'2026-10-29T00:00:00Z'};
  schedules=m.schedules.openSchedules({ctx,vault:opts.vault,runtime,ownership:opts.ownership,workloads});await schedules.save(schedule,null);
  const submit={sessionId:session.id,requestId:'recovery-message',text:'One admitted fixture message'};
  await runtime.submit(submit);const deadline=Date.now()+20000;
  while((await runtime.snapshot(session.id)).status==='running'&&Date.now()<deadline)await delay(20);
  const snapshot=await runtime.snapshot(session.id);equal(snapshot.status,'completed','COMPLETION');equal(calls,2,'MODEL_CALLS');equal(snapshot.messages.filter(m=>m.kind==='user').length,1,'USER_COUNT');
  const auth=m.auth.openBrowserSessions(ctx),secret=await auth.issueBootstrap(),origin='http://127.0.0.1';
  api=m.api.createApi({...opts,runtime,team:runtime.team,auth,schedules,publicOrigin:origin});
  const request=(path,init)=>api.request(origin+'/api/v1'+path,init);
  equal((await request('/inbox/seen')).status,401,'UNAUTHENTICATED_INBOX');
  const login=await request('/auth/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({secret})});equal(login.status,200,'LOGIN');
  const browser=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  const marker={id:'session:'+session.id,revision:sha(JSON.stringify(snapshot.messages))};
  const init={method:'PUT',headers:{cookie,origin,'content-type':'application/json','x-csrf-token':browser.csrfToken,'idempotency-key':'recovery-inbox-seen'},body:JSON.stringify(marker)};
  equal((await request('/inbox/seen',init)).status,200,'INBOX_PUT');
  // Report versions come from a real scheduled project root on a fixed external
  // Git binding with its original worktree paths retained. Restore never relocates execution.
  const reportInput={kind:'report',title:'Installed recovery report',body:'Original installed report',sourcePaths:['index.md'],expectedRevision:null};
  let releaseNext;const nextAllowed=new Promise(resolve=>releaseNext=resolve);
  opts.provider.setResponses([
   ()=>{calls++;return m.faux.fauxAssistantMessage(m.faux.fauxToolCall('codemode',{code:'text(await tools.report_result('+JSON.stringify(reportInput)+'));'}),{stopReason:'toolUse'});},
   async()=>{await nextAllowed;calls++;const current=(await ctx.store.list('inbox-result'))[0];return m.faux.fauxAssistantMessage(m.faux.fauxToolCall('codemode',{code:'text(await tools.report_result('+JSON.stringify({...reportInput,kind:'finding',body:'Newer unread finding',expectedRevision:current.revision})+'));'}),{stopReason:'toolUse'});},
   ()=>{calls++;return m.faux.fauxAssistantMessage(m.faux.fauxToolCall('codemode',{code:'text(await tools.team_report({state:"completed",outcome:{summary:"Scheduled recovery report completed"}}));'}),{stopReason:'toolUse'});},
   ()=>{calls++;return m.faux.fauxAssistantMessage('Reported');}
  ]);
  await schedules.tick('2026-10-29T01:30:00Z');const occurrence=(await ctx.store.list('schedule-occurrence'))[0];if(!occurrence?.sessionId)throw error('MISSING_REPORT_PRODUCER');const producer=(await ctx.store.read('runtime-session',occurrence.sessionId)).session;
  let reportR1;const firstDeadline=Date.now()+20000;while(!(reportR1=(await ctx.store.list('inbox-result'))[0])){if(Date.now()>firstDeadline)throw error('FIRST_REPORT_DEADLINE');await delay(20);}
  const reportMarker={id:reportR1.id,revision:reportR1.revision};equal((await request('/inbox/seen',{...init,headers:{...init.headers,'idempotency-key':'recovery-report-read'},body:JSON.stringify(reportMarker)})).status,200,'REPORT_READ');releaseNext();
  const reportDeadline=Date.now()+20000;for(;;){const task=await runtime.team.getTask(occurrence.taskId);if(task.state==='completed'&&!(await runtime.attentionState(producer.id)).pendingWork)break;if(Date.now()>reportDeadline)throw error('REPORT_DEADLINE');await delay(20);}
  const reportR2=(await ctx.store.list('inbox-result'))[0];if(reportR2.revision===reportR1.revision)throw error('REPORT_REVISION_NOT_CHANGED');
  await schedules.disable(schedule.id,schedule.revision);schedule=(await schedules.list())[0];
  const baseTask=(id,state)=>({id,projectId:'recovery-project',generation:1,leadSessionId:'recovery-fixture-lead',executingSessionId:'fixture-session-'+id,dependsOn:[],objective:id,deliverable:'Recovery evidence',contextPaths:[],workspaceId:'',agentId:'recovery',state});
  opts.provider.setResponses([()=>{calls++;return m.faux.fauxAssistantMessage(m.faux.fauxToolCall('codemode',{code:'text(await tools.team_report({state:"completed",outcome:{summary:"Earlier actual installed root result"}}));'}),{stopReason:'toolUse'});},()=>{calls++;return m.faux.fauxAssistantMessage('Earlier root completed');}]);const earlier=await runtime.team.createTask({requestId:'recovery-earlier-root',projectId:'recovery-project',leadAgentId:'recovery',objective:'Earlier actual installed root'});for(const end=Date.now()+20000;;){if((await runtime.team.getTask(earlier.id)).state==='completed'&&!(await runtime.attentionState(earlier.executingSessionId)).pendingWork)break;if(Date.now()>end)throw error('EARLIER_ROOT_DEADLINE');await delay(20);}const legacy=await runtime.team.getTask(earlier.id),legacyMarker={id:'task:'+legacy.id,revision:m.revision.taskRevision(legacy)};equal((await request('/inbox/results/'+encodeURIComponent(legacyMarker.id)+'?revision='+legacyMarker.revision,{headers:{cookie}})).status,200,'ACTUAL_EARLIER_RESULT');equal((await request('/inbox/seen',{...init,headers:{...init.headers,'idempotency-key':'earlier-root-read'},body:JSON.stringify(legacyMarker)})).status,200,'ACTUAL_EARLIER_READ');
  // Pending unsupported legacy control records are history preconditions, never seeded successful execution.
  await ctx.store.transact(tx=>{tx.put('team-task','recovery-waiting',baseTask('recovery-waiting','waiting_decision'));tx.put('team-decision','recovery-question',{id:'recovery-question',taskId:'recovery-waiting',question:'Choose a recovery path',recommendation:'Keep the original',blockedTaskIds:['recovery-waiting'],state:'pending'});tx.put('team-task','recovery-blocker',{...baseTask('recovery-blocker','blocked'),blockedReason:'Operator repair required'});});
  const inbox=m.attention.openInbox({ctx,vault:opts.vault,runtime}),inboxBefore=await inbox.list();
  equal(inboxBefore.items.map(i=>i.id).sort(),['decision:recovery-question','task:recovery-blocker',reportR2.id].sort(),'OUTSTANDING_ATTENTION');
  equal(await inbox.result(reportR1.id,reportR1.revision),{id:reportR1.id,revision:reportR1.revision,source:reportR1.source,title:reportR1.title,content:reportR1.content,sourcePaths:reportR1.sourcePaths},'OLD_EXACT_BODY');
  const proof=await runtime.stopAndProve('recovery-project');if(!proof.quiescent)throw error('NOT_QUIESCENT');
  const before=await records(ctx);equal(before['api-request'].length,3,'RECEIPT_COUNT');for(const receipt of before['api-request'])equal(receipt.response,{ok:true},'RECEIPT_RESULT');equal(before['ui-inbox-seen'].length,3,'MARKERS');equal(before['inbox-result-version'].length,2,'REPORT_VERSIONS');equal(before['inbox-report-request'].length,2,'REPORT_RECEIPTS');
  // Exercise durable replay with exactly the same authenticated route/key.
  equal((await request('/inbox/seen',init)).status,200,'INBOX_REPLAY');equal(await records(ctx),before,'RECEIPT_REPLAY');
  equal(before['assignment-grants'].length,1,'PROJECT_GRANTS');equal(before['workload-grants'].length,2,'WORKLOAD_GRANTS');equal(before['workload-revocations'].length,1,'PERMANENT_FENCE');
  const expected={instanceId:ctx.instanceId,originalState,vaultDir,remote,session,submit,snapshot,modelCalls:calls,load,loaded,root,resources,newer:newRoot,schedule,records:before,fenced,attention:{producer,reportInput,reportR1,reportR2,legacyMarker,inboxBefore}};

  m.api.closeApi(api);api=undefined;await schedules.close();schedules=undefined;
  await runtime.close();runtime=undefined;
  const processes=await ctx.store.list('host-process');equal(processes.length,1,'ONE_ORDINARY_COMMAND');equal(processes[0].settled,true,'SETTLED_ORDINARY_COMMAND');const context=await ctx.store.read('execution-context',processes[0].contextId);equal(context.cwd,input.home,'ORDINARY_HOME');equal(context.state,'stopped','STOPPED_ORDINARY_CONTEXT');expected.execution={processes,context,fence:await ctx.store.read('execution-context-fence',context.id)};await save(join(stateDir,'expected.json'),expected);
  await run(vaultDir,['add','.']);await run(vaultDir,['commit','-m','Stopped recovery fixture']);
 }finally{if(api)m.api.closeApi(api);await schedules?.close();await runtime?.close();await ctx.close();}
}
async function inspect(input,m,phase){
 const expected=await json(join(input.stateDir,'expected.json'));
 const ctx=await m.instance.openInstance({stateDir:join(input.stateDir,'restored'),vaultDir:expected.vaultDir});let runtime;
 try{
  const opts=await runtimeFixture(m,ctx);
  if(phase==='quarantine'){await refuses(()=>m.runtime.openRuntime(opts),'RESTORE_QUARANTINED');return;}
  equal((await ctx.store.read('restore-verification',ctx.instanceId)).grants,expected.records['assignment-grants'].length+expected.records['workload-grants'].length,'VERIFIED_GRANTS');
  equal(ctx.instanceId,expected.instanceId,'INSTANCE');equal(await records(ctx),expected.records,'CONTROL_RECORDS');
  equal(await ctx.store.list('host-process'),expected.execution.processes,'RESTORED_PROCESSES');equal(await ctx.store.read('execution-context',expected.execution.context.id),expected.execution.context,'RESTORED_CONTEXT');equal(await ctx.store.read('execution-context-fence',expected.execution.context.id),expected.execution.fence,'RESTORED_CONTEXT_FENCE');
  let calls=0;opts.provider.setResponses([()=>{calls++;throw error('UNEXPECTED_MODEL_CALL');}]);
  runtime=await m.runtime.openRuntime(opts);
  equal(await runtime.snapshot(expected.session.id),expected.snapshot,'SESSION_SNAPSHOT');
  const inbox=m.attention.openInbox({ctx,vault:opts.vault,runtime});equal(await inbox.list(),expected.attention.inboxBefore,'RESTORED_ATTENTION');for(const report of [expected.attention.reportR1,expected.attention.reportR2])equal(await inbox.result(report.id,report.revision),{id:report.id,revision:report.revision,source:report.source,title:report.title,content:report.content,sourcePaths:report.sourcePaths},'EXACT_REPORT_VERSION');
  equal(await runtime.skills.loadSkill(expected.load),expected.loaded,'LOADED_PIN');
  const old=await m.reader.exactImportedSnapshot(ctx,expected.load.qualifiedId,expected.loaded.revision);equal(old.concept,expected.root,'EXACT_ROOT');
  for(const resource of expected.resources)equal(await m.reader.readImportedResource(ctx,{qualifiedId:expected.load.qualifiedId,skillRevision:expected.loaded.revision,resourcePath:resource.path}),resource,'HISTORICAL_RESOURCE');
  equal(await opts.vault.read(expected.newer.path),expected.newer,'NEWER_ROOT_PRESENT');
  equal((await opts.vault.list()).filter(c=>c.metadata.type==='Schedule').map(c=>c.metadata.schedule),[expected.schedule],'ROME_ROUTINE');
  const workloads=m.workloads.openWorkloadOwnership(ctx,opts.git,expected.remote);
  for(const {assignment:g} of expected.records['assignment-grants'])await opts.ownership.assertOwner(g.projectId,g.generation);
  for(const {assignment:g} of expected.records['workload-grants'])if(g.workloadId!==expected.fenced.workloadId)await workloads.assertOwner(g.workloadId,g.generation);
  await refuses(()=>workloads.assertOwner(expected.fenced.workloadId,expected.fenced.generation),'OWNER_REVOKED');
  await runtime.submit(expected.submit);await delay(100);
  equal(calls,0,'REOPEN_MODEL_CALLS');equal(await runtime.snapshot(expected.session.id),expected.snapshot,'REPLAY_SNAPSHOT');equal(await records(ctx),expected.records,'REPLAY_RECORDS');
  await runtime.close();runtime=undefined;
  equal(await records(ctx),expected.records,'CLOSED_RECORDS');equal(await ctx.store.list('host-process'),expected.execution.processes,'NO_DUPLICATE_COMMAND');equal((await ctx.store.read('runtime-session',expected.session.id)).cwd,expected.execution.context.cwd,'REOPEN_CWD');equal(await ctx.store.read('execution-context',expected.execution.context.id),expected.execution.context,'OLD_EPOCH_UNCHANGED');equal(await ctx.store.read('execution-context-fence',expected.execution.context.id),expected.execution.fence,'OLD_FENCE_UNCHANGED');
  await save(join(input.stateDir,'reopen-checks.json'),[
   check('fresh-process-exact-reopen','Fresh installed Node process retained exact instance/session IDs, full grants/generations, candidate trial snapshot, root, original resource text/hash/revision, Rome routine and authenticated Inbox intent/result.'),
   check('idempotent-admission','Reused original request ID; exact messages/usage unchanged; zero fresh model calls.'),
   check('ordinary-command-context','Exact settled command, saved HOME, old execution epoch and permanent fence survive; no duplicate command.'),
   check('exact-attention-recovery','Unread R2 finding, exact R1/R2 bodies, R1 read marker, legacy task read and unresolved canonical question/blocker survive; no duplicate report/model/command.'),
   check('permanent-fence','Revoked workload still rejects OWNER_REVOKED; no fence or receipt removed.')]);
 }finally{await runtime?.close();await ctx.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===here){
 const {values}=parseArgs({options:{worker:{type:'string'},input:{type:'string'},'package-dir':{type:'string'},'state-dir':{type:'string'},'artifact-sha256':{type:'string'}}});
 if(values.worker){const input=await json(values.input);try{const m=await application(input.packageDir);await (values.worker==='seed'?seed(input,m):inspect(input,m,values.worker));}catch(e){await save(join(input.stateDir,values.worker+'-failure.json'),{code:e.code??'WORKER_FAILED',message:e.message,stack:e.stack});process.exitCode=1;}}
 else{const report=await runInstalledRecovery({packageDir:values['package-dir']??'',stateDir:values['state-dir']??'',artifactSha256:values['artifact-sha256']??''});console.log(JSON.stringify(report,null,2));process.exitCode=report.checks.some(c=>c.state==='fail')?1:0;}
}
