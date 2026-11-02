#!/usr/bin/env node
import {openConfiguredOwnership} from './projects/configured-ownership.js';
import { startApp } from './app.js';
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { basename,dirname,join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { INITIAL_VAULT_INDEX, inspectVaultStart } from './vault/start.js';
import { backupOffline, restoreOffline } from './instance/backup.js';
import { diagnose, prerequisiteDiagnostics, type Diagnostic } from './instance/diagnostics.js';
import { verifyRestoredInstance } from './instance/recovery.js';
import { AppError, type Json } from './contracts/base.js';
import { readConfig } from './instance/config.js';
import { openInstance } from './instance/open.js';
import { openVault } from './vault/write.js';
import { GitClient } from './git/client.js';
import { ASSIGNMENT_BRANCH } from './git/refs.js';
import { initFleet } from './projects/ownership.js';
import { bindProject } from './projects/bindings.js';
import { setTimeout as delay } from 'node:timers/promises';
import { openRuntime } from './runtime/pi-host.js';
import { WorkspaceManager } from './workspaces/manager.js';
import { ProcessSupervisor } from './workspaces/processes.js';
export async function runCli(args: string[]): Promise<{ [key: string]: Json }> {
  if(args.some(arg=>arg==='--mode'||arg.startsWith('--mode=')))throw new AppError('USAGE','Obsolete session capability --mode is not supported');
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { inspect:{type:'boolean'},input:{type:'string'},json:{type:'boolean'}, destination:{type:'string'}, archive:{type:'string'}, platform:{type:'string'}, 'original-instance-fenced':{type:'boolean'}, 'authoritative-recovery-point':{type:'boolean'}, 'state-dir': { type: 'string' }, vault: { type: 'string' }, remote: { type: 'string' }, id: { type: 'string' }, repository: { type: 'string' }, title: { type: 'string' }, 'request-id': { type: 'string' }, generation: { type: 'string' }, 'target-instance': { type: 'string' }, path: { type: 'string' }, agent: {type:'string'}, project: {type:'string'}, text: {type:'string'}, host:{type:'string'}, port:{type:'string'}, 'public-origin':{type:'string'}, name:{type:'string'} } });
  const command = positionals[0];
  const stateDir = resolve(values['state-dir'] ?? join(homedir(), '.local', 'state', 'lorecrew'));
  if(command==='service'&&positionals.length===2&&positionals[1]==='print'){
    if(values.platform!=='systemd'&&values.platform!=='launchd')throw new AppError('USAGE','service print requires --platform systemd|launchd');
    const file=values.platform==='systemd'?'lorecrew.service':'lorecrew.plist';
    return {platform:values.platform,template:await readFile(new URL(`../packaging/${file}`,import.meta.url),'utf8')};
  }
  if(command==='doctor'&&positionals.length===1){
    let diagnostics:Diagnostic[]=prerequisiteDiagnostics();
    const metadata=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
    let info:{[key:string]:Json}={stateDir,node:process.versions.node,version:metadata.version,platform:process.platform,arch:process.arch};
    try{
      const config=await readConfig(stateDir);
      if(!config)diagnostics.push({code:'INSTANCE_UNINITIALIZED',severity:'error',message:'Instance has not been initialized.',remediation:'Run lorecrew serve, pair locally and select a vault, or use init --vault PATH with separate local directories.'});
      else if(Number(process.versions.node.split('.')[0])===24){
        const ctx=await openInstance({stateDir,vaultDir:config.vaultDir});
        try{diagnostics=await diagnose(ctx);info={...info,instanceId:ctx.instanceId,vaultDir:ctx.vaultDir,...ctx.store.durability()};}finally{await ctx.close();}
      }
    }catch(error){diagnostics.push({code:error instanceof AppError?error.code:'INSTANCE_UNAVAILABLE',severity:'error',message:error instanceof Error?error.message:'Instance cannot be inspected.',remediation:'Stop the running service for offline doctor; resolve paths, permissions, restore quarantine or schema compatibility without deleting lock/ownership evidence.'});}
    return {...info,ok:!diagnostics.some(d=>d.severity==='error'),diagnostics:diagnostics.map(d=>({...d}))};
  }
  if(command==='repository'&&positionals.length===2&&positionals[1]==='migrate'){
    const config=await readConfig(stateDir);if(!config)throw new AppError('INSTANCE_UNINITIALIZED','Select a vault before inspecting repository migration');
    const ctx=await openInstance({stateDir,vaultDir:config.vaultDir});try{
      const {openRepositories}=await import('./repositories/service.js');const {openRepositoryMigration}=await import('./repositories/migration.js');const {readStoppedExecutionProof}=await import('./runtime/stopped-proof.js');
      const migration=openRepositoryMigration({ctx,repositories:openRepositories({state:ctx,git:new GitClient()}),proof:()=>readStoppedExecutionProof(ctx)});
      if(values.inspect===true&&!values.input)return JSON.parse(JSON.stringify(await migration.inspect())) as {[key:string]:Json};
      if(!values.input||!values['request-id'])throw new AppError('USAGE','repository migrate requires --inspect or a reviewed --input FILE and stable --request-id');
      const input:unknown=JSON.parse(await readFile(values.input,'utf8'));if(!input||typeof input!=='object'||!('expectedInventory' in input)||typeof input.expectedInventory!=='string'||!('selections' in input)||!Array.isArray(input.selections)||Object.keys(input).some(k=>!['expectedInventory','selections'].includes(k)))throw new AppError('USAGE','Migration input must contain expectedInventory and explicit selections');
      const prepared=await migration.prepare(input as Parameters<typeof migration.prepare>[0],values['request-id']);const baselines=await migration.createBaselines(prepared.id);await migration.finish({migrationId:prepared.id,baselines},values['request-id']+':finish');return {migrationId:prepared.id,state:'completed',baselines:JSON.parse(JSON.stringify(baselines)) as Json};
    }finally{await ctx.close();}
  }
  if(positionals.length===2&&(command==='repository'&&['status','clone','checkpoint','publish','confirm-remote'].includes(positionals[1]!)||command==='sharing'&&['enable','join','status'].includes(positionals[1]!)||command==='project'&&['handoff','handoff-status','preflight','accept'].includes(positionals[1]!))){
    const config=await readConfig(stateDir);if(!config)throw new AppError('INSTANCE_UNINITIALIZED','Select a vault first');const ctx=await openInstance({stateDir,vaultDir:config.vaultDir});try{const {repositoryCli}=await import('./repositories/cli.js');return await repositoryCli(ctx,command!,positionals[1]!,values);}finally{await ctx.close();}
  }
  if((command==='backup'||command==='restore')&&positionals.length===1){
    if(Number(process.versions.node.split('.')[0])!==24)throw new AppError('UNSUPPORTED_NODE','Lorecrew requires Node.js 24 LTS');
    if(command==='backup'){if(!values.destination)throw new AppError('USAGE','backup requires --destination DIRECTORY');return {...await backupOffline({stateDir,destination:values.destination})};}
    if(!values.archive)throw new AppError('USAGE','restore requires --archive DIRECTORY and --original-instance-fenced');
    await restoreOffline({archivePath:values.archive,stateDir,originalInstanceFenced:values['original-instance-fenced']===true});return {restored:true,stateDir,quarantined:true};
  }
  const sessionAction=positionals.length===2 && command==='session' && ['create','submit','status','cancel','models'].includes(positionals[1]!);
  const fleetInit = positionals.length === 2 && command === 'fleet' && positionals[1] === 'init';
  const projectClaim = positionals.length === 2 && command === 'project' && positionals[1] === 'claim';
  const projectAction = positionals.length === 2 && command === 'project' && positionals[1]==='bind';
  if (!(positionals.length === 1 && (command === 'init' || command === 'restore-verify' || command === 'serve')) && !fleetInit && !projectClaim && !projectAction && !sessionAction) throw new AppError('USAGE','Usage: lorecrew serve [--state-dir PATH] | init --vault PATH | doctor --json | repository status|clone|checkpoint|publish|confirm-remote|migrate | sharing enable|join|status | project handoff|handoff-status|preflight|accept|bind|claim | session create|submit|status|cancel|models | backup --destination DIRECTORY | restore --archive DIRECTORY --original-instance-fenced | restore-verify --authoritative-recovery-point | service print --platform systemd|launchd. Repository, sharing and transfer actions use reviewed --input FILE --request-id STABLE_ID. Repository migrate also supports --inspect. Use --state-dir PATH for a separate instance.');
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new AppError('UNSUPPORTED_NODE', 'Lorecrew requires Node.js 24 LTS');
  if (spawnSync('git', ['--version']).status !== 0) throw new AppError('GIT_REQUIRED', 'Lorecrew requires Git on PATH');
  const vaultDir = values.vault ?? (command !== 'init' ? (await readConfig(stateDir))?.vaultDir : undefined);
  if(command==='serve') {
    if(values.port!==undefined && !/^[0-9]+$/.test(values.port))throw new AppError('USAGE','Port must be a nonnegative integer');
    const app=await startApp({stateDir,...(vaultDir?{vaultDir}:{}),...values.host?{host:values.host}:{},...values.port!==undefined?{port:Number(values.port)}:{},...values['public-origin']?{publicOrigin:values['public-origin']}:{},...values.name?{name:values.name}:{}});
    console.error(`Lorecrew serving ${app.url}`);
    await new Promise<void>(resolve=>{const stop=()=>{process.off('SIGINT',stop);process.off('SIGTERM',stop);resolve();};process.once('SIGINT',stop);process.once('SIGTERM',stop);});
    await app.close();return {url:app.url,closed:true};
  }
  if(!vaultDir)throw new AppError('USAGE','Initialize with --vault PATH or run serve and select a vault in the paired browser');
  if(command==='init'){
    const {openState}=await import('./instance/state.js');const {openVaultInitialization}=await import('./setup/vault.js');const {lstat}=await import('node:fs/promises');const state=await openState({stateDir});try{const initialization=openVaultInitialization(state),path=resolve(vaultDir);let existing=false;try{await lstat(path);existing=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const choice=existing?{kind:'existing' as const,path}:{kind:'new' as const,parentPath:dirname(path),folderName:basename(path)};const current=await initialization.view();if(current.phase==='ready'&&current.vaultDir===path)return {instanceId:state.instanceId,stateDir,vaultDir:path};const preview=await initialization.preview(choice);const result=await initialization.confirm({choice,previewToken:preview.token,expectedRevision:preview.revision},values['request-id']??'cli-init:'+path);return {instanceId:state.instanceId,stateDir,vaultDir:result.vaultDir!};}finally{await state.close();}
  }
  const ctx = await openInstance({ stateDir, vaultDir });
  try {
    const info = { instanceId: ctx.instanceId, stateDir: ctx.stateDir, vaultDir: ctx.vaultDir };
    if(command==='restore-verify'){await verifyRestoredInstance(ctx,{authoritativeRecoveryPoint:values['authoritative-recovery-point']===true});return {...info,verified:true};}
    if(sessionAction) {
      const configured=await ctx.store.read<{remote:string}>('fleet','assignments');
      const ownership=openConfiguredOwnership(ctx,new GitClient(),values.remote??configured?.remote??'origin');
      const runtime=await openRuntime({ctx,vault:openVault(ctx),ownership,workspaces:new WorkspaceManager(ctx),supervisor:new ProcessSupervisor(ctx),resume:positionals[1]==='submit'});
      try {
        if(positionals[1]==='models')return {models:(await runtime.listModels()).map(m=>({...m}))};
        if(positionals[1]==='create') {
          if(!values.agent || !values['request-id'])throw new AppError('USAGE','session create requires --agent and --request-id; optional --project');
          return {...await runtime.createSession({agentId:values.agent,requestId:values['request-id'],...(values.project?{projectId:values.project}:{})})};
        }
        if(!values.id)throw new AppError('USAGE','session command requires --id');
        if(positionals[1]==='cancel')await runtime.cancel(values.id);
        let submissionId:string|undefined;
        if(positionals[1]==='submit') {
          if(!values['request-id'] || !values.text)throw new AppError('USAGE','session submit requires --id, --request-id and --text');
          ({submissionId}=await runtime.submit({sessionId:values.id,requestId:values['request-id'],text:values.text}));
          while((await runtime.snapshot(values.id)).status==='running')await delay(50);
        }
        return JSON.parse(JSON.stringify({...await runtime.snapshot(values.id),...(submissionId?{submissionId}:{})})) as {[key:string]:Json};
      } finally {await runtime.close();}
    }
    if (projectAction && positionals[1] === 'bind') {
      if (!values.id || !values.path) throw new AppError('USAGE', 'project bind requires --id and --path');
      await bindProject(ctx, { projectId: values.id, path: values.path }); return { projectId: values.id, bound: true };
    }
    if (fleetInit || projectClaim) {
      const configured = await ctx.store.read<{ remote: string }>('fleet', 'assignments');
      const remote = values.remote ?? configured?.remote;
      if (!remote) throw new AppError('USAGE', 'Specify the designated assignment remote with --remote NAME_OR_URL');
      const git = new GitClient();
      const {assertAuthorityDomain}=await import('./projects/authority-domain.js');await assertAuthorityDomain(ctx);
      if (fleetInit) { await initFleet(ctx, git, remote); return { ...info, assignmentBranch: ASSIGNMENT_BRANCH }; }
      const ownership = openConfiguredOwnership(ctx, git, remote);
      if (!values.id || !values.repository || !values.title || !values['request-id']) throw new AppError('USAGE', 'project claim requires --id, --repository, --title, and a stable --request-id');
      return { ...await ownership.claim({ id: values.id, repositoryKey: values.repository, title: values.title }, values['request-id']) };
    }
    const vault = openVault(ctx);

    const diagnostics = await diagnose(ctx);
    return {...info, ok:!diagnostics.some(d => d.severity === 'error'), diagnostics:diagnostics.map(d => ({...d})), node:process.versions.node, ...ctx.store.durability()};
  } finally { await ctx.close(); }
}
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  runCli(process.argv.slice(2)).then(result => { console.log(typeof result.template==='string'?result.template:JSON.stringify(result, null, 2)); if(process.argv[2]==='doctor'&&result.ok===false)process.exitCode=1; }, error => {
    console.error(JSON.stringify({ code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error), ...(error instanceof AppError ? { details: error.details } : {}) }));
    process.exitCode = 1;
  });
}
