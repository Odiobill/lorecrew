import { afterEach, expect, it } from 'vitest';
import {createHash} from 'node:crypto';
import { access, cp, mkdir, readFile, readdir, realpath, writeFile, symlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { temporaryInstance } from '../helpers/temp.js';
import { openInstance } from '../../src/instance/open.js';
import { runCli } from '../../src/cli.js';
import { openRuntime } from '../../src/runtime/pi-host.js';
import { openVault } from '../../src/vault/write.js';
import { openOwnership } from '../../src/projects/ownership.js';
import { GitClient } from '../../src/git/client.js';
import { WorkspaceManager } from '../../src/workspaces/manager.js';
import { ProcessSupervisor } from '../../src/workspaces/processes.js';
import { scriptedProvider } from '../helpers/scripted-provider.js';
import { openStore } from '../../src/storage/store.js';
import { runInstaller } from '../helpers/installer.js';
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close();});
async function fixture(){const f=await temporaryInstance();cleanups.push(f.cleanup);await cp('tests/fixtures/vault',f.paths.vaultDir,{recursive:true});return f;}
const backups=()=>import('../../src/instance/backup.js');
it('ships synchronized private preview metadata and the pinned consumer shrinkwrap',async()=>{
 const p=JSON.parse(await readFile('package.json','utf8')),lock=JSON.parse(await readFile('package-lock.json','utf8'));
 expect(p).toMatchObject({name:'lorecrew',version:'0.1.0-preview.3',private:true,engines:{node:'>=24 <25',npm:'>=11 <12'}});
 const shrink=JSON.parse(await readFile('npm-shrinkwrap.json','utf8'));
 expect(await readFile('npm-shrinkwrap.json','utf8')).toBe(await readFile('package-lock.json','utf8'));
 // Canonical non-root lock entries retain the frozen dependency graph without Git history.
 function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])]));
  return value;
 }
 const graph=canonical(Object.fromEntries(Object.entries(lock.packages).filter(([key])=>key)));
 expect(createHash('sha256').update(JSON.stringify(graph)).digest('hex')).toBe('ca4027e6748751e5294e438bc08e5763b97fca748b95763f5c6975d78a38b060');
 expect(shrink).toEqual(lock);for(const file of [lock,shrink]){expect(file.version).toBe(p.version);expect(file.packages['']).toMatchObject({name:p.name,version:p.version,dependencies:p.dependencies});}
 expect(p.files).toContain('packaging/**');
});
it('exports offline backup and restore operations',async()=>{await expect(backups()).resolves.toMatchObject({backupOffline:expect.any(Function),restoreOffline:expect.any(Function)});});
it('refuses backup and restore while the same instance lock is live',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);cleanups.push(()=>ctx.close());const api=await backups();
 await expect(api.backupOffline({stateDir:f.paths.stateDir,destination:join(f.root,'backup')})).rejects.toMatchObject({code:'INSTANCE_BUSY'});
 await expect(api.restoreOffline({archivePath:join(f.root,'backup'),stateDir:f.paths.stateDir,originalInstanceFenced:true})).rejects.toMatchObject({code:'INSTANCE_BUSY'});
});
it('preserves real Pi session identity, control pins and artifacts across a fenced offline restore with Unicode paths',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths),models=scriptedProvider().models,vault=openVault(ctx),agent=await vault.read('agents/ada.md');
 await vault.propose({id:'backup-agent-config',path:agent.path,expectedRevision:agent.revision,actor:'fixture',content:{metadata:{lorecrew:{...agent.metadata.lorecrew as object,model:{provider:'scripted',modelId:'test-model',thinkingLevel:'medium'}}}}});
 const runtime=await openRuntime({ctx,vault,ownership:openOwnership(ctx,new GitClient(),'origin'),workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),models,resume:false});
 const session=await runtime.createSession({requestId:'backup-session',agentId:'agent-ada'});
 await ctx.store.transact(tx=>tx.put('skill-pin','backup-pin',{revision:'retained-revision'}));
 await writeFile(join(ctx.stateDir,'artifacts','manifest.json'),'artifact manifest');
 await writeFile(join(ctx.stateDir,'providers.json'),'[{"module":"openai","credentialEnv":"LORECREW_TEST_MISSING_KEY"}]');
 await runtime.close();await ctx.close();
 const api=await backups(),destination=join(f.root,'backup spazio è'),target=join(f.root,'restored spazio è');
 const {manifestPath}=await api.backupOffline({stateDir:ctx.stateDir,destination});expect(manifestPath).toBe(join(destination,'manifest.json'));
 await expect(api.restoreOffline({archivePath:destination,stateDir:target,originalInstanceFenced:false})).rejects.toMatchObject({code:'FENCING_REQUIRED'});
 await api.restoreOffline({archivePath:destination,stateDir:target,originalInstanceFenced:true});
 const db=new DatabaseSync(join(target,'control.sqlite'),{readOnly:true});
 expect(JSON.parse(String(db.prepare("SELECT value FROM records WHERE kind='runtime-session' AND id=?").get(session.id)?.value)).session.id).toBe(session.id);
 expect(JSON.parse(String(db.prepare("SELECT value FROM records WHERE kind='skill-pin' AND id='backup-pin'").get()?.value))).toEqual({revision:'retained-revision'});db.close();
 expect(await readFile(join(target,'pi.sqlite'))).toEqual(await readFile(join(destination,'files','pi.sqlite')));
 expect(await readFile(join(target,'artifacts','manifest.json'),'utf8')).toBe('artifact manifest');
 expect(JSON.parse(await readFile(join(target,'config.json'),'utf8')).instanceId).toBe(ctx.instanceId);
 expect(await readdir(destination)).not.toContain('instance.lock');
 const restored=await openInstance({stateDir:target,vaultDir:ctx.vaultDir});cleanups.push(()=>restored.close());
 const {verifyRestoredInstance}=await import('../../src/instance/recovery.js');await verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true});
 const reopened=await openRuntime({ctx:restored,vault:openVault(restored),ownership:openOwnership(restored,new GitClient(),'origin'),workspaces:new WorkspaceManager(restored),supervisor:new ProcessSupervisor(restored),models,resume:false});
 try{expect((await reopened.snapshot(session.id)).session.id).toBe(session.id);}finally{await reopened.close();}
});
it('refuses unresolved child processes, recursive destinations and escaping symlinks',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);await ctx.store.transact(tx=>tx.put('host-process','uncertain',{state:'exited',settled:false}));await ctx.close();const api=await backups();
 await expect(api.backupOffline({stateDir:ctx.stateDir,destination:join(f.root,'unsafe')})).rejects.toMatchObject({code:'NOT_QUIESCENT'});
 const repair=await openInstance(f.paths);await repair.store.transact(tx=>tx.delete('host-process','uncertain'));await repair.close();
 await expect(api.backupOffline({stateDir:ctx.stateDir,destination:join(ctx.stateDir,'recursive')})).rejects.toMatchObject({code:'INVALID_BACKUP_PATH'});
 await symlink(f.paths.vaultDir,join(ctx.stateDir,'outside'));
 await expect(api.backupOffline({stateDir:ctx.stateDir,destination:join(f.root,'links')})).rejects.toMatchObject({code:'UNSAFE_BACKUP_ENTRY'});
});
it('rejects tampered archives and nonempty restore destinations without overwriting data',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);await ctx.close();const api=await backups(),archivePath=join(f.root,'backup');await api.backupOffline({stateDir:ctx.stateDir,destination:archivePath});
 const target=join(f.root,'target');await mkdir(target);await writeFile(join(target,'precious'),'keep');
 await expect(api.restoreOffline({archivePath,stateDir:target,originalInstanceFenced:true})).rejects.toMatchObject({code:'RESTORE_NOT_EMPTY'});
 expect(await readFile(join(target,'precious'),'utf8')).toBe('keep');
 await writeFile(join(archivePath,'files','config.json'),'{}');
 await expect(api.restoreOffline({archivePath,stateDir:join(f.root,'tampered'),originalInstanceFenced:true})).rejects.toMatchObject({code:'INVALID_BACKUP'});
});
it('backs up a populated legacy control schema before migration and rejects future schemas unchanged',async()=>{
 const f=await fixture(),path=join(f.root,'legacy.sqlite'),db=new DatabaseSync(path);db.exec("CREATE TABLE legacy (value TEXT); INSERT INTO legacy VALUES ('saved');");db.close();
 const store=openStore(path,{now:()=>0});await store.close();const files=await readdir(f.root),backup=files.find(name=>name.startsWith('legacy.sqlite.pre-migration-'));
 expect(backup).toBeDefined();const snapshot=new DatabaseSync(join(f.root,backup!),{readOnly:true});expect(snapshot.prepare('PRAGMA user_version').get()?.user_version).toBe(0);expect(snapshot.prepare('SELECT value FROM legacy').get()?.value).toBe('saved');snapshot.close();
 const future=new DatabaseSync(path);future.exec('PRAGMA user_version=999');future.close();expect(()=>openStore(path,{now:()=>0})).toThrow(expect.objectContaining({code:'SCHEMA_TOO_NEW'}));
 const unchanged=new DatabaseSync(path,{readOnly:true});expect(unchanged.prepare('PRAGMA user_version').get()?.user_version).toBe(999);unchanged.close();
});
it('doctor JSON reports prerequisites before initialization and never creates an instance',async()=>{
 const f=await fixture();const result=await runCli(['doctor','--json','--state-dir',f.paths.stateDir]);expect(result.node).toMatch(/^24\./);expect(result.ok).toBe(false);expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({code:'INSTANCE_UNINITIALIZED',remediation:expect.any(String)})]));
 await expect(readFile(join(f.paths.stateDir,'config.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('diagnoses missing Git, provider credentials, workspaces and reports platform limitations',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);cleanups.push(()=>ctx.close());await ctx.store.transact(tx=>tx.put('project-binding','project',{projectId:'project',path:join(f.root,'missing')}));
 await writeFile(join(ctx.stateDir,'providers.json'),'[{"module":"openai","credentialEnv":"LORECREW_TEST_MISSING_KEY"}]');
 const original=process.env.PATH;process.env.PATH=join(f.root,'no-binaries');
 try {const {diagnose}=await import('../../src/instance/diagnostics.js'),results=await diagnose(ctx);expect(results).toEqual(expect.arrayContaining(['GIT_REQUIRED','PROVIDER_UNAVAILABLE','WORKSPACE_MISSING','PROCESS_SUPERVISION'].map(code=>expect.objectContaining({code,remediation:expect.any(String)}))));}finally{process.env.PATH=original;}
});
it('prints optional service templates and rejects unknown platforms without initialization',async()=>{
 for(const platform of ['systemd','launchd']){const result=await runCli(['service','print','--platform',platform]);expect(result.platform).toBe(platform);expect(result.template).toEqual(expect.any(String));}
 await expect(runCli(['service','print','--platform','windows'])).rejects.toMatchObject({code:'USAGE'});
});
it('quarantines all execution entry points until explicit recovery-point acknowledgment, retaining session IDs',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);await ctx.close();const api=await backups(),archivePath=join(f.root,'backup'),stateDir=join(f.root,'restore');await api.backupOffline({stateDir:ctx.stateDir,destination:archivePath});await api.restoreOffline({archivePath,stateDir,originalInstanceFenced:true});
 const restored=await openInstance({stateDir,vaultDir:ctx.vaultDir});cleanups.push(()=>restored.close());
 const manager=new WorkspaceManager(restored),supervisor=new ProcessSupervisor(restored);
 await expect(manager.acquire({projectId:'none',taskId:'test'})).rejects.toMatchObject({code:'RESTORE_QUARANTINED'});
 await expect(supervisor.run({contextId:'none',command:'true',requestId:'run'})).rejects.toMatchObject({code:'RESTORE_QUARANTINED'});
 const options={ctx:restored,vault:openVault(restored),ownership:openOwnership(restored,new GitClient(),'origin'),workspaces:manager,supervisor,models:scriptedProvider().models,resume:false};
 await expect(openRuntime(options)).rejects.toMatchObject({code:'RESTORE_QUARANTINED'});
 const {verifyRestoredInstance}=await import('../../src/instance/recovery.js');
 await expect(verifyRestoredInstance(restored,{authoritativeRecoveryPoint:false})).rejects.toMatchObject({code:'RECOVERY_ACK_REQUIRED'});
 await verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true});
 const runtime=await openRuntime(options);await runtime.close();
 expect(await restored.store.read('restore-verification',ctx.instanceId)).toMatchObject({authoritativeRecoveryPoint:true});
});
it.each(['project','workload'])('keeps an old pre-transfer %s snapshot quarantined after original-device fencing',async(kind)=>{
 const {gitFleet}=await import('../helpers/git-fleet.js'),{initFleet}=await import('../../src/projects/ownership.js'),{handoffProject}=await import('../../src/projects/handoff.js'),{openWorkloadOwnership}=await import('../../src/projects/workload-grants.js');
 const f=await gitFleet();cleanups.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,f.remote);
 const owner=openOwnership(f.a.ctx,f.a.git,f.remote);await owner.claim({id:'project',repositoryKey:'fork:recovery',title:'Recovery'},'claim');
 await openWorkloadOwnership(f.a.ctx,f.a.git,f.remote).claim('workload','claim');
 const original=f.a.ctx;await original.close();const api=await backups(),archivePath=join(f.root,'backup');await api.backupOffline({stateDir:original.stateDir,destination:archivePath});
 const live=await openInstance({stateDir:original.stateDir,vaultDir:original.vaultDir});
 if(kind==='project')await handoffProject({ownership:openOwnership(live,f.a.git,f.remote),projectId:'project',expectedGeneration:1,targetInstanceId:f.b.ctx.instanceId,requestId:'transfer',probe:{async stopAndProve(){return {quiescent:true};}}});
 else await openWorkloadOwnership(live,f.a.git,f.remote).transfer({workloadId:'workload',expectedGeneration:1,targetInstanceId:f.b.ctx.instanceId,transitionId:'transfer',probe:{async stopAndProve(){return {quiescent:true};}}});await live.close();
 const stateDir=join(f.root,'restored');await api.restoreOffline({archivePath,stateDir,originalInstanceFenced:true});const restored=await openInstance({stateDir,vaultDir:original.vaultDir});cleanups.push(()=>restored.close());
 const {verifyRestoredInstance,assertRestoredExecutionAllowed}=await import('../../src/instance/recovery.js');
 await expect(verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true})).rejects.toMatchObject({code:'RESTORE_OWNERSHIP_MISMATCH'});
 await expect(assertRestoredExecutionAllowed(restored)).rejects.toMatchObject({code:'RESTORE_QUARANTINED'});
});
it('requires online control confirmation and retains permanent local fences on successful restore verification',async()=>{
 const {gitFleet}=await import('../helpers/git-fleet.js'),{initFleet}=await import('../../src/projects/ownership.js'),{openWorkloadOwnership}=await import('../../src/projects/workload-grants.js');
 const f=await gitFleet();cleanups.push(f.cleanup);await initFleet(f.a.ctx,f.a.git,f.remote);const authority=openWorkloadOwnership(f.a.ctx,f.a.git,f.remote);await authority.claim('workload','claim');await authority.revoke('workload',1);
 await f.a.ctx.close();const api=await backups(),archivePath=join(f.root,'backup'),stateDir=join(f.root,'restored');await api.backupOffline({stateDir:f.a.ctx.stateDir,destination:archivePath});await api.restoreOffline({archivePath,stateDir,originalInstanceFenced:true});const restored=await openInstance({stateDir,vaultDir:f.a.ctx.vaultDir});cleanups.push(()=>restored.close());
 const {verifyRestoredInstance,assertRestoredExecutionAllowed}=await import('../../src/instance/recovery.js');await rename(f.remote,f.remote+'.offline');
 await expect(verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true})).rejects.toMatchObject({code:'ASSIGNMENT_UNCONFIRMED'});await expect(assertRestoredExecutionAllowed(restored)).rejects.toMatchObject({code:'RESTORE_QUARANTINED'});
 await rename(f.remote+'.offline',f.remote);await verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true});await expect(openWorkloadOwnership(restored,f.a.git,f.remote).assertOwner('workload',1)).rejects.toMatchObject({code:'OWNER_REVOKED'});
});
// Host-only: packing/installing dependencies is explicitly enabled by the release controller or CI.
it.runIf(Boolean(process.env.LORECREW_PACKED_ARTIFACT))('installs the actual packed artifact through the standalone installer and runs its compiled command',async()=>{
 // A failing real install keeps its exact diagnostics/cache outcome for investigation.
 const f=await temporaryInstance(),destination=join(f.root,'installed spazio è'),bin=join(f.root,'commands spazio è');
 const expected=JSON.parse(await readFile('package.json','utf8'));
 const artifact=resolve(process.env.LORECREW_PACKED_ARTIFACT!),npm=process.env.npm_execpath;
 expect(npm,'Run this test through npm so the host npm executable is known').toBeTruthy();
 const home=join(f.root,'private-home');await mkdir(home);
 const tools=join(f.root,'tools');await mkdir(tools);
 for(const [name,candidates] of [['node',[process.execPath]],['npm',[npm!]],['git',process.env.PATH!.split(':').map(p=>join(p,'git'))]] as const){let found=false;for(const candidate of candidates)try{await access(candidate);await symlink(await realpath(candidate),join(tools,name));found=true;break;}catch{}expect(found,name+' prerequisite').toBe(true);}
 const userConfig=join(home,'npm-user.conf'),globalConfig=join(home,'npm-global.conf');
 await writeFile(userConfig,'',{mode:0o600});await writeFile(globalConfig,'',{mode:0o600});
 // Allowlist, rather than copy, the parent environment: no registry/provider auth.
 expect(process.env.LORECREW_NPM_CACHE,'An explicitly copied disposable cache is required').toBeTruthy();
 const env={PATH:tools,HOME:home,LORECREW_AUTH_FILE:join(home,'auth.json'),PI_CODING_AGENT_DIR:join(home,'pi'),
   npm_config_userconfig:userConfig,npm_config_globalconfig:globalConfig,npm_config_cache:process.env.LORECREW_NPM_CACHE!,
   npm_config_offline:'true',npm_config_ignore_scripts:'true',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0'};
 const installed=await runInstaller(['--tarball',artifact,'--offline','--cache',process.env.LORECREW_NPM_CACHE!,'--prefix',destination,'--bin-dir',bin,...process.env.LORECREW_ARTIFACT_SHA256?['--sha256',process.env.LORECREW_ARTIFACT_SHA256]:[]],{home,path:tools,cwd:f.root});
 expect(installed.code,JSON.stringify({...installed,retainedEvidence:f.root})).toBe(0);
 const shim=await readFile(join(bin,'lorecrew'),'utf8'),installManifest=JSON.parse(await readFile(JSON.parse(shim.split('\n')[2]!.slice(12)),'utf8'));
 const packageRoot=installManifest.packageDir as string;
 const {installedIdentity}=await import('../../scripts/installed-recovery-smoke.mjs');const identity=await installedIdentity(packageRoot);expect(identity.treeSha256).toBe(installManifest.treeSha256);
 expect(identity.packages.some(p=>['tsx','vitest','typescript'].includes(p.name))).toBe(false);
 expect(JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'))).toMatchObject({version:expected.version,private:true});
 const shrink=JSON.parse(await readFile(join(packageRoot,'npm-shrinkwrap.json'),'utf8'));expect(shrink).toEqual(JSON.parse(await readFile('npm-shrinkwrap.json','utf8')));
 const production=Object.entries(shrink.packages as Record<string,{dev?:boolean;version?:string}>).filter(([path,m])=>path&&!m.dev).map(([path,m])=>({name:path.split('node_modules/').at(-1)!,version:m.version!}));
 const graph=spawnSync(process.execPath,[npm!,'ls','--prefix',join(packageRoot,'../..'),'--all','--json'],{env,encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});expect(graph.status,graph.stderr).toBe(0);
 const actual=new Set<string>();function visit(name:string,node:{version?:string;dependencies?:Record<string,any>}){if(node.version)actual.add(name+'@'+node.version);for(const [n,child] of Object.entries(node.dependencies??{}))visit(n,child);}visit('',JSON.parse(graph.stdout));actual.delete('@'+expected.version);actual.delete('lorecrew@'+expected.version);
 const pinned=new Set(production.map(p=>p.name+'@'+p.version));expect([...actual].sort()).toEqual([...pinned].sort());
 expect(await readFile(join(packageRoot,'packaging/install.sh'),'utf8')).toBe(await readFile('packaging/install.sh','utf8'));
 const web=join(packageRoot,'dist','web');
 expect(await readFile(join(web,'index.html'),'utf8')).toContain('<div id="root">');
 const manifest=JSON.parse(await readFile(join(web,'manifest.webmanifest'),'utf8'));
 expect(manifest).toMatchObject({id:'/',start_url:'/',scope:'/',display:'standalone',name:'Lorecrew Local Team'});
 for(const [file,size,purpose] of [['icon-192.png',192,'any'],['icon-512.png',512,'any'],['icon-maskable-512.png',512,'maskable']] as const){
   expect(manifest.icons).toContainEqual(expect.objectContaining({src:`/${file}`,sizes:`${size}x${size}`,type:'image/png',purpose}));
   const png=await readFile(join(web,file));expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
   expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([size,size]);
 }
 expect(await readFile(join(web,'sw.js'),'utf8')).toContain('addEventListener');
 expect(await readFile(join(packageRoot,'packaging','Caddyfile.example'),'utf8')).toContain('reverse_proxy');
 await expect(readFile(join(packageRoot,'src','cli.ts'))).rejects.toMatchObject({code:'ENOENT'});
 const run=(args:string[])=>spawnSync(join(bin,'lorecrew'),args,{cwd:destination,env,encoding:'utf8',timeout:20_000});
 const init=run(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);expect(init.error).toBeUndefined();expect(init.stderr).toBe('');expect(init.status).toBe(0);await cp('tests/fixtures/vault',f.paths.vaultDir,{recursive:true});
 const doctor=run(['doctor','--json','--state-dir',f.paths.stateDir]);expect(doctor.status).toBe(0);expect(JSON.parse(doctor.stdout)).toMatchObject({node:expect.stringMatching(/^24\./),version:expected.version,ok:true});
 const service=run(['service','print','--platform','systemd']);expect(service.status).toBe(0);expect(service.stdout).toContain('[Service]');
 // Exercise normal compiled startup, not a source helper with synchronization disabled.
 const emptyVault=join(f.root,'fresh installed vault'),emptyState=join(f.root,'fresh installed state');
 await writeFile(env.LORECREW_AUTH_FILE,'{}',{mode:0o600});let cookie='',csrf='',pairedId='',freshId='';
 for(let i=0;i<2;i++){
  const child=spawn(join(bin,'lorecrew'),['serve','--state-dir',emptyState,'--port','0'],{cwd:destination,env,stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const exited=new Promise<number|null>(r=>child.on('close',r));
  try{
   await expect.poll(()=>stderr.match(/Lorecrew serving (http:\/\/\S+)/)?.[1],{timeout:15_000}).toBeTruthy();const url=stderr.match(/Lorecrew serving (http:\/\/\S+)/)![1]!;
   if(!cookie){const secret=stderr.match(/Lorecrew login secret .*: ([A-Za-z0-9_-]+)/)![1];const login=await fetch(url+'/api/v1/auth/login',{method:'POST',headers:{origin:url,'content-type':'application/json'},body:JSON.stringify({secret})});expect(login.status).toBe(200);cookie=login.headers.get('set-cookie')!.split(';')[0]!;const credentials=await login.json() as {id:string;csrfToken:string};csrf=credentials.csrfToken;pairedId=credentials.id;}
   const headers={cookie,origin:url,'x-csrf-token':csrf,'content-type':'application/json'};const startup=await(await fetch(url+'/api/v1/startup',{headers:{cookie}})).json() as any;
   if(i===0){expect(startup.phase).toBe('vault_required');freshId=startup.instanceId;const choice={kind:'new',parentPath:f.root,folderName:'fresh installed vault'};const preview=await(await fetch(url+'/api/v1/startup/vault-preview',{method:'POST',headers,body:JSON.stringify({choice})})).json() as any;const confirm=await fetch(url+'/api/v1/startup/vault',{method:'POST',headers:{...headers,'idempotency-key':'installed-vault'},body:JSON.stringify({choice,previewToken:preview.token,expectedRevision:preview.revision})});expect(confirm.status).toBe(200);}
   else expect(startup).toMatchObject({phase:'ready',instanceId:freshId});
   expect(await(await fetch(url+'/api/v1/auth/session',{headers:{cookie}})).json()).toMatchObject({id:pairedId,csrfToken:csrf});expect(await(await fetch(url+'/api/v1/setup',{headers:{cookie}})).json()).toMatchObject({needsSetup:true,state:null,readiness:{model:'missing_model'}});expect((await fetch(url+'/')).status).toBe(200);
  }finally{if(child.exitCode===null)child.kill('SIGTERM');const code=await exited;expect(code,stderr.replace(/(login secret .*: )\S+/g,'$1[redacted]')).toBe(0);}
 }
 expect((await readdir(emptyVault)).sort()).toEqual(['.git','.lorecrew','index.md']);expect(JSON.parse(await readFile(join(emptyVault,'.lorecrew/vault.json'),'utf8'))).toMatchObject({version:1});const firstRunDoctor=run(['doctor','--json','--state-dir',emptyState]);expect(firstRunDoctor.status,firstRunDoctor.stderr).toBe(0);expect(JSON.parse(firstRunDoctor.stdout)).toMatchObject({instanceId:freshId,ok:true});
 cleanups.push(f.cleanup);
},180_000);
it('rejects backup of an interrupted restore even if its control database is readable',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);await ctx.close();await writeFile(join(ctx.stateDir,'restore-incomplete.json'),'{}');
 const {backupOffline}=await backups();await expect(backupOffline({stateDir:ctx.stateDir,destination:join(f.root,'partial')})).rejects.toMatchObject({code:'RESTORE_INCOMPLETE'});
});
it('keeps relocated active workspace paths quarantined and doctor reports unsupported schemas',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths),path=join(ctx.stateDir,'workspaces','active');await mkdir(path);await ctx.store.transact(tx=>tx.put('workspace','active',{path,state:'active'}));await ctx.close();
 const api=await backups(),archivePath=join(f.root,'backup'),stateDir=join(f.root,'restored');await api.backupOffline({stateDir:ctx.stateDir,destination:archivePath});await api.restoreOffline({archivePath,stateDir,originalInstanceFenced:true});
 const restored=await openInstance({stateDir,vaultDir:ctx.vaultDir});const {verifyRestoredInstance}=await import('../../src/instance/recovery.js');await expect(verifyRestoredInstance(restored,{authoritativeRecoveryPoint:true})).rejects.toMatchObject({code:'RESTORE_PATH_MISMATCH'});await restored.close();
 const db=new DatabaseSync(join(stateDir,'control.sqlite'));db.exec('PRAGMA user_version=999');db.close();
 expect(await runCli(['doctor','--json','--state-dir',stateDir])).toMatchObject({ok:false,diagnostics:expect.arrayContaining([expect.objectContaining({code:'SCHEMA_TOO_NEW'})])});
});
it('runs the backup, fenced restore and explicit verification CLI without bypassing quarantine',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);await runCli(['init','--state-dir',f.paths.stateDir,'--vault',f.paths.vaultDir]);
 const archive=join(f.root,'cli backup'),state=join(f.root,'cli restore');
 expect(await runCli(['backup','--state-dir',f.paths.stateDir,'--destination',archive])).toMatchObject({manifestPath:join(archive,'manifest.json')});
 await expect(runCli(['restore','--state-dir',state,'--archive',archive])).rejects.toMatchObject({code:'FENCING_REQUIRED'});
 expect(await runCli(['restore','--state-dir',state,'--archive',archive,'--original-instance-fenced'])).toMatchObject({quarantined:true});
 expect(await runCli(['doctor','--json','--state-dir',state])).toMatchObject({ok:false,diagnostics:expect.arrayContaining([expect.objectContaining({code:'RESTORE_QUARANTINED'})])});
 await expect(runCli(['restore-verify','--state-dir',state])).rejects.toMatchObject({code:'RECOVERY_ACK_REQUIRED'});
 expect(await runCli(['restore-verify','--state-dir',state,'--authoritative-recovery-point'])).toMatchObject({verified:true});
});
it('rejects manifest traversal before copying outside the restore destination',async()=>{
 const f=await fixture(),ctx=await openInstance(f.paths);await ctx.close();const api=await backups(),archivePath=join(f.root,'backup');await api.backupOffline({stateDir:ctx.stateDir,destination:archivePath});
 const manifestPath=join(archivePath,'manifest.json'),manifest=JSON.parse(await readFile(manifestPath,'utf8'));manifest.entries[0].path='../escape';await writeFile(manifestPath,JSON.stringify(manifest));
 await expect(api.restoreOffline({archivePath,stateDir:join(f.root,'restored'),originalInstanceFenced:true})).rejects.toMatchObject({code:'INVALID_BACKUP'});
 await expect(readFile(join(f.root,'escape'))).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['vault','vault-symlink','git-worktree','git-worktree-symlink'])('rejects a restore inside %s before copying any operational state',async(kind)=>{
 const f=await fixture(),ctx=await openInstance(f.paths);await ctx.close();
 const api=await backups(),archivePath=join(f.root,'backup');await api.backupOffline({stateDir:ctx.stateDir,destination:archivePath});
 let parent=f.paths.vaultDir;
 if(kind.startsWith('git-worktree')){
  parent=join(f.root,'project');await mkdir(parent);
  const git=spawnSync('git',['init','--quiet',parent],{encoding:'utf8'});expect(git.status,git.stderr).toBe(0);
 }
 const realTarget=join(parent,'nested','restore');await mkdir(realTarget,{recursive:true});
 if(kind.endsWith('symlink')){const alias=join(f.root,'alias');await symlink(parent,alias);parent=alias;}
 await expect(api.restoreOffline({archivePath,stateDir:join(parent,'nested','restore'),originalInstanceFenced:true})).rejects.toMatchObject({code:'INVALID_STATE_DIR'});
 expect(await readdir(realTarget)).toEqual([]);
});

it('initializes the default state directory under an isolated HOME and honors an explicit override',async()=>{
 const f=await temporaryInstance();cleanups.push(f.cleanup);const isolatedHome=join(f.root,'isolated-home');await mkdir(isolatedHome);const env={PATH:process.env.PATH!,HOME:isolatedHome,LORECREW_AUTH_FILE:join(f.root,'test-auth.json')};
 const invoke=async(args:string[])=>{const {spawn}=await import('node:child_process');return new Promise<{status:number|null;stdout:string;stderr:string}>((resolve,reject)=>{const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',"import {runCli} from './src/cli.ts';console.log(JSON.stringify(await runCli(process.argv.slice(2))));","package.json",...args],{cwd:process.cwd(),env});let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);child.on('error',reject);child.on('close',status=>resolve({status,stdout,stderr}));});};
 const first=await invoke(['init','--vault',f.paths.vaultDir,'--json']);expect(first.status,first.stderr).toBe(0);expect(first).toMatchObject({stdout:expect.stringContaining('stateDir')});expect(JSON.parse(first.stdout).stateDir).toBe(join(isolatedHome,'.local','state','lorecrew'));expect(JSON.parse(await readFile(join(isolatedHome,'.local','state','lorecrew','config.json'),'utf8')).vaultDir).toBe(f.paths.vaultDir);
 const otherVault=join(f.root,'other-vault');await mkdir(otherVault);const override=join(f.root,'explicit-state');const second=await invoke(['init','--state-dir',override,'--vault',otherVault,'--json']);expect(second.status,second.stderr).toBe(0);expect(JSON.parse(second.stdout).stateDir).toBe(override);expect(await readdir(override)).toContain('config.json');
});
