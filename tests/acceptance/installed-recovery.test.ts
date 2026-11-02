import {afterEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const roots:string[]=[];
async function root(){const p=await mkdtemp(join(tmpdir(),'lorecrew-recovery-contract-'));roots.push(p);return p;}
afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
const harness=()=>import('../../scripts/installed-recovery-smoke.mjs');
it('installed_recovery_requires_real_package_and_empty_evidence_root',async()=>{
 const {runInstalledRecovery}=await harness();const r=await root(),stateDir=join(r,'evidence');
 await mkdir(stateDir);await writeFile(join(stateDir,'precious'),'retain');
 await expect(runInstalledRecovery({stateDir,packageDir:'/missing',artifactSha256:'a'.repeat(64)})).rejects.toMatchObject({code:'EVIDENCE_NOT_EMPTY'});
 expect(await readFile(join(stateDir,'precious'),'utf8')).toBe('retain');
 const report=await runInstalledRecovery({stateDir:join(r,'missing'),packageDir:'/missing',artifactSha256:'a'.repeat(64)});
 expect(report.checks).toContainEqual(expect.objectContaining({name:'installed-package',state:'fail'}));
});
it('installed_recovery_never_falls_back_to_source_or_live_fetch',async()=>{
 const {runInstalledRecovery,scriptedSkillSource,installedIdentity}=await harness();const r=await root();
 const report=await runInstalledRecovery({stateDir:join(r,'source'),packageDir:resolve('.'),artifactSha256:'a'.repeat(64)});
 expect(report.checks.some(c=>c.state==='fail')).toBe(true);
 const p=join(r,'install/node_modules/lorecrew');await mkdir(p,{recursive:true});await writeFile(join(p,'package.json'),JSON.stringify({name:'lorecrew',version:'0.1.0'}));
 await symlink(resolve('node_modules'),join(p,'node_modules'));
 await expect(installedIdentity(p)).rejects.toMatchObject({code:'INSTALLED_PATH_ESCAPE'});
 await expect(scriptedSkillSource().get('/repos/not-scripted/source',new AbortController().signal)).rejects.toThrow('Unscripted GitHub path');
});
it('installed_recovery_retains_failure_evidence',async()=>{
 const {runInstalledRecovery}=await harness();const r=await root(),stateDir=join(r,'failed');
 const report=await runInstalledRecovery({stateDir,packageDir:'/missing',artifactSha256:'a'.repeat(64)});
 expect(JSON.parse(await readFile(report.artifacts.report,'utf8'))).toEqual(report);
 expect(JSON.parse(await readFile(join(stateDir,'request.json'),'utf8'))).toMatchObject({artifactSha256:'a'.repeat(64)});
 await expect(runInstalledRecovery({stateDir,packageDir:'/missing',artifactSha256:'b'.repeat(64)})).rejects.toMatchObject({code:'EVIDENCE_NOT_EMPTY'});
});
it('changed installed bytes or dependency graph have a distinct evidence identity',async()=>{
 const {installedIdentity}=await harness();const r=await root(),p=join(r,'node_modules/lorecrew');await mkdir(p,{recursive:true});
 await writeFile(join(p,'package.json'),JSON.stringify({name:'lorecrew',version:'0.1.0'}));
 const a=await installedIdentity(p);await writeFile(join(p,'changed.js'),'export const changed=true;');
 const b=await installedIdentity(p);expect(b.treeSha256).not.toBe(a.treeSha256);
 const dep=join(r,'node_modules/dependency');await mkdir(dep);await writeFile(join(dep,'package.json'),'{"name":"dependency","version":"2"}');
 expect((await installedIdentity(p)).treeSha256).not.toBe(b.treeSha256);
});
it.runIf(Boolean(process.env.LORECREW_INSTALLED_PACKAGE))('installed_round_trip_preserves_native_pin_resources_and_m5_receipts',async()=>{
 const {runInstalledRecovery}=await harness();
 // Retain real round-trip evidence on success AND failure; never delete a worker's state.
 const base=process.env.LORECREW_RECOVERY_EVIDENCE??await mkdtemp(join(tmpdir(),'lorecrew-installed-roundtrip-'));
 const report=await runInstalledRecovery({stateDir:join(base,'roundtrip-'+Date.now()),packageDir:process.env.LORECREW_INSTALLED_PACKAGE!,artifactSha256:process.env.LORECREW_ARTIFACT_SHA256??''});
 expect(report.checks.filter(c=>c.state!=='pass'),JSON.stringify(report)).toEqual([]);
 expect(report.checks.map(c=>c.name)).toEqual(expect.arrayContaining(['original-stopped','same-candidate-replacement','restore-quarantine','unreachable-authority','authoritative-verification','fresh-process-exact-reopen','idempotent-admission','exact-attention-recovery','permanent-fence']));
 // Review R1: a REAL installed positive verifier has already passed its initial
 // marker checks when Git fetch stalls. Let it complete after the parent deadline.
 const {runRecoveryChild}=await harness(),evidence=join(base,'late-positive-'+Date.now());await mkdir(evidence);
 const home=join(evidence,'home'),restored=join(evidence,'restored');await mkdir(home);
 const input={stateDir:evidence,home,timeoutMs:2000},pkg=process.env.LORECREW_INSTALLED_PACKAGE!,cli=join(pkg,'dist/cli.js');
 await runRecoveryChild(input,'restore',[process.execPath,cli,'restore','--archive',report.artifacts.backup!,'--state-dir',restored,'--original-instance-fenced']);
 const started=join(evidence,'fetch-started'),finished=join(evidence,'verified-late');
 const code=`import {writeFile} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
 const {GitClient}=await import(${JSON.stringify(pathToFileURL(join(pkg,'dist/git/client.js')).href)});
 const run=GitClient.prototype.run;let slow=true;
 GitClient.prototype.run=async function(cwd,args,options){if(slow&&args.includes('fetch')){slow=false;await writeFile(${JSON.stringify(started)},'fetch started');await delay(3000);}return run.call(this,cwd,args,options);};
 const {runCli}=await import(${JSON.stringify(pathToFileURL(cli).href)});
 await runCli(['restore-verify','--state-dir',${JSON.stringify(restored)},'--authoritative-recovery-point']);await writeFile(${JSON.stringify(finished)},'verified');`;
 await expect(runRecoveryChild({...input,restoreStateDir:restored},'delayed-positive',[process.execPath,'--input-type=module','-e',code])).rejects.toMatchObject({code:'WORKER_TIMEOUT',unresolved:true});
 expect(await readFile(started,'utf8')).toBe('fetch started');
 await expect.poll(()=>readFile(finished,'utf8').catch(()=>''),{timeout:5000}).toBe('verified');
 const unresolved=JSON.parse(await readFile(join(evidence,'unresolved-child.json'),'utf8'));
 await expect.poll(()=>{try{process.kill(unresolved.pid,0);return false;}catch{return true;}}).toBe(true);
 await expect(readFile(join(restored,'restore-quarantine.json'))).rejects.toMatchObject({code:'ENOENT'});
 expect(JSON.parse(await readFile(join(restored,'restore-incomplete.json'),'utf8'))).toMatchObject({reason:'unresolved recovery worker'});
 await runRecoveryChild(input,'late-doctor',[process.execPath,cli,'doctor','--json','--state-dir',restored],{allowed:[1]});
 expect(JSON.parse(await readFile(join(evidence,'late-doctor.stdout'),'utf8')).diagnostics).toContainEqual(expect.objectContaining({code:'RESTORE_QUARANTINED'}));
},180_000);
it('a timed-out worker retains its PID and evidence without forced cleanup or success',async()=>{
 const {runRecoveryChild}=await harness(),r=await root();const home=join(r,'home');await mkdir(home);
 await expect(runRecoveryChild({stateDir:r,home,timeoutMs:20},'timeout',[process.execPath,'-e','setTimeout(()=>{},500)'])).rejects.toMatchObject({code:'WORKER_TIMEOUT'});
 const unresolved=JSON.parse(await readFile(join(r,'unresolved-child.json'),'utf8'));
 expect(unresolved).toMatchObject({label:'timeout',pid:expect.any(Number)});
 expect(()=>process.kill(unresolved.pid,0)).not.toThrow();
 // Join this owned test child naturally; evidence is retained throughout its lifetime.
 await expect.poll(()=>{try{process.kill(unresolved.pid,0);return false;}catch{return true;}}).toBe(true);
 expect(JSON.parse(await readFile(join(r,'unresolved-child.json'),'utf8'))).toEqual(unresolved);
});
it('concurrent controllers cannot share an evidence root or overwrite its identity',async()=>{
 const {runInstalledRecovery}=await harness(),r=await root(),stateDir=join(r,'race');
 await mkdir(stateDir);
 const results=await Promise.allSettled(['a','b'].map(c=>runInstalledRecovery({stateDir,packageDir:'/missing',artifactSha256:c.repeat(64)})));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
 const winningHash=['a','b'][results.findIndex(r=>r.status==='fulfilled')]!.repeat(64);
 expect(JSON.parse(await readFile(join(stateDir,'request.json'),'utf8')).artifactSha256).toBe(winningHash);
 const result=results.find(r=>r.status==='fulfilled');if(result?.status!=='fulfilled')throw Error('No retained controller');
 expect(JSON.parse(await readFile(join(stateDir,'recovery-report.json'),'utf8'))).toEqual(result.value);
});
it('an unresolved authority verifier leaves its remote offline and quarantine intact',async()=>{
 const {withOfflineAuthority}=await harness(),r=await root(),remote=join(r,'remote.git'),quarantine=join(r,'restore-quarantine.json');
 await mkdir(remote);await writeFile(join(remote,'authority'),'retain');await writeFile(quarantine,'retained quarantine');
 await expect(withOfflineAuthority(remote,async()=>{throw Object.assign(Error('unresolved child'),{code:'WORKER_TIMEOUT'});})).rejects.toMatchObject({code:'WORKER_TIMEOUT'});
 await expect(readFile(join(remote,'authority'))).rejects.toMatchObject({code:'ENOENT'});
 expect(await readFile(join(remote+'.offline','authority'),'utf8')).toBe('retain');
 expect(await readFile(quarantine,'utf8')).toBe('retained quarantine');
});
it('a late successful verifier cannot make a timed-out recovery executable',async()=>{
 const {runRecoveryChild}=await harness(),r=await root(),home=join(r,'home'),restored=join(r,'restored');await mkdir(home);await mkdir(restored);
 const quarantine=join(restored,'restore-quarantine.json'),finished=join(r,'late-finished');await writeFile(quarantine,'original quarantine');
 const code=`const fs=require('node:fs');setTimeout(()=>{fs.unlinkSync(${JSON.stringify(quarantine)});fs.writeFileSync(${JSON.stringify(finished)},'verified');},350);setTimeout(()=>{},450);`;
 await expect(runRecoveryChild({stateDir:r,home,timeoutMs:100,restoreStateDir:restored},'late-verify',[process.execPath,'-e',code])).rejects.toMatchObject({code:'WORKER_TIMEOUT'});
 await expect.poll(()=>readFile(finished,'utf8').catch(()=>'' )).toBe('verified');
 const child=JSON.parse(await readFile(join(r,'unresolved-child.json'),'utf8'));
 await expect.poll(()=>{try{process.kill(child.pid,0);return false;}catch{return true;}}).toBe(true);
 const {assertRestoredExecutionAllowed}=await import('../../src/instance/recovery.js');
 await expect(assertRestoredExecutionAllowed({stateDir:restored})).rejects.toMatchObject({code:'RESTORE_QUARANTINED'});
});
it('timeout persistence failure retains unresolved status and keeps authority offline',async()=>{
 const {runRecoveryChild,withOfflineAuthority}=await harness(),r=await root(),home=join(r,'home'),remote=join(r,'remote.git');await mkdir(home);await mkdir(remote);
 // A real filesystem error instead of a mocked journal: a directory cannot hold the JSON record.
 await mkdir(join(r,'unresolved-child.json'));await writeFile(join(r,'restore-quarantine.json'),'retained quarantine');
 const failure=await withOfflineAuthority(remote,()=>runRecoveryChild({stateDir:r,home,timeoutMs:20},'persist-fail',[process.execPath,'-e','setTimeout(()=>{},500)']).then(()=>{})).catch(e=>e);
 expect.soft(failure).toMatchObject({code:'WORKER_TIMEOUT',unresolved:true,persistenceError:{code:'EISDIR'},pid:expect.any(Number)});
 const {stat}=await import('node:fs/promises');
 expect.soft(await stat(remote).catch(e=>e.code)).toBe('ENOENT');
 expect.soft(await readFile(join(r,'restore-quarantine.json'),'utf8')).toBe('retained quarantine');
 expect.soft(await stat(remote+'.offline').then(()=>true,()=>false)).toBe(true);
 expect.soft(()=>process.kill(failure.pid,0)).not.toThrow();
 if(typeof failure.pid==='number')await expect.poll(()=>{try{process.kill(failure.pid,0);return false;}catch{return true;}}).toBe(true);
 else await new Promise(resolve=>setTimeout(resolve,700));
});

it.runIf(Boolean(process.env.LORECREW_INSTALLED_PACKAGE))('installed_full_host_tools_cancellation_Git_worktrees_and_legacy_refusal_use_plain_Node',async()=>{
 const {runRecoveryChild}=await harness();const base=process.env.LORECREW_RECOVERY_EVIDENCE??await mkdtemp(join(tmpdir(),'lorecrew-unified-installed-'));
 for(const scenario of ['tools','cancel','project','legacy','missing','permissions']){
  const stateDir=join(base,'unified-'+scenario+'-'+Date.now()),home=join(stateDir,'home');await mkdir(home,{recursive:true,mode:0o700});await writeFile(join(home,'auth.json'),'{}',{mode:0o600});
  await runRecoveryChild({stateDir,home,timeoutMs:45000},scenario,[process.execPath,resolve('tests/helpers/unified-runtime-worker.mjs'),process.env.LORECREW_INSTALLED_PACKAGE!,stateDir,scenario,'dist']);
  expect(await readFile(join(stateDir,scenario+'.stdout'),'utf8')).toContain('"proof":"'+scenario+'"');
 }
 for(const scenario of ['cancel','revoke']){
  const stateDir=join(base,'deferred-'+scenario+'-'+Date.now()),home=join(stateDir,'home');await mkdir(home,{recursive:true,mode:0o700});await writeFile(join(home,'auth.json'),'{}',{mode:0o600});
  await runRecoveryChild({stateDir,home,timeoutMs:45000},scenario,[process.execPath,resolve('tests/helpers/installed-deferred-handoff.mjs'),process.env.LORECREW_INSTALLED_PACKAGE!,stateDir,scenario]);
  expect(JSON.parse(await readFile(join(stateDir,scenario+'.stdout'),'utf8'))).toMatchObject({ok:true,scenario,deferredPolls:scenario==='cancel'?1:0,childStopped:true,oldFenceRetained:scenario==='revoke'});
 }
},180_000);
