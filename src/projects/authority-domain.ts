import {readAuthorityMarker} from '../repositories/authority-marker.js';
import {AppError} from '../contracts/base.js';
import type {InstanceContext} from '../instance/open.js';
import type {Tx} from '../storage/store.js';
import type {AuthorityBinding,VaultIdentity} from '../repositories/types.js';
import {readVaultIdentity,type OriginJournal} from '../repositories/identity.js';
import {GitClient} from '../git/client.js';
import {openSetupOwnership} from '../setup/ownership.js';
import {inputHash} from '../repositories/inspect.js';
export interface AuthorityScope {domainId:string;epoch:number}
export function authorityScope(binding:AuthorityBinding):AuthorityScope{return {domainId:binding.domainId,epoch:binding.epoch};}
export function assertAuthorityScope(tx:Tx,scope:AuthorityScope|undefined){const binding=tx.get<AuthorityBinding>('authority-binding','current');if(!binding)return;if(binding.mode==='local'){const origin=tx.get<OriginJournal>('vault-origin',binding.vaultId);if(!origin||origin.identity.domainId!==binding.domainId||origin.identity.originInstanceId!==binding.originInstanceId||tx.get<{state:string}>('authority-bootstrap','current')?.state!=='ready')throw new AppError('AUTHORITY_NOT_LOCAL','Original private authority initialization is incomplete or missing');}if(tx.get('authority-promotion','pending')||tx.get('authority-retired',JSON.stringify([binding.domainId,binding.epoch]))||!scope||scope.domainId!==binding.domainId||scope.epoch!==binding.epoch)throw new AppError('AUTHORITY_RETIRED','Execution authority domain or epoch is no longer admitted');}
async function origin(ctx:InstanceContext,identity:VaultIdentity){const privateOrigin=await ctx.store.read<OriginJournal>('vault-origin',identity.vaultId);if(identity.originInstanceId!==ctx.instanceId||!privateOrigin||privateOrigin.path!==ctx.vaultDir||inputHash(privateOrigin.identity)!==inputHash(identity))throw new AppError('AUTHORITY_NOT_LOCAL','This clone can browse context; only the original authority can enable sharing and assign project execution');}
export async function assertAuthorityDomain(ctx:InstanceContext):Promise<AuthorityBinding>{
 const identity=await readVaultIdentity(ctx.vaultDir);const binding=await ctx.store.read<AuthorityBinding>('authority-binding','current');if(!binding||binding.vaultId!==identity.vaultId||binding.domainId!==identity.domainId)throw new AppError('AUTHORITY_NOT_LOCAL','No confirmed private authority binding for this vault');
 const marker=await readAuthorityMarker(ctx.vaultDir);
 if(!marker){
  // An older private backup cannot erase retirement by removing a mutable file,
  // switching to an older branch, or committing its deletion. Git history only
  // denies admission here; it never establishes a shared grant or new epoch.
  const history=binding.mode==='local'?await new GitClient().run(ctx.vaultDir,['--no-optional-locks','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','log','--all','--max-count=1','--format=%H','--','.lorecrew/authority.json']):undefined;
  if(binding.mode==='shared'||history?.exitCode!==0||history.stdout.trim())throw new AppError('AUTHORITY_RETIRED','Required retirement evidence is missing; committed history cannot be erased by a working-copy change');
 }
 if(marker&&(marker.vaultId!==binding.vaultId||marker.domainId!==binding.domainId||marker.epoch!==binding.epoch||binding.mode!=='shared'||marker.endpoint!==binding.remote))throw new AppError('AUTHORITY_RETIRED','Portable retirement evidence denies this old or mismatched private binding');await ctx.store.transact(tx=>assertAuthorityScope(tx,authorityScope(binding)));if(binding.mode==='local')await origin(ctx,identity);return binding;
}
export async function ensureLocalAuthority(ctx:InstanceContext,identity:VaultIdentity,requestId:string):Promise<AuthorityBinding>{
 if(ctx.store.repositoryFormat()!==2)throw new AppError('MIGRATION_REQUIRED','Stop and convert the existing control format before project setup');
 const actual=await readVaultIdentity(ctx.vaultDir);if(inputHash(actual)!==inputHash(identity))throw new AppError('AUTHORITY_NOT_LOCAL','Vault marker does not match the requested authority');
 const existing=await ctx.store.read<AuthorityBinding>('authority-binding','current');if(existing){if((await ctx.store.read<{state:string}>('authority-bootstrap','current'))?.state==='ready'||existing.mode==='shared')await assertAuthorityDomain(ctx);if(existing.mode==='shared')return existing;}
 await origin(ctx,identity);
 if(!existing&&await ctx.store.read('fleet','assignments'))throw new AppError('MIGRATION_REQUIRED','Existing grants require stopped domain adoption; authority is never replaced by setup');
 const binding:AuthorityBinding=existing??{version:2,vaultId:identity.vaultId,domainId:identity.domainId,originInstanceId:identity.originInstanceId,epoch:1,mode:'local',remote:''};
 await ctx.store.transact(tx=>{const pending=tx.get<AuthorityBinding>('authority-binding','current');if(pending&&inputHash(pending)!==inputHash(binding))throw new AppError('AUTHORITY_NOT_LOCAL','Another authority is configured');tx.put('authority-binding','current',binding);tx.put('authority-bootstrap','current',{requestId,domainId:binding.domainId,state:'preparing'});});
 const setup=openSetupOwnership({ctx,git:new GitClient()});const before=await setup.read();await setup.configure({mode:'standalone',expectedRevision:before.revision},'local-authority:'+binding.domainId);
 const fleet=(await ctx.store.read<{remote:string}>('fleet','assignments'))!;const confirmed={...binding,remote:fleet.remote};await ctx.store.transact(tx=>{tx.put('authority-binding','current',confirmed);tx.put('authority-bootstrap','current',{requestId,domainId:binding.domainId,state:'ready'});});return confirmed;
}
