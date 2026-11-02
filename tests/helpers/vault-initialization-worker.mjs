import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { openState } from '../../src/instance/state.ts';
import { openVaultInitialization } from '../../src/setup/vault.ts';
const [root,action,phase]=process.argv.slice(2);const state=await openState({stateDir:join(root,'state')});const setup=openVaultInitialization(state);const target=join(root,'Lorecrew vault');
await fs.writeFile(join(root,'identity.json'),JSON.stringify({instanceId:state.instanceId}));
if(action==='pause'){
 const transact=state.store.transact.bind(state.store);let paused=false;state.store.transact=async fn=>{const result=await transact(fn);if(!paused&&(await state.store.read('vault-initialization','current'))?.phase===phase){paused=true;await fs.writeFile(join(root,'paused'),phase);await new Promise(()=>{});}return result;};
 if(phase==='mkdir'){const mkdir=fs.mkdir.bind(fs);fs.mkdir=async(...args)=>{const result=await mkdir(...args);if(String(args[0])===target){await fs.writeFile(join(root,'paused'),phase);await new Promise(()=>{});}return result;};syncBuiltinESMExports();}
 const choice={kind:'new',parentPath:root,folderName:'Lorecrew vault'},preview=await setup.preview(choice);await setup.confirm({choice,previewToken:preview.token,expectedRevision:preview.revision},'original-vault');
}else{
 const view=await setup.reconcile();assert.equal(view.instanceId,state.instanceId);if(phase==='mkdir'){assert.equal(view.phase,'initializing');assert.match(view.diagnostic,/unconfirmed|uncertain|changed|ownership/i);assert.equal(await fs.readFile(join(target,'unrelated'),'utf8'),'preserved');}
 else{assert.equal(view.phase,'ready',JSON.stringify(view));assert.equal(view.vaultDir,target);assert.equal(await fs.readFile(join(target,'index.md'),'utf8'),['scaffold','ready'].includes(phase)?'# Edited after crash\n':'---\nokf_version: "0.2"\n---\n# Knowledge vault\n');assert.equal((await state.store.list('vault.proposals')).length,0);}
 console.log(JSON.stringify({ok:true,phase,instanceId:state.instanceId}));
}
await state.close();
