import { open, readFile, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from '../contracts/base.js';
export interface InstanceConfig { instanceId: string; vaultDir: string }
export async function readConfig(stateDir: string): Promise<InstanceConfig | undefined> {
  let text: string;
  try { text = await readFile(join(stateDir, 'config.json'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let config: unknown;
  try { config = JSON.parse(text); } catch { throw new AppError('INVALID_CONFIG', 'Invalid instance configuration'); }
  if (!config || typeof config !== 'object' || !('instanceId' in config) || typeof config.instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(config.instanceId) || !('vaultDir' in config) || typeof config.vaultDir !== 'string' || !isAbsolute(config.vaultDir)) throw new AppError('INVALID_CONFIG', 'Invalid instance configuration');
  return config as InstanceConfig;
}
export async function writeConfig(stateDir: string, config: InstanceConfig): Promise<void> {
  const temp = join(stateDir, `.config-${randomUUID()}.tmp`);
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(config, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try {
    await rename(temp, join(stateDir, 'config.json'));
    const dir = await open(stateDir, 'r'); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
}
