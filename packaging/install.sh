#!/bin/sh
# Standalone per-user installer. No sibling files or lifecycle scripts are used.
# Scrub before even the first Node invocation (including prerequisite checks).
unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_ICU_DATA
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Lorecrew installer: node (Node.js 24) is required on PATH.' >&2
  exit 1
fi
exec node --input-type=commonjs - "$@" <<'LORECREW_INSTALLER_NODE'
'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { fileURLToPath } = require('node:url');
const { isDeepStrictEqual } = require('node:util');
const { gunzipSync } = require('node:zlib');

const registry = 'https://registry.npmjs.org';
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const inside = (root, path) => { const r = relative(root, path); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith('..' + sep)); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const save = (path, value) => fs.writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const quote = s => "'" + s.replace(/'/g, "'\\''") + "'";
let diagnosticDir;
const directories = new Map(), locks = [];
let interrupted, activeChild, temporaryCommand, published = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { if (!published) { interrupted = signal; if (activeChild) activeChild.kill(signal); } });
const checkpoint = () => { if (interrupted) fail('INSTALL_interrupted_' + interrupted); };

async function stat(path) { try { return await fs.lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function executable(name) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const path = resolve(dir || '.', name);
    try { await fs.access(path, constants.X_OK); if ((await fs.stat(path)).isFile()) return await fs.realpath(path); } catch (e) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(e.code)) throw e; }
  }
  fail('MISSING_' + name);
}
function options() {
  const args = process.argv.slice(2), out = {}, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--version', '--tarball', '--sha256', '--cache', '--prefix', '--bin-dir', '--offline', '--replace'].includes(key) || seen.has(key)) fail('INVALID_option');
    seen.add(key);
    if (['--offline', '--replace'].includes(key)) out[key.slice(2)] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_option_value'); out[key.slice(2)] = args[++i]; }
  }
  if (!process.env.HOME || !isAbsolute(process.env.HOME)) fail('INVALID_HOME_directory');
  if (out.version && (!semver.test(out.version) || out.tarball)) fail('INVALID_version_source');
  if (out.sha256 && (!out.tarball || !/^[a-fA-F0-9]{64}$/.test(out.sha256))) fail('INVALID_sha256');
  out.prefix = resolve(out.prefix || join(process.env.HOME, '.local/share/lorecrew/app'));
  out.bin = resolve(out['bin-dir'] || join(process.env.HOME, '.local/bin'));
  out.cache = resolve(out.cache || join(process.env.HOME, '.npm'));
  if (out.tarball) out.tarball = resolve(out.tarball);
  return out;
}
async function noLinks(path) {
  for (let p = path; ; p = dirname(p)) {
    const s = await stat(p);
    if (s && (!s.isDirectory() || s.isSymbolicLink())) fail('UNSAFE_directory_symlink');
    if (dirname(p) === p) break;
  }
}
async function readOwned(path, maxBytes = 65536) {
  await noLinks(dirname(path));
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const s = await file.stat(); if (!s.isFile() || s.uid !== process.getuid() || s.mode & 0o022 || s.size > maxBytes) fail('UNMANAGED_file'); return await file.readFile('utf8'); }
  finally { await file.close(); }
}
async function ownDirectory(path) {
  await noLinks(path); await fs.mkdir(path, { recursive: true, mode: 0o700 }); await noLinks(path);
  const s = await fs.lstat(path); if (!s.isDirectory() || s.uid !== process.getuid() || s.mode & 0o022) fail('UNMANAGED_directory');
  directories.set(path, { dev: s.dev, ino: s.ino });
}
async function recheckDirectories() {
  checkpoint();
  for (const [path, expected] of directories) {
    await noLinks(path); const s = await fs.lstat(path);
    if (s.dev !== expected.dev || s.ino !== expected.ino || s.uid !== process.getuid() || s.mode & 0o022) fail('CHANGED_directory_identity');
  }
  for (const lock of locks) {
    await noLinks(lock.path); const s = await fs.lstat(lock.path), owner = JSON.parse(await readOwned(join(lock.path, 'owner.json')));
    if (s.dev !== lock.dev || s.ino !== lock.ino || owner.pid !== process.pid || owner.installId !== lock.installId) fail('CHANGED_install_lock');
  }
}
async function checkPathCommand(command) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const path = resolve(dir || '.', 'lorecrew');
    if (path !== command && await stat(path)) fail('EXISTING_lorecrew_on_PATH');
  }
}
async function acquireLock(path, installId) {
  await noLinks(dirname(path));
  try { await fs.mkdir(path, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') fail('INSTALL_LOCK_BUSY'); throw e; }
  const s = await fs.lstat(path); locks.push({ path, dev: s.dev, ino: s.ino, installId });
  await save(join(path, 'owner.json'), { pid: process.pid, installId });
}
async function releaseLocks() {
  for (const lock of locks.reverse()) {
    try {
      await noLinks(lock.path); const s = await fs.lstat(lock.path);
      if (s.dev !== lock.dev || s.ino !== lock.ino || s.uid !== process.getuid()) continue;
      const owner = JSON.parse(await readOwned(join(lock.path, 'owner.json')));
      if (owner.installId !== lock.installId || owner.pid !== process.pid) continue;
      await fs.unlink(join(lock.path, 'owner.json')); await fs.rmdir(lock.path);
    } catch { /* A changed/ambiguous lock is retained. Never recursively remove it. */ }
  }
}
async function protectData(o) {
  const home = process.env.HOME, state = join(home, '.local/state/lorecrew');
  const protectedPaths = [state, join(home, '.local/share/lorecrew/auth'), join(home, '.pi')];
  if (process.env.LORECREW_AUTH_FILE) protectedPaths.push(resolve(process.env.LORECREW_AUTH_FILE));
  if (process.env.PI_CODING_AGENT_DIR) protectedPaths.push(resolve(process.env.PI_CODING_AGENT_DIR));
  await noLinks(state);
  if (await stat(join(state, 'config.json'))) {
    const config = JSON.parse(await readOwned(join(state, 'config.json')));
    if (typeof config.vaultDir !== 'string') fail('INVALID_state_config');
    protectedPaths.push(resolve(config.vaultDir));
  }
  for (const path of [...protectedPaths]) { if (await stat(path)) protectedPaths.push(await fs.realpath(path)); }
  for (const path of [o.prefix, o.bin, o.cache]) {
    if (protectedPaths.some(data => inside(data, path) || inside(path, data))) fail('INVALID_data_directory_overlap');
    for (let p = path; ; p = dirname(p)) {
      const gitPath = join(p, '.git'), git = await stat(gitPath);
      if (git?.isSymbolicLink()) fail('UNSAFE_project_symlink');
      if (git?.isDirectory() && await stat(join(gitPath, 'HEAD')) || git?.isFile() && /^gitdir:\s*\S+/m.test(await readOwned(gitPath))) fail('INVALID_project_directory');
      // Recognize explicit nondefault instance ancestors without scanning user data.
      const config = join(p, 'config.json');
      if (await stat(config)) {
        const bytes = await readOwned(config); let value; try { value = JSON.parse(bytes); } catch {}
        if (value?.instanceId && value?.vaultDir) fail('INVALID_state_directory');
      }
      if (dirname(p) === p) break;
    }
  }
  for (const a of [o.prefix, o.bin]) if (inside(a, o.cache) || inside(o.cache, a)) fail('INVALID_cache_directory_overlap');
}
function shimFor(manifestPath, manifest) {
  return '#!/bin/sh\n# Lorecrew installer v1\n# manifest: ' + JSON.stringify(manifestPath) + '\nexec ' + quote(manifest.nodePath) + ' ' + quote(join(manifest.packageDir, 'dist/cli.js')) + ' "$@"\n';
}
async function currentCommand(command, prefix) {
  if (!await stat(command)) return null;
  const bytes = await readOwned(command), line = bytes.split('\n')[2];
  if (!line?.startsWith('# manifest: ')) fail('UNMANAGED_command');
  let path; try { path = JSON.parse(line.slice(12)); } catch { fail('UNMANAGED_command'); }
  if (typeof path !== 'string' || !isAbsolute(path) || path !== resolve(path) || !/^[a-f0-9-]{36}$/.test(dirname(path).split(sep).at(-1)) || dirname(dirname(path)) !== join(prefix, 'installs') || path !== join(dirname(path), 'install.json')) fail('UNMANAGED_manifest_path');
  const manifest = JSON.parse(await readOwned(path)), destination = dirname(path);
  if (manifest.schemaVersion !== 1 || manifest.installId !== destination.split(sep).at(-1) || manifest.packageDir !== join(destination, 'node_modules/lorecrew') || manifest.dependencyGraphPath !== join(destination, 'dependency-graph.json') || typeof manifest.nodePath !== 'string' || !isAbsolute(manifest.nodePath) || bytes !== shimFor(path, manifest)) fail('UNMANAGED_manifest');
  const metadata = JSON.parse(await readOwned(join(manifest.packageDir, 'package.json')));
  if (metadata.name !== 'lorecrew' || metadata.version !== manifest.version || (await identity(manifest.packageDir)).treeSha256 !== manifest.treeSha256) fail('CHANGED_installed_identity');
  await readOwned(manifest.dependencyGraphPath, 16 * 1024 * 1024);
  return bytes;
}
async function syncDirectory(path) { const file = await fs.open(path, 'r'); try { await file.sync(); } finally { await file.close(); } }
// Read only two fixed JSON entries. npm performs extraction; no archive path is written here.
function archivePins(bytes) {
  let tar; try { tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 }); } catch { fail('INVALID_tarball_gzip'); }
  const found = new Map(), text = b => b.toString('utf8').split('\0')[0];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(b => b === 0)) break;
    const octal = b => { const s = text(b).trim(); if (!/^[0-7]+$/.test(s)) fail('INVALID_tarball_header'); return parseInt(s, 8); };
    const size = octal(header.subarray(124, 136)), checksum = octal(header.subarray(148, 156));
    let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== checksum || offset + 512 + size > tar.length) fail('INVALID_tarball_header');
    const prefix = text(header.subarray(345, 500)), name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    if (['package/package.json', 'package/npm-shrinkwrap.json'].includes(name)) {
      if (found.has(name) || ![0, 48].includes(header[156]) || size > 16 * 1024 * 1024) fail('INVALID_tarball_pin_entry');
      try { found.set(name, JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'))); } catch { fail('INVALID_tarball_pin_json'); }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const metadata = found.get('package/package.json'), lock = found.get('package/npm-shrinkwrap.json');
  if (metadata?.name !== 'lorecrew' || !semver.test(metadata.version) || lock?.lockfileVersion !== 3 || lock.name !== metadata.name || lock.version !== metadata.version || lock.packages?.['']?.version !== metadata.version || !isDeepStrictEqual(lock.packages[''].dependencies, metadata.dependencies)) fail('INVALID_tarball_consumer_shrinkwrap');
  return { metadata, lock };
}
async function npmProcess(npm, args, stage, env, label) {
  const out = await fs.open(join(diagnosticDir, label + '.stdout'), 'wx', 0o600), log = await fs.open(join(diagnosticDir, label + '.log'), 'wx', 0o600);
  try { await new Promise((done, reject) => {
    const child = spawn(npm, args, { cwd: stage, env, stdio: ['ignore', out.fd, log.fd] }); activeChild = child;
    child.once('error', reject); child.once('close', code => { activeChild = undefined; if (interrupted) reject(Object.assign(new Error('interrupted'), { code: 'INSTALL_interrupted_' + interrupted })); else if (code === 0) done(); else reject(Object.assign(new Error('npm failed'), { code: 'NPM_' + label.toUpperCase() + '_FAILED' })); });
  }); } finally { await out.close(); await log.close(); }
  await recheckDirectories();
  return fs.readFile(join(diagnosticDir, label + '.stdout'), 'utf8');
}
async function identity(packageDir) {
  const modules = dirname(packageDir), hash = createHash('sha256'), packages = [];
  async function walk(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const p = join(dir, name), r = relative(modules, p), s = await fs.lstat(p);
      hash.update(JSON.stringify([r, s.mode & 0o777, s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'link' : 'file']) + '\n');
      if (s.isSymbolicLink()) {
        if (!inside(modules, await fs.realpath(p))) fail('INSTALLED_PATH_ESCAPE');
        hash.update(await fs.readlink(p));
      } else if (s.isDirectory()) await walk(p);
      else if (s.isFile()) {
        const bytes = await fs.readFile(p); hash.update(sha(bytes));
        if (name === 'package.json') { const m = JSON.parse(bytes.toString()); if (m.name && m.version) packages.push({ path: r, name: m.name, version: m.version }); }
      } else fail('INSTALLED_SPECIAL_FILE');
    }
  }
  if (await fs.realpath(packageDir) !== packageDir) fail('INSTALLED_PATH_ESCAPE');
  await walk(modules);
  return { packageDir, treeSha256: hash.digest('hex'), packages };
}
async function main() {
  const o = options();
  if (Number(process.versions.node.split('.')[0]) !== 24) fail('Node.js_24_required');
  let artifactSha256, artifactBytes;
  if (o.tarball) {
    const s = await stat(o.tarball);
    if (!s || !s.isFile() || s.isSymbolicLink()) fail('INVALID_tarball_file');
    await noLinks(dirname(o.tarball));
    const file = await fs.open(o.tarball, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { if (!(await file.stat()).isFile()) fail('INVALID_tarball_file'); artifactBytes = await file.readFile(); }
    finally { await file.close(); }
    artifactSha256 = sha(artifactBytes);
    if (o.sha256 && artifactSha256 !== o.sha256.toLowerCase()) fail('MISMATCH_sha256');
  }
  const npm = await executable('npm'), git = await executable('git'), nodePath = await fs.realpath(process.execPath);
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  if (spawnSync(git, ['--version'], { env: baseEnv, encoding: 'utf8' }).status !== 0) fail('MISSING_git');
  if (inside(o.prefix, o.bin) || inside(o.bin, o.prefix)) fail('INVALID_overlapping_directory');
  await protectData(o);
  await noLinks(o.prefix); await noLinks(o.bin);
  const command = join(o.bin, 'lorecrew');
  await checkPathCommand(command);
  const installId = randomUUID(), installs = join(o.prefix, 'installs'), stage = join(installs, '.staging-' + installId), destination = join(installs, installId);
  await ownDirectory(o.bin); await acquireLock(join(o.bin, '.lorecrew-install.lock'), installId);
  await ownDirectory(o.prefix); await acquireLock(join(o.prefix, '.install.lock'), installId);
  const marker = join(o.prefix, 'installer.json');
  if (await stat(marker)) {
    const owner = JSON.parse(await readOwned(marker)); if (owner.schemaVersion !== 1 || owner.prefix !== o.prefix || owner.uid !== process.getuid()) fail('UNMANAGED_prefix');
  } else {
    if ((await fs.readdir(o.prefix)).some(name => name !== '.install.lock')) fail('UNMANAGED_prefix');
    await save(marker, { schemaVersion: 1, prefix: o.prefix, uid: process.getuid() });
  }
  const previous = await currentCommand(command, o.prefix);
  if (previous && !o.replace) fail('EXISTING_command_requires_replace');
  await ownDirectory(installs); await ownDirectory(join(o.prefix, 'diagnostics'));
  diagnosticDir = join(o.prefix, 'diagnostics', installId); await ownDirectory(diagnosticDir);
  await ownDirectory(stage);
  const home = join(stage, 'installer-home'); await ownDirectory(home);
  const userconfig = join(home, 'user.conf'), globalconfig = join(home, 'global.conf');
  await fs.writeFile(userconfig, '', { mode: 0o600 }); await fs.writeFile(globalconfig, '', { mode: 0o600 }); await fs.writeFile(join(stage, '.npmrc'), '', { mode: 0o600 });
  const env = { ...baseEnv, HOME: home, npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: o.cache,
    npm_config_registry: registry, npm_config_offline: o.tarball || o.offline ? 'true' : 'false', npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  const npmVersion = spawnSync(npm, ['--version', '--prefix', '.'], { cwd: stage, env, encoding: 'utf8' });
  if (npmVersion.status !== 0) fail('MISSING_npm');
  if (!/^11\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion.stdout.trim())) fail('UNSUPPORTED_npm_use_11_consumer_shrinkwrap_required');
  const source = o.tarball ? { kind: 'tarball', path: o.tarball } : { kind: 'npm', spec: 'lorecrew@' + (o.version || 'latest'), registry };
  const common = ['--registry=' + registry, '--cache', o.cache, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', ...(o.tarball || o.offline ? ['--offline'] : [])];
  if (!artifactBytes) {
    const result = JSON.parse(await npmProcess(npm, ['pack', '--prefix', '.', ...common, '--pack-destination', '.', '--json', '--', source.spec], stage, env, 'npm-source'));
    if (!Array.isArray(result) || result.length !== 1 || typeof result[0].filename !== 'string' || result[0].filename !== result[0].filename.split(/[\\/]/).at(-1) || !/^[A-Za-z0-9_.-]+\.tgz$/.test(result[0].filename)) fail('INVALID_npm_source_archive');
    const path = join(stage, result[0].filename), s = await fs.lstat(path); if (!s.isFile() || s.isSymbolicLink()) fail('INVALID_npm_source_archive');
    artifactBytes = await fs.readFile(path); artifactSha256 = sha(artifactBytes);
  }
  const pins = archivePins(artifactBytes);
  if (o.version && pins.metadata.version !== o.version) fail('MISMATCH_version');
  await fs.writeFile(join(stage, 'artifact.tgz'), artifactBytes, { mode: 0o600, flag: 'wx' });
  // A consumer nested shrinkwrap is not reliably discovered for local tarballs.
  // A root lock makes npm ci use these exact bytes/versions without resolution of ranges.
  const dependency = 'file:artifact.tgz', root = { name: 'lorecrew-installer', private: true, dependencies: { lorecrew: dependency } };
  const packages = { '': root, 'node_modules/lorecrew': { ...pins.lock.packages[''], resolved: dependency, integrity: 'sha512-' + createHash('sha512').update(artifactBytes).digest('base64') } };
  for (const [path, entry] of Object.entries(pins.lock.packages)) if (path) {
    if (!path.startsWith('node_modules/') || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\') || entry.link) fail('INVALID_shrinkwrap_path');
    packages['node_modules/lorecrew/' + path] = entry;
  }
  await save(join(stage, 'package.json'), root);
  await save(join(stage, 'package-lock.json'), { name: root.name, lockfileVersion: 3, requires: true, packages });
  await npmProcess(npm, ['ci', '--prefix', '.', ...common], stage, env, 'npm-install');
  const packageDir = join(stage, 'node_modules/lorecrew'), metadata = JSON.parse(await fs.readFile(join(packageDir, 'package.json'), 'utf8'));
  if (metadata.name !== 'lorecrew' || !semver.test(metadata.version) || metadata.bin?.lorecrew !== 'dist/cli.js' || metadata.type !== 'module' || o.version && metadata.version !== o.version) fail('INVALID_installed_package');
  for (const file of ['dist/cli.js', 'dist/runtime/pi-host.js', 'dist/web/index.html', 'dist/web/manifest.webmanifest', 'dist/web/sw.js']) if (!(await fs.lstat(join(packageDir, file))).isFile()) fail('INVALID_compiled_file');
  const shrinkwrap = JSON.parse(await readOwned(join(packageDir, 'npm-shrinkwrap.json'), 16 * 1024 * 1024));
  if (!isDeepStrictEqual(shrinkwrap, pins.lock) || !isDeepStrictEqual(metadata, pins.metadata)) fail('CHANGED_archive_metadata_or_pins');
  if (shrinkwrap.lockfileVersion !== 3 || shrinkwrap.name !== metadata.name || shrinkwrap.version !== metadata.version || shrinkwrap.packages?.['']?.version !== metadata.version || !isDeepStrictEqual(shrinkwrap.packages[''].dependencies, metadata.dependencies)) fail('INVALID_consumer_shrinkwrap');
  await identity(packageDir);
  // Resolve under ESM import conditions from the installed package, never this script/checkout.
  const validate = `import fs from 'node:fs/promises';import {dirname,relative,isAbsolute,sep,join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const p=process.argv[1],root=dirname(p),m=JSON.parse(await fs.readFile(join(p,'package.json'),'utf8'));
for(const name of Object.keys(m.dependencies||{})){const f=await fs.realpath(fileURLToPath(import.meta.resolve(name))),r=relative(root,f);if(isAbsolute(r)||r==='..'||r.startsWith('..'+sep))throw Error('INSTALLED_PATH_ESCAPE');}
await import(pathToFileURL(join(p,'dist/cli.js')));await import(pathToFileURL(join(p,'dist/runtime/pi-host.js')));await import('@earendil-works/pi-durable');await import('@earendil-works/pi-ai/models');`;
  const validation = spawnSync(nodePath, ['--input-type=module', '-e', validate, packageDir], { cwd: packageDir, env, encoding: 'utf8', timeout: 30000 });
  await fs.writeFile(join(diagnosticDir, 'validation.log'), (validation.stdout || '') + (validation.stderr || ''), { mode: 0o600 });
  if (validation.error || validation.status !== 0) fail('INSTALLED_ESM_VALIDATION');
  await recheckDirectories(); await fs.rename(stage, destination);
  for (const [path, snapshot] of [...directories]) if (inside(stage, path)) { directories.delete(path); directories.set(join(destination, relative(stage, path)), snapshot); }
  await syncDirectory(installs);
  const finalPackage = join(destination, 'node_modules/lorecrew');
  const graph = spawnSync(npm, ['ls', '--prefix', destination, '--all', '--omit=dev', '--json'], { cwd: destination, env: { ...env, HOME: join(destination, 'installer-home'), npm_config_userconfig: join(destination, 'installer-home/user.conf'), npm_config_globalconfig: join(destination, 'installer-home/global.conf') }, encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
  await fs.writeFile(join(diagnosticDir, 'npm-ls.log'), graph.stderr || '', { mode: 0o600 });
  await fs.writeFile(join(diagnosticDir, 'npm-ls.json'), graph.stdout || '', { mode: 0o600 });
  if (graph.error || graph.status !== 0) fail('NPM_GRAPH_FAILED');
  const installedGraph = JSON.parse(graph.stdout), expectedGraph = new Set(), actualGraph = new Set();
  for (const [path, m] of Object.entries(shrinkwrap.packages)) if (path && !m.dev) {
    const supported = (list, current) => !list || !list.includes('!' + current) && (list.every(x => x.startsWith('!')) || list.includes(current));
    if (m.optional && (!supported(m.os, process.platform) || !supported(m.cpu, process.arch))) continue;
    if (!path.startsWith('node_modules/') || !semver.test(m.version)) fail('INVALID_pinned_dependency');
    expectedGraph.add(path.split('node_modules/').at(-1) + '@' + m.version);
  }
  const graphRoot = installedGraph.dependencies?.lorecrew;
  if (graphRoot?.version !== metadata.version) fail('INVALID_installed_graph');
  function visit(node) { for (const [name, dependency] of Object.entries(node.dependencies || {})) { if (typeof dependency.version === 'string') actualGraph.add(name + '@' + dependency.version); visit(dependency); } }
  visit(graphRoot);
  if (!isDeepStrictEqual(actualGraph, expectedGraph)) fail('MISMATCH_shipped_production_graph');
  const dependencyGraphPath = join(destination, 'dependency-graph.json'); await save(dependencyGraphPath, installedGraph);
  const tree = await identity(finalPackage); await save(join(destination, 'installed-identity.json'), tree);
  const manifest = { schemaVersion: 1, installId, version: metadata.version, source, nodePath, npmVersion: npmVersion.stdout.trim(), packageDir: finalPackage, ...(artifactSha256 ? { artifactSha256 } : {}), treeSha256: tree.treeSha256, dependencyGraphPath };
  await save(join(destination, 'install.json'), manifest);
  await recheckDirectories();
  const shim = shimFor(join(destination, 'install.json'), manifest);
  temporaryCommand = join(o.bin, '.lorecrew-' + installId);
  const file = await fs.open(temporaryCommand, 'wx', 0o755);
  try { await file.writeFile(shim); await file.sync(); } finally { await file.close(); }
  await recheckDirectories();
  await checkPathCommand(command);
  if (await currentCommand(command, o.prefix) !== previous) fail('CHANGED_command_at_activation');
  checkpoint();
  if (previous) await fs.rename(temporaryCommand, command);
  else { await fs.link(temporaryCommand, command); await fs.unlink(temporaryCommand); }
  temporaryCommand = undefined; published = true; await syncDirectory(o.bin);
  console.log('Installed Lorecrew ' + metadata.version + '\nCommand: ' + command);
  if (!(process.env.PATH || '').split(':').map(p => resolve(p || '.')).includes(o.bin)) console.log('Add the command directory for this shell:\nexport PATH=' + quote(o.bin) + ':"$PATH"');
}
main().catch(async e => {
  if (diagnosticDir) try {
    await noLinks(diagnosticDir); const s = await fs.lstat(diagnosticDir), expected = directories.get(diagnosticDir);
    if (expected && (s.dev !== expected.dev || s.ino !== expected.ino)) diagnosticDir = undefined;
  } catch { diagnosticDir = undefined; }
  if (!diagnosticDir) { try { diagnosticDir = await fs.mkdtemp(join(tmpdir(), 'lorecrew-install-diagnostic-')); } catch {} }
  if (diagnosticDir) { try { await save(join(diagnosticDir, 'failure.json'), { code: e.code || 'INSTALL_FAILED' }); } catch {} }
  console.error('Lorecrew installer: ' + (e.code || 'INSTALL_FAILED') + (diagnosticDir ? '\nPrivate diagnostics: ' + diagnosticDir : ''));
  process.exitCode = 1;
}).finally(async () => {
  if (temporaryCommand) try { await recheckDirectories(); await fs.unlink(temporaryCommand); } catch {}
  await releaseLocks();
});
LORECREW_INSTALLER_NODE
