import {stableId} from '../../src/runtime/admission.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {temporaryInstance} from './temp.js';
import {openInstance} from '../../src/instance/open.js';
import {openRepositories} from '../../src/repositories/service.js';
import {GitClient} from '../../src/git/client.js';
import {openSetupOwnership} from '../../src/setup/ownership.js';
// This historical format1 producer deliberately uses the retained raw protocol, not a current user entry adapter.
import {openOwnership} from '../../src/projects/ownership.js';
export async function legacyRepositoryFixture(){const f=await temporaryInstance();await writeFile(join(f.paths.vaultDir,'index.md'),'---\nokf_version: "0.2"\n---\n# Legacy\n');let ctx=await openInstance(f.paths);await ctx.close();const db=new DatabaseSync(join(f.paths.stateDir,'control.sqlite'));db.exec('PRAGMA user_version=1');db.close();ctx=await openInstance(f.paths);const git=new GitClient();const setup=openSetupOwnership({ctx,git});await setup.configure({mode:'standalone',expectedRevision:(await setup.read()).revision},'standalone');const ownership=openOwnership(ctx,git,(await ctx.store.read<{remote:string}>('fleet','assignments'))!.remote);await ownership.claim({id:'p',title:'p',repositoryKey:'fork:legacy/p'},'claim');const project=join(f.root,'project');await mkdir(project);await writeFile(join(project,'work.md'),'retained\n');await writeFile(join(project,'unselected'),'user');await ctx.store.transact(tx=>{tx.put('project-binding','p',{projectId:'p',path:project});const base={id:'workload:legacy-report',source:{kind:'workload',sessionId:'legacy-report',workloadId:'legacy'},title:'Historical report',sourcePaths:[],kind:'report',sessionId:'legacy-report'};const r1={...base,revision:'R1',content:{body:'first'}},r2={...base,revision:'R2',content:{body:'latest'}};tx.put('ui-inbox-seen','workload:legacy-report',{id:'workload:legacy-report',revision:'R1'});tx.put('inbox-result','workload:legacy-report',r2);tx.put('inbox-result-version',stableId('workload:legacy-report','R1'),r1);tx.put('inbox-result-version',stableId('workload:legacy-report','R2'),r2);});return {...f,ctx,project,repositories:openRepositories({state:ctx,git}),async close(){await ctx.close();await f.cleanup();}};}
