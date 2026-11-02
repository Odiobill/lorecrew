import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { makeInstallerArchive } from './installer-archive.mjs';

export const installerPath = resolve('packaging/install.sh');
const runningInstallers = new Map<string, Set<ReturnType<typeof startInstaller>>>();
export function runInstaller(args: string[], options: {home: string; path: string; cwd: string; env?: Record<string, string>}, script = installerPath) {
  return startInstaller(args, options, script).result;
}
export function startInstaller(args: string[], options: {home: string; path: string; cwd: string; env?: Record<string, string>}, script = installerPath) {
  const child = spawn('/bin/sh', [script, ...args], { cwd: options.cwd, env: { HOME: options.home, PATH: options.path, ...options.env } });
  const result = new Promise<{code: number; stdout: string; stderr: string}>((done, reject) => {
    let stdout = '', stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', reject); child.once('close', code => done({code: code ?? 1, stdout, stderr}));
  });
  const running = {child, result};
  let set = runningInstallers.get(options.home); if (!set) runningInstallers.set(options.home, set = new Set()); set.add(running);
  void result.then(() => set!.delete(running), () => set!.delete(running));
  return running;
}

/** Only npm's external package/source behavior is scripted; the shell, FS and Node are real. */
export async function installerFixture(mode = 'success') {
  const root = await mkdtemp(join(tmpdir(), 'lorecrew-installer-')), home = join(root, 'home'), path = join(root, 'tools');
  await mkdir(home); await mkdir(path);
  await symlink(process.execPath, join(path, 'node'));
  // A prerequisite, never a transport. Reject every non-version invocation.
  await writeFile(join(path, 'git'), '#!/bin/sh\n[ "$1" = --version ] || exit 91\nprintf "git version fixture\\n"\n', {mode: 0o755});
  const recordPath = join(root, 'npm-calls.jsonl'), control = join(root, 'control.json');
  await writeFile(control, JSON.stringify({mode}));
  const script = `#!${process.execPath}
const fs = require('node:fs'), p = require('node:path');
const log = ${JSON.stringify(recordPath)}, control = ${JSON.stringify(control)};
const args = process.argv.slice(2), opts = JSON.parse(fs.readFileSync(control));
const {makeInstallerArchive} = require(${JSON.stringify(resolve('tests/helpers/installer-archive.mjs'))});
fs.appendFileSync(log, JSON.stringify({args,env:process.env,cwd:process.cwd(),lock:args[0]==='ci'?JSON.parse(fs.readFileSync('package-lock.json')):undefined,configs:['npm_config_userconfig','npm_config_globalconfig'].map(k=>process.env[k]?fs.readFileSync(process.env[k],'utf8'):null)})+'\\n');
if(args[0] === '--version'){console.log(opts.mode==='npm12'?'12.2.1':'11.6.2');process.exit(0);}
if(args[0] === 'ls'){const prefix=args[args.indexOf('--prefix')+1],m=JSON.parse(fs.readFileSync(p.join(prefix,'node_modules/lorecrew/package.json')));console.log(JSON.stringify({name:'installer-root',dependencies:{lorecrew:{version:m.version,dependencies:{'@earendil-works/pi-durable':{version:['graph-drift','lock-tamper'].includes(opts.mode)?'1.4.1':'1.4.0'},'@earendil-works/pi-ai':{version:'1.4.0'},...opts.mode==='optional-absent'?{'optional-tool':{}}:{}}}}}));process.exit(0);}
if(args[0] === 'pack'){const requested=args.find(a=>a.startsWith('lorecrew@')),version=requested==='lorecrew@latest'?'0.1.0-preview.1':requested.slice('lorecrew@'.length);fs.writeFileSync('source.tgz',makeInstallerArchive(version,opts.mode).bytes);console.log(JSON.stringify([{filename:'source.tgz'}]));process.exit(0);}
if(args[0] !== 'ci')process.exit(92);
if(opts.mode === 'npm-failure'){console.error('ENOTCACHED exact fixture cache miss');process.exit(1);}
if(opts.mode === 'pause'){fs.writeFileSync(p.join(p.dirname(control),'paused'),String(process.pid));while(!fs.existsSync(p.join(p.dirname(control),'release'))&&fs.existsSync(control))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);if(!fs.existsSync(control))process.exit(99);}
fs.writeFileSync(p.join(p.dirname(control),'consumed-archive'),fs.readFileSync('artifact.tgz'));
const prefix = args[args.indexOf('--prefix')+1], modules = p.join(prefix,'node_modules'), pkg = p.join(modules,'lorecrew');
const version=JSON.parse(fs.readFileSync('package-lock.json')).packages['node_modules/lorecrew'].version;
fs.mkdirSync(p.join(pkg,'dist','web'),{recursive:true});
fs.writeFileSync(p.join(pkg,'package.json'),JSON.stringify(makeInstallerArchive(version,opts.mode).metadata));
if(opts.mode!=='missing-shrinkwrap')fs.writeFileSync(p.join(pkg,'npm-shrinkwrap.json'),JSON.stringify(makeInstallerArchive(version,opts.mode).shrinkwrap));
if(opts.mode==='lock-tamper'){const file=p.join(pkg,'npm-shrinkwrap.json'),lock=JSON.parse(fs.readFileSync(file));lock.packages['node_modules/@earendil-works/pi-durable'].version='1.4.1';fs.writeFileSync(file,JSON.stringify(lock));}
fs.writeFileSync(p.join(pkg,'dist','cli.js'), 'export const fixture=true; if(process.argv[2])console.log(JSON.stringify({args:process.argv.slice(2),home:process.env.HOME,auth:process.env.LORECREW_AUTH_FILE,nodeOptions:process.env.NODE_OPTIONS}));\\n');
fs.mkdirSync(p.join(pkg,'dist','runtime'),{recursive:true});fs.writeFileSync(p.join(pkg,'dist','runtime','pi-host.js'),'export const fixture=true;');
fs.writeFileSync(p.join(pkg,'dist','web','index.html'),'<div id="root"></div>');
fs.writeFileSync(p.join(pkg,'dist','web','manifest.webmanifest'),'{}');fs.writeFileSync(p.join(pkg,'dist','web','sw.js'),'// fixture');
for(const name of ['pi-durable','pi-ai']){const dir=p.join(modules,'@earendil-works',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'package.json'),JSON.stringify({name:'@earendil-works/'+name,version:'1.4.0',type:'module',exports:{'.':'./index.js','./models':'./index.js'}}));fs.writeFileSync(p.join(dir,'index.js'),'export const fixture=true;');}
if(opts.mode==='escape'){fs.rmSync(p.join(modules,'@earendil-works','pi-durable'),{recursive:true});fs.symlinkSync(${JSON.stringify(resolve('node_modules/@earendil-works/pi-durable'))},p.join(modules,'@earendil-works','pi-durable'));}
if(opts.mode==='activation-collision')fs.mkdirSync(p.join(${JSON.stringify(home)},'.local','bin','lorecrew'),{recursive:true});
if(opts.mode==='substitute-bin'){fs.renameSync(opts.bin,opts.bin+'.saved');fs.symlinkSync(opts.target,opts.bin);}
if(opts.mode==='substitute-command')fs.writeFileSync(opts.command,'external late command');
`;
  await writeFile(join(path, 'npm'), script, {mode: 0o755}); await chmod(join(path, 'npm'), 0o755);
  const archiveBytes = makeInstallerArchive(undefined,mode).bytes;
  const archive = join(root, '-local archive è;$(touch NEVER).tgz'); await writeFile(archive, archiveBytes);
  const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
  return { root, home, path, cwd: root, archive, archiveBytes, sha256, recordPath, control,
    async calls() { try { return (await readFile(recordPath, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x) as {args:string[];env:Record<string,string>;cwd:string;configs:string[];lock?:any}); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; } },
    async cleanup() { await writeFile(join(root,'release'),'cleanup'); await Promise.allSettled([...(runningInstallers.get(home) ?? [])].map(r=>r.result)); runningInstallers.delete(home); await rm(root, {recursive:true,force:true}); } };
}
