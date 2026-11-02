import type { InstanceContext } from '../instance/open.js';
import type { Vault } from '../vault/types.js';
import { inspectVaultStart } from '../vault/start.js';
import { listUsableAgents } from '../agents/resolve.js';
import { AppError } from '../contracts/base.js';
import type { SetupVaultView } from './types.js';
interface Entry {path:string;starterRequired:boolean;completed:boolean;kind:SetupVaultView['kind']}
/** Private entry provenance survives the first portable write. Legacy content is never guessed to be new. */
export function openSetupEntry({ctx,vault}:{ctx:InstanceContext;vault:Vault}){
 return {async read(completed:boolean){
  const existing=await ctx.store.read<Entry>('setup-entry','current');
  const configured=(await listUsableAgents(vault)).length>0;
  let initial:Entry|undefined;
  if(!existing){const start=await inspectVaultStart(ctx.vaultDir);initial={path:ctx.vaultDir,starterRequired:start.kind==='new',completed,kind:start.kind==='new'?'new':configured?'configured':'existing_incomplete'};}
  const saved=await ctx.store.transact(tx=>{let entry=tx.get<Entry>('setup-entry','current')??initial!;if(entry.path!==ctx.vaultDir)throw new AppError('VAULT_MISMATCH','Setup belongs to a different bound vault');if(completed&&!entry.completed)entry={...entry,completed:true};if(!tx.get('setup-entry','current')||completed&&!existing?.completed)tx.put('setup-entry','current',entry);return entry;});
  return {vault:{path:saved.path,kind:saved.starterRequired&&!saved.completed?'new' as const:configured?'configured' as const:'existing_incomplete' as const},entry:saved.starterRequired&&!saved.completed?'starter' as const:'workspace' as const};
 }};
}
