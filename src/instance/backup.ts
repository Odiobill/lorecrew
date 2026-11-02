import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { AppError } from '../contracts/base.js';
import { acquireLock } from './lock.js';
import { readConfig } from './config.js';
import { canonicalPath, validateStatePlacement } from './placement.js';
import { SCHEMA_VERSION } from '../storage/migrations.js';
interface Entry {
    path: string;
    kind: 'file' | 'directory';
    mode: number;
    sha256?: string;
}
interface Manifest {
    format: 1;
    instanceId: string;
    sourceStateDir: string;
    createdAt: string;
    schemaVersion: number;
    entries: Entry[];
}
const invalid = () => new AppError('INVALID_BACKUP', 'Backup manifest or file integrity is invalid');
const excluded = (name: string) => name === 'instance.lock' || name === 'instance.lock-recovery' || name.startsWith('.lock-transition-');
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)); };
async function syncDir(path: string) { const file = await open(path, 'r'); try {
    await file.sync();
}
finally {
    await file.close();
} }
async function durableWrite(path: string, value: unknown) { const file = await open(path, 'wx', 0o600); try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
}
finally {
    await file.close();
} }
async function digest(path: string) { const hash = createHash('sha256'); for await (const data of createReadStream(path))
    hash.update(data); return hash.digest('hex'); }
async function syncFile(path: string) { const file = await open(path, 'r'); try {
    await file.sync();
}
finally {
    await file.close();
} }
function inspectControl(path: string): number {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        if (version > SCHEMA_VERSION)
            throw new AppError('SCHEMA_TOO_NEW', 'Backup requires a newer Lorecrew version');
        if (version < 1)
            throw new AppError('SCHEMA_UNSUPPORTED', 'Migrate the control database before backing up');
        if (db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok')
            throw invalid();
        const records = db.prepare("SELECT value FROM records WHERE kind='host-process'").all();
        if (records.some(row => { const record = JSON.parse(String(row.value)); return record.state !== 'stopped' && !(record.state === 'exited' && record.settled === true); }))
            throw new AppError('NOT_QUIESCENT', 'Unsettled host process evidence prevents a coherent backup; prove descendants stopped first');
        return version;
    }
    finally {
        db.close();
    }
}
/** A backup is a private manifest directory, never a running clone. Caller must stop external editors too. */
export async function backupOffline(input: {
    stateDir: string;
    destination: string;
}): Promise<{
    manifestPath: string;
}> {
    const stateDir = await realpath(resolve(input.stateDir)), destination = await canonicalPath(resolve(input.destination));
    if (inside(stateDir, destination) || inside(destination, stateDir))
        throw new AppError('INVALID_BACKUP_PATH', 'Backup and state directories must be separate');
    const lock = await acquireLock(stateDir, 'offline-backup');
    let staging: string | undefined;
    try {
        try {
            await lstat(join(stateDir, 'restore-incomplete.json'));
            throw new AppError('RESTORE_INCOMPLETE', 'Interrupted restore cannot be used as a backup source');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        const config = await readConfig(stateDir);
        if (!config)
            throw new AppError('INSTANCE_UNINITIALIZED', 'Initialize an instance before backup');
        const schemaVersion = inspectControl(join(stateDir, 'control.sqlite'));
        // Refuse an existing destination rather than merge or overwrite prior recovery evidence.
        try {
            await lstat(destination);
            throw new AppError('BACKUP_EXISTS', 'Backup destination already exists');
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
        }
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        staging = join(dirname(destination), `.backup-${randomUUID()}`);
        await mkdir(staging, { mode: 0o700 });
        await mkdir(join(staging, 'files'), { mode: 0o700 });
        const entries: Entry[] = [];
        async function capture(rel: string) {
            const source = join(stateDir, rel), target = join(staging!, 'files', rel), info = await lstat(source);
            if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
                throw new AppError('UNSAFE_BACKUP_ENTRY', 'Backup refuses symbolic links and special files', { path: rel });
            const mode = info.mode & 0o777;
            if (info.isDirectory()) {
                await mkdir(target, { mode: 0o700 });
                entries.push({ path: rel, kind: 'directory', mode });
                for (const name of (await readdir(source)).sort())
                    await capture(join(rel, name));
                await syncDir(target);
            }
            else {
                // SQLite backup includes committed WAL pages without copying transient shared-memory files.
                if (!rel.includes(sep) && rel.endsWith('.sqlite')) {
                    const db = new DatabaseSync(source, { readOnly: true });
                    try {
                        await backup(db, target);
                    }
                    finally {
                        db.close();
                    }
                }
                else
                    await copyFile(source, target);
                await chmod(target, 0o600 | (mode & 0o100));
                await syncFile(target);
                entries.push({ path: rel, kind: 'file', mode, sha256: await digest(target) });
            }
        }
        for (const name of (await readdir(stateDir)).sort())
            if (!excluded(name) && !/^.+\.sqlite-(wal|shm)$/.test(name))
                await capture(name);
        const manifest: Manifest = { format: 1, instanceId: config.instanceId, sourceStateDir: stateDir, createdAt: new Date().toISOString(), schemaVersion, entries };
        await durableWrite(join(staging, 'manifest.json'), manifest);
        await syncDir(join(staging, 'files'));
        await syncDir(staging);
        await rename(staging, destination);
        staging = undefined;
        await syncDir(dirname(destination));
        return { manifestPath: join(destination, 'manifest.json') };
    }
    finally {
        try {
            if (staging)
                await rm(staging, { recursive: true, force: true });
        }
        finally {
            await lock.release();
        }
    }
}
async function validateArchive(archivePath: string): Promise<Manifest> {
    let manifest: Manifest;
    try {
        manifest = JSON.parse(await readFile(join(archivePath, 'manifest.json'), 'utf8')) as Manifest;
    }
    catch {
        throw invalid();
    }
    if (manifest.format !== 1 || !Array.isArray(manifest.entries) || typeof manifest.instanceId !== 'string' || typeof manifest.sourceStateDir !== 'string' || (!Number.isSafeInteger(manifest.schemaVersion)||manifest.schemaVersion<1||manifest.schemaVersion>SCHEMA_VERSION))
        throw invalid();
    const paths = new Set<string>();
    for (const entry of manifest.entries) {
        if (!entry || typeof entry.path !== 'string' || !entry.path || isAbsolute(entry.path) || entry.path.includes('\\') || entry.path.split('/').some(p => !p || p === '.' || p === '..') || excluded(entry.path.split('/')[0]!) || paths.has(entry.path) || !['file', 'directory'].includes(entry.kind) || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777)
            throw invalid();
        paths.add(entry.path);
        let parent = dirname(entry.path);
        while (parent !== '.') {
            if (!manifest.entries.some(e => e.path === parent && e.kind === 'directory'))
                throw invalid();
            parent = dirname(parent);
        }
        // lstat every ancestor; never follow an archive symlink out of the manifest root.
        let cursor = join(archivePath, 'files');
        if (!(await lstat(cursor)).isDirectory() || (await lstat(cursor)).isSymbolicLink())
            throw invalid();
        for (const part of entry.path.split('/')) {
            cursor = join(cursor, part);
            if ((await lstat(cursor)).isSymbolicLink())
                throw invalid();
        }
        const info = await lstat(cursor);
        if (entry.kind === 'directory' ? !info.isDirectory() : !info.isFile() || entry.sha256 !== await digest(cursor))
            throw invalid();
    }
    if (!paths.has('config.json') || !paths.has('control.sqlite'))
        throw invalid();
    const config = await readConfig(join(archivePath, 'files'));
    if (config?.instanceId !== manifest.instanceId)
        throw invalid();
    inspectControl(join(archivePath, 'files', 'control.sqlite'));
    return manifest;
}
/** Restore only into an empty destination. Interrupted restores remain explicitly quarantined. */
export async function restoreOffline(input: {
    archivePath: string;
    stateDir: string;
    originalInstanceFenced: boolean;
}): Promise<void> {
    if (input.originalInstanceFenced !== true)
        throw new AppError('FENCING_REQUIRED', 'Positively fence the original instance and its descendants before restoring its identity');
    const stateDir = await canonicalPath(resolve(input.stateDir));
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lock = await acquireLock(stateDir, 'offline-restore');
    try {
        if ((await readdir(stateDir)).some(name => !excluded(name)))
            throw new AppError('RESTORE_NOT_EMPTY', 'Restore requires an empty destination');
        const archivePath = await realpath(resolve(input.archivePath));
        if (inside(stateDir, archivePath) || inside(archivePath, stateDir))
            throw new AppError('INVALID_BACKUP_PATH', 'Archive and restore destination must be separate');
        const manifest = await validateArchive(archivePath);
        const config = await readConfig(join(archivePath, 'files'));
        if (!config)
            throw invalid();
        await validateStatePlacement({ stateDir, vaultDir: config.vaultDir });
        await durableWrite(join(stateDir, 'restore-incomplete.json'), { archivePath });
        await syncDir(stateDir);
        for (const entry of manifest.entries.filter(e => e.kind === 'directory').sort((a, b) => a.path.split('/').length - b.path.split('/').length))
            await mkdir(join(stateDir, entry.path), { mode: 0o700 });
        for (const entry of manifest.entries.filter(e => e.kind === 'file')) {
            if (['restore-incomplete.json', 'restore-quarantine.json'].includes(entry.path))
                continue;
            const target = join(stateDir, entry.path);
            await copyFile(join(archivePath, 'files', entry.path), target);
            await chmod(target, 0o600 | (entry.mode & 0o100));
            if (await digest(target) !== entry.sha256)
                throw invalid();
            await syncFile(target);
        }
        await durableWrite(join(stateDir, 'restore-quarantine.json'), { format: 1, instanceId: manifest.instanceId, sourceStateDir: manifest.sourceStateDir, createdAt: manifest.createdAt, restoredAt: new Date().toISOString(), originalInstanceFenced: true });
        for (const entry of manifest.entries.filter(e => e.kind === 'directory').reverse())
            await syncDir(join(stateDir, entry.path));
        await syncDir(stateDir);
        await rm(join(stateDir, 'restore-incomplete.json'));
        await syncDir(stateDir);
    }
    finally {
        await lock.release();
    }
}
