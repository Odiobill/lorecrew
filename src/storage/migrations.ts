import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../contracts/base.js';
export const SCHEMA_VERSION = 2;
export function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > SCHEMA_VERSION) throw new AppError('SCHEMA_TOO_NEW', 'This control store requires a newer Lorecrew version', { version, supported: SCHEMA_VERSION });
  if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
    const source = db.location();
    if (!source) throw new AppError('MIGRATION_BACKUP_REQUIRED', 'Existing in-memory schemas cannot be migrated without a recoverable backup');
    const destination = `${source}.pre-migration-${version}-${randomUUID()}.sqlite`;
    db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
    chmodSync(destination, 0o600);
    for (const path of [destination, dirname(destination)]) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  }
  if (version === 0) {
    const fresh=!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind, id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=${fresh?2:1};
      COMMIT;`);
  }
}
