import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installerFixture, installerPath, runInstaller, startInstaller } from '../helpers/installer.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(mode?: string) { const f = await installerFixture(mode); cleanups.push(f.cleanup); return f; }
const prefix = (f: {home:string}) => join(f.home,'.local','share','lorecrew','app');
const command = (f: {home:string}) => join(f.home,'.local','bin','lorecrew');
async function manifest(f: {home:string}) { const entries = await readdir(join(prefix(f),'installs')); expect(entries).toHaveLength(1); return JSON.parse(await readFile(join(prefix(f),'installs',entries[0]!,'install.json'),'utf8')); }

it.each([
 ['--unknown'], ['--tarball'], ['--version'], ['--prefix'], ['--sha256','xyz'], ['--sha256','a'.repeat(64)],
 ['--version','https://evil.test/a'], ['--version','git+ssh://bad'], ['--version','other@1.0.0'], ['--version','1.2'], ['--version','01.2.3'],
 ['--version','1.2.3','--tarball','file.tgz'], ['--tarball','missing.tgz'], ['--tarball','.'],
])('rejects invalid input %j before npm or app/state writes',async(...args)=>{
 const f=await fixture();const result=await runInstaller(args,f);expect(result.code).not.toBe(0);expect(result.stderr).toMatch(/usage|invalid|tarball|sha256|version|option|directory|file/i);expect(await f.calls()).toEqual([]);await expect(readdir(join(f.home,'.local','state'))).rejects.toMatchObject({code:'ENOENT'});await expect(readdir(prefix(f))).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['node','npm','git'])('refuses missing %s without downloading prerequisites',async(tool)=>{const f=await fixture();await rm(join(f.path,tool));const r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);expect(r.stderr).toContain(tool);expect((await f.calls()).some(c=>c.args[0]==='ci')).toBe(false);});
it('refuses a non-24 Node before package installation',async()=>{const f=await fixture();await rm(join(f.path,'node'));await writeFile(join(f.path,'node'),`#!${process.execPath}\nObject.defineProperty(process.versions,'node',{value:'20.0.0'});process.argv=[process.execPath,'-',...process.argv.slice(4)];eval(require('node:fs').readFileSync(0,'utf8'));\n`,{mode:0o755});const r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);expect(r.stderr).toMatch(/24/);expect(await f.calls()).toEqual([]);});
it('verifies the archive hash before npm',async()=>{const f=await fixture();const r=await runInstaller(['--tarball',f.archive,'--sha256','0'.repeat(64)],f);expect(r.code).not.toBe(0);expect(r.stderr).toMatch(/sha256/i);expect(await f.calls()).toEqual([]);});
it('rejects npm 12 before dependency installation because it cannot honor consumer shrinkwraps',async()=>{const f=await fixture('npm12');const r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);expect(r.stderr).toMatch(/npm.*11|11.*npm/i);expect((await f.calls()).some(c=>c.args[0]==='ci')).toBe(false);await expect(readFile(command(f))).rejects.toMatchObject({code:'ENOENT'});});

it.each([{extra:[]},{extra:['--offline']}])('local tarballs always install offline through the common private pipeline $extra',async({extra})=>{
 const f=await fixture(),r=await runInstaller(['--tarball',f.archive,'--sha256',f.sha256,...extra],f);expect(r.stderr).toBe('');expect(r.code).toBe(0);expect(r.stdout).toContain('0.1.0-preview.1');expect(r.stdout).toContain(command(f));expect(r.stdout).toContain('export PATH=');
 const install=(await f.calls()).find(c=>c.args[0]==='ci')!;expect(install.args).toEqual(expect.arrayContaining(['--offline','--ignore-scripts','--omit=dev','--no-audit','--no-fund']));expect(install.cwd).not.toBe(f.cwd);expect(install.lock.packages['node_modules/lorecrew/node_modules/@earendil-works/pi-ai'].version).toBe('1.4.0');
 const m=await manifest(f);expect(m).toMatchObject({schemaVersion:1,installId:expect.any(String),version:'0.1.0-preview.1',source:{kind:'tarball',path:f.archive},artifactSha256:f.sha256,nodePath:process.execPath,treeSha256:expect.stringMatching(/^[a-f0-9]{64}$/),dependencyGraphPath:expect.any(String)});expect(m.packageDir).toContain(join(prefix(f),'installs',m.installId,'node_modules','lorecrew'));expect(await readFile(m.dependencyGraphPath,'utf8')).toContain('lorecrew');
 await expect(readdir(join(f.home,'.local','state'))).rejects.toMatchObject({code:'ENOENT'});await expect(readdir(join(f.home,'.pi'))).rejects.toMatchObject({code:'ENOENT'});
 const run=spawnSync(command(f),['runtime arg'],{env:{PATH:f.path,HOME:f.home,LORECREW_AUTH_FILE:'/explicit/private/auth.json',NODE_OPTIONS:'--no-warnings'},encoding:'utf8'});expect(run.status).toBe(0);expect(JSON.parse(run.stdout)).toMatchObject({args:['runtime arg'],home:f.home,auth:'/explicit/private/auth.json',nodeOptions:'--no-warnings'});
});
it.each([ [[], 'lorecrew@latest',false], [['--version','1.2.3-beta.1+build.2'],'lorecrew@1.2.3-beta.1+build.2',false], [['--offline'],'lorecrew@latest',true] ] as const)('scripts future npm source %j without live registry access',async(args,spec,offline)=>{
 const f=await fixture();const r=await runInstaller([...args],f);expect(r.code).toBe(0);const source=(await f.calls()).find(c=>c.args[0]==='pack')!;expect(source.args).toContain(spec);expect(source.args.includes('--offline')).toBe(offline);expect(source.args).toContain('--registry=https://registry.npmjs.org');expect((await f.calls()).some(c=>c.args[0]==='ci')).toBe(true);expect((await manifest(f)).source).toEqual({kind:'npm',spec,registry:'https://registry.npmjs.org'});
});
it('scrubs injection before first Node and isolates npm from every ambient config/secret',async()=>{
 const f=await fixture(),marker=join(f.root,'PRELOAD-RAN'),preload=join(f.root,'inject.cjs');await writeFile(preload,`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unsafe');`);
 for(const p of [join(f.home,'.npmrc'),join(f.cwd,'.npmrc'),join(f.root,'hostile-global.conf')])await writeFile(p,'registry=https://never.test\n//never.test/:_authToken=FAKE-REGISTRY-SECRET\nignore-scripts=false\n');
 const r=await runInstaller(['--tarball',f.archive,'--cache',join(f.root,'cache spazio è')],{...f,env:{NODE_OPTIONS:'--require='+preload,NODE_PATH:f.cwd,NPM_TOKEN:'FAKE-REGISTRY-SECRET',npm_config_globalconfig:join(f.root,'hostile-global.conf'),npm_config_registry:'https://never.test',npm_config_ignore_scripts:'false',npm_config_prefix:f.cwd,OPENAI_API_KEY:'FAKE-PROVIDER-SECRET'}});expect(r.code).toBe(0);await expect(readFile(marker)).rejects.toMatchObject({code:'ENOENT'});expect(r.stdout+r.stderr).not.toMatch(/FAKE-|never.test/);
 for(const c of await f.calls()){expect(c.configs).toEqual(['','']);for(const key of ['NODE_OPTIONS','NODE_PATH','NPM_TOKEN','OPENAI_API_KEY'])expect(c.env[key]).toBeUndefined();expect(c.env.npm_config_registry).toBe('https://registry.npmjs.org');expect(c.env.npm_config_ignore_scripts).toBe('true');expect(c.env.npm_config_cache).toBe(join(f.root,'cache spazio è'));expect(JSON.stringify(c.env)).not.toMatch(/FAKE-|never.test/);expect(c.cwd).not.toBe(f.cwd);}
 expect(await readFile(join(f.home,'.npmrc'),'utf8')).toContain('FAKE-REGISTRY-SECRET');expect(await readFile(join(f.home,'.local','bin','lorecrew'),'utf8')).not.toMatch(/FAKE-/);
});
it('retains the exact cache failure and never retries online or enables scripts',async()=>{const f=await fixture('npm-failure'),r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);expect(r.stderr).toMatch(/diagnostic/i);expect((await f.calls()).filter(c=>c.args[0]==='ci')).toHaveLength(1);const diagnostics=join(prefix(f),'diagnostics');const files=await readdir(diagnostics);expect(files.length).toBeGreaterThan(0);expect(await readFile(join(diagnostics,files[0]!,'npm-install.log'),'utf8')).toContain('ENOTCACHED exact fixture cache miss');await expect(readFile(command(f))).rejects.toMatchObject({code:'ENOENT'});});
it.each(['tarball','npm'])('real npm config loading cannot inherit an ancestor project before the staged lock exists (%s)',async(source)=>{
 const f=await fixture(),npm=process.env.npm_execpath!;expect(npm).toBeTruthy();const external=join(f.root,'unrelated-logs'),probe=join(f.root,'config-probe.json');await mkdir(external);await writeFile(join(external,'sentinel'),'untouched');await writeFile(join(f.root,'package.json'),'{"name":"ambient-ancestor","version":"1.0.0"}');await writeFile(join(f.root,'.npmrc'),`logs-dir=${external}\n//registry.npmjs.org/:_authToken=FAKE-ANCESTOR-TOKEN\n`);
 const {rename}=await import('node:fs/promises');const fake=join(f.path,'npm-fixture');await rename(join(f.path,'npm'),fake);
 await writeFile(join(f.path,'npm'),`#!${process.execPath}\nconst {spawnSync}=require('node:child_process'),fs=require('node:fs');const args=process.argv.slice(2);if(['--version','pack'].includes(args[0])){const i=args.indexOf('--prefix'),prefix=i>=0?args.slice(i,i+2):[];const result=spawnSync(process.execPath,[${JSON.stringify(npm)},'config','list','--json',...prefix],{env:process.env,encoding:'utf8'});if(result.status!==0)process.exit(93);fs.appendFileSync(${JSON.stringify(probe)},JSON.stringify({kind:args[0],prefixArgs:prefix,config:JSON.parse(result.stdout)})+'\\n');if(args[0]==='--version'){console.log('11.6.2');process.exit(0);}}const result=spawnSync(${JSON.stringify(fake)},args,{env:process.env,stdio:'inherit'});process.exit(result.status??1);\n`,{mode:0o755});
 const result=await runInstaller(source==='tarball'?['--tarball',f.archive]:['--offline'],f);expect(result.code,result.stderr).toBe(0);const observed=(await readFile(probe,'utf8')).trim().split('\n').map(x=>JSON.parse(x));expect(observed.map(x=>x.kind)).toEqual(source==='tarball'?['--version']:['--version','pack']);for(const {config:loaded}of observed){expect(loaded['logs-dir']).not.toBe(external);expect(loaded['//registry.npmjs.org/:_authToken']).toBeUndefined();}expect(await readdir(external)).toEqual(['sentinel']);
});
it.each(['invalid','escape','missing-shrinkwrap','graph-drift','lock-tamper'])('refuses %s installed validation before activation',async(mode)=>{const f=await fixture(mode);const r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);await expect(readFile(command(f))).rejects.toMatchObject({code:'ENOENT'});});
it('accepts a consumer shrinkwrap larger than a small installation manifest',async()=>{const f=await fixture('large-shrinkwrap');const r=await runInstaller(['--tarball',f.archive],f);expect(r.stderr).toBe('');expect(r.code).toBe(0);});
it('ignores absent optional peer entries while comparing the actual installed graph',async()=>{const f=await fixture('optional-absent');const r=await runInstaller(['--tarball',f.archive],f);expect(r.stderr).toBe('');expect(r.code).toBe(0);});
it('is standalone and supports literal metacharacters, Unicode and leading-dash paths',async()=>{
 const f=await fixture(),copy=join(f.root,'downloaded script è.sh');await cp(installerPath,copy);const target=join(f.root,'-app spazio è;$(touch PWNED)'),bin=join(f.root,'-bin è;`touch PWNED`');const r=await runInstaller(['--tarball',f.archive,'--prefix',target,'--bin-dir',bin],f,copy);expect(r.code).toBe(0);expect(r.stdout).toContain(join(bin,'lorecrew'));await expect(readFile(join(f.root,'PWNED'))).rejects.toMatchObject({code:'ENOENT'});expect(spawnSync(join(bin,'lorecrew'),['literal'],{encoding:'utf8'}).status).toBe(0);
});

async function dataSentinels(f:Awaited<ReturnType<typeof installerFixture>>) {
 const state=join(f.home,'.local/state/lorecrew'),vault=join(f.home,'My vault'),auth=join(f.home,'.local/share/lorecrew/auth');
 for(const dir of [state,vault,auth])await mkdir(dir,{recursive:true});
 const files=new Map([[join(state,'config.json'),JSON.stringify({instanceId:'11111111-1111-1111-1111-111111111111',vaultDir:vault})],[join(state,'database-sentinel'),'old local state'],[join(vault,'notes.md'),'existing vault'],[join(auth,'auth.json'),'private fixture auth'],[join(f.home,'.zshrc'),'existing profile']]);
 for(const [p,bytes] of files)await writeFile(p,bytes);
 return {state,vault,auth,async unchanged(){for(const [p,bytes] of files)expect(await readFile(p,'utf8')).toBe(bytes);}};
}
async function activeManifest(f:{home:string}){const shim=await readFile(command(f),'utf8');const path=JSON.parse(shim.split('\n').find(l=>l.startsWith('# manifest: '))!.slice(12));return JSON.parse(await readFile(path,'utf8'));}
async function pause(f:Awaited<ReturnType<typeof installerFixture>>,args:string[]=[]){await writeFile(f.control,JSON.stringify({mode:'pause'}));const running=startInstaller(['--tarball',f.archive,...args],f);await expect.poll(async()=>readFile(join(f.root,'paused'),'utf8').catch(()=>''),{timeout:10000}).not.toBe('');return running;}
async function release(f:{root:string}){await writeFile(join(f.root,'release'),'continue');}

it.each(['file','symlink','PATH'])('refuses an unmanaged %s command without shadowing or state changes',async(kind)=>{
 const f=await fixture(),data=await dataSentinels(f);let location=command(f),path=f.path;
 if(kind==='PATH'){location=join(f.path,'lorecrew');}else await mkdir(join(f.home,'.local/bin'),{recursive:true});
 if(kind==='symlink')await symlink(f.archive,location);else await writeFile(location,'unmanaged command',{mode:0o755});
 const r=await runInstaller(['--tarball',f.archive,'--replace'],{...f,path});expect(r.code).not.toBe(0);expect((await f.calls()).filter(c=>c.args[0]==='ci')).toEqual([]);if(kind==='symlink')expect(await readFile(location)).toEqual(f.archiveBytes);else expect(await readFile(location,'utf8')).toBe('unmanaged command');await data.unchanged();
});
it('requires --replace for a verified managed command and retains the previous immutable install',async()=>{
 const f=await fixture(),data=await dataSentinels(f);expect((await runInstaller(['--tarball',f.archive],f)).code).toBe(0);const before=await readFile(command(f)),old=await activeManifest(f);
 expect((await runInstaller(['--tarball',f.archive],f)).code).not.toBe(0);expect(await readFile(command(f))).toEqual(before);
 const replaced=await runInstaller(['--tarball',f.archive,'--replace'],f);expect(replaced.code).toBe(0);const current=await activeManifest(f);expect(current.installId).not.toBe(old.installId);expect(await readFile(join(old.packageDir,'dist/cli.js'),'utf8')).toContain('fixture');expect(spawnSync(command(f),['new'],{encoding:'utf8'}).status).toBe(0);await data.unchanged();
});
it.each(['shim','manifest','installed-bytes'])('rejects modified managed %s rather than adopting it with --replace',async(kind)=>{
 const f=await fixture();expect((await runInstaller(['--tarball',f.archive],f)).code).toBe(0);const old=await activeManifest(f);
 const target=kind==='shim'?command(f):kind==='manifest'?join(prefix(f),'installs',old.installId,'install.json'):join(old.packageDir,'dist/cli.js');await writeFile(target,kind==='manifest'?'{}':'tampered bytes');const before=await readFile(command(f));expect((await runInstaller(['--tarball',f.archive,'--replace'],f)).code).not.toBe(0);expect(await readFile(command(f))).toEqual(before);
});
it.each(['prefix','bin','installs'])('refuses a symlinked %s destination before touching the target',async(kind)=>{
 const f=await fixture(),outside=join(f.root,'outside');await mkdir(outside);await writeFile(join(outside,'sentinel'),'keep');
 const p=kind==='prefix'?prefix(f):kind==='bin'?join(f.home,'.local/bin'):join(prefix(f),'installs');await mkdir(join(p,'..'),{recursive:true});await symlink(outside,p);
 const r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);expect(await readdir(outside)).toEqual(['sentinel']);
});
it.each(['same','prefix-in-bin','bin-in-prefix','state','vault','auth','project'])('refuses %s overlap without modifying user data',async(kind)=>{
 const f=await fixture(),data=await dataSentinels(f);let target=join(f.root,'application'),bin=join(f.root,'commands');
 if(kind==='same')bin=target;if(kind==='prefix-in-bin')target=join(bin,'application');if(kind==='bin-in-prefix')bin=join(target,'commands');if(kind==='state')target=join(data.state,'application');if(kind==='vault')bin=join(data.vault,'commands');if(kind==='auth')target=data.auth;if(kind==='project'){target=join(f.root,'project','app');await mkdir(join(f.root,'project','.git'),{recursive:true});await writeFile(join(f.root,'project','.git','HEAD'),'ref: refs/heads/main\n');}
 const r=await runInstaller(['--tarball',f.archive,'--prefix',target,'--bin-dir',bin],f);expect(r.code).not.toBe(0);expect((await f.calls()).filter(c=>c.args[0]==='ci')).toEqual([]);await data.unchanged();
});
it.each(['npm-failure','invalid','activation-collision'])('preserves the old executable and all data after %s',async(mode)=>{
 const f=await fixture(),data=await dataSentinels(f);expect((await runInstaller(['--tarball',f.archive],f)).code).toBe(0);const before=await readFile(command(f)),old=await activeManifest(f);
 if(mode==='activation-collision'){const running=await pause(f,['--replace']);await writeFile(command(f),'late external command');await release(f);const r=await running.result;expect(r.code).not.toBe(0);expect(await readFile(command(f),'utf8')).toBe('late external command');}
 else {await writeFile(f.control,JSON.stringify({mode}));expect((await runInstaller(['--tarball',f.archive,'--replace'],f)).code).not.toBe(0);expect(await readFile(command(f))).toEqual(before);expect(spawnSync(command(f),['still-runs'],{encoding:'utf8'}).status).toBe(0);}
 expect(await readFile(join(old.packageDir,'dist/cli.js'),'utf8')).toContain('fixture');await data.unchanged();expect((await readdir(join(f.home,'.local/bin'))).some(name=>/^\.lorecrew-[a-f0-9]/.test(name))).toBe(false);
});
it('rechecks bin directory identity after staging and never follows its substitution',async()=>{
 const f=await fixture(),outside=join(f.root,'late-outside');await mkdir(outside);await writeFile(join(outside,'sentinel'),'keep');await writeFile(f.control,JSON.stringify({mode:'substitute-bin',bin:join(f.home,'.local/bin'),target:outside}));
 const r=await runInstaller(['--tarball',f.archive],f);expect(r.code).not.toBe(0);expect(await readdir(outside)).toEqual(['sentinel']);
});
it('rechecks the prefix before post-npm writes and contains npm writes in its original staging cwd',async()=>{
 const f=await fixture(),outside=join(f.root,'prefix-substitute');await mkdir(outside);await writeFile(join(outside,'sentinel'),'keep');const running=await pause(f);const {rename}=await import('node:fs/promises');await rename(prefix(f),prefix(f)+'.saved');await symlink(outside,prefix(f));await release(f);expect((await running.result).code).not.toBe(0);expect(await readdir(outside)).toEqual(['sentinel']);
});
it('installs the verified snapshot even if the original tarball changes during staging',async()=>{
 const f=await fixture(),running=await pause(f,['--sha256',f.sha256]);await writeFile(f.archive,'different archive after hash verification');await release(f);expect((await running.result).code).toBe(0);expect(await readFile(join(f.root,'consumed-archive'))).toEqual(f.archiveBytes);expect((await activeManifest(f)).artifactSha256).toBe(f.sha256);
});
it('allows an empty .git ancestor marker that is not a Git worktree',async()=>{const f=await fixture();await mkdir(join(f.root,'.git'));const r=await runInstaller(['--tarball',f.archive],f);expect(r.stderr).toBe('');expect(r.code).toBe(0);});
it('refuses activation after its lock is substituted and never removes the new owner lock',async()=>{const f=await fixture(),running=await pause(f),lock=join(f.home,'.local/bin/.lorecrew-install.lock');const {rename}=await import('node:fs/promises');await rename(lock,lock+'.original');await mkdir(lock);const owner=JSON.stringify({pid:process.pid,installId:'another-owner'});await writeFile(join(lock,'owner.json'),owner);await release(f);expect((await running.result).code).not.toBe(0);expect(await readFile(join(lock,'owner.json'),'utf8')).toBe(owner);await expect(readFile(command(f))).rejects.toMatchObject({code:'ENOENT'});});
it('rechecks an external PATH command introduced while npm is staged',async()=>{const f=await fixture(),running=await pause(f);await writeFile(join(f.path,'lorecrew'),'external command',{mode:0o755});await release(f);expect((await running.result).code).not.toBe(0);expect(await readFile(join(f.path,'lorecrew'),'utf8')).toBe('external command');await expect(readFile(command(f))).rejects.toMatchObject({code:'ENOENT'});});
it.each([false,true])('serializes installers sharing a bin (different prefixes: %s), never stealing a live lock',async(differentPrefix)=>{
 const f=await fixture();const first=await pause(f);try{const r=await runInstaller(['--tarball',f.archive,...differentPrefix?['--prefix',join(f.root,'second-prefix')]:[]],f);expect(r.code).not.toBe(0);expect(r.stderr).toMatch(/lock|busy/i);expect((await f.calls()).filter(c=>c.args[0]==='ci')).toHaveLength(1);}finally{await release(f);}expect((await first.result).code).toBe(0);expect(spawnSync(command(f),['ready'],{encoding:'utf8'}).status).toBe(0);
});
it('joins an interrupted staging child, releases only its own locks, and preserves the previous command',async()=>{
 const f=await fixture(),data=await dataSentinels(f);expect((await runInstaller(['--tarball',f.archive],f)).code).toBe(0);const before=await readFile(command(f));const running=await pause(f,['--replace']);running.child.kill('SIGTERM');const result=await running.result;expect(result.code).not.toBe(0);expect(result.stderr).toMatch(/interrupt|signal/i);expect(await readFile(command(f))).toEqual(before);expect(spawnSync(command(f),['old-still-runs'],{encoding:'utf8'}).status).toBe(0);await data.unchanged();await writeFile(f.control,JSON.stringify({mode:'success'}));expect((await runInstaller(['--tarball',f.archive,'--replace'],f)).code).toBe(0);
},15000);
