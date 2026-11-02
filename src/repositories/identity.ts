import {randomUUID} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {AppError} from '../contracts/base.js';
import type {StateContext} from '../instance/state.js';
import {GitClient} from '../git/client.js';
import type {VaultIdentity} from './types.js';
import {inspectRepository} from './inspect.js';
export interface OriginJournal {identity:VaultIdentity;path:string;requestId:string}
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function validateVaultIdentity(value:unknown):VaultIdentity{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError('INVALID_VAULT_IDENTITY','Vault identity metadata is invalid');
 const v=value as VaultIdentity;if(v.version!==1||!uuid(v.vaultId)||!uuid(v.domainId)||!uuid(v.originInstanceId)||Object.keys(v).some(k=>!['version','vaultId','domainId','originInstanceId'].includes(k)))throw new AppError('INVALID_VAULT_IDENTITY','Vault identity metadata is invalid');return v;
}
export async function readVaultIdentity(path:string):Promise<VaultIdentity>{try{if(await realpath(path)!==path)throw Error();const file=join(path,'.lorecrew','vault.json');for(const p of [join(path,'.lorecrew'),file])if((await lstat(p)).isSymbolicLink())throw Error();return validateVaultIdentity(JSON.parse(await readFile(file,'utf8')));}catch(e){if(e instanceof AppError)throw e;throw new AppError('INVALID_VAULT_IDENTITY','Select a recognized Git vault or use the stopped migration command');}}
/** Allocated by an explicit new-vault action, before filesystem effects or portable grants. */
export async function planVaultIdentity(state:StateContext,path:string,requestId:string):Promise<VaultIdentity>{
 if(resolve(path)!==path||!requestId)throw new AppError('INVALID_REQUEST','Vault creation requires an absolute destination and stable request');
 const prior=await state.store.read<OriginJournal>('vault-origin-request',requestId);if(prior){if(prior.path!==path)throw new AppError('IDEMPOTENCY_CONFLICT','Vault creation destination changed');return prior.identity;}
 const inspection=await inspectRepository(new GitClient(),path);
 if(inspection.kind!=='empty'&&!(inspection.kind==='git'&&inspection.snapshot?.head===null&&(await readdir(path)).every(n=>n==='.git')))throw new AppError('MIGRATION_REQUIRED','Existing vault identity must be preserved through stopped adoption');
 return state.store.transact(tx=>{const existing=tx.get<OriginJournal>('vault-origin-request',requestId);if(existing)return existing.identity;const pending=tx.get<OriginJournal>('vault-origin-path',path);if(pending)throw new AppError('IDEMPOTENCY_CONFLICT','This destination has another initialization identity');const identity:VaultIdentity={version:1,vaultId:randomUUID(),domainId:randomUUID(),originInstanceId:state.instanceId};const journal:OriginJournal={identity,path,requestId};tx.put('vault-origin',identity.vaultId,journal);tx.put('vault-origin-request',requestId,journal);tx.put('vault-origin-path',path,journal);return identity;});
}
