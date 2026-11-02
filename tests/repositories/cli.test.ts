import {expect,it} from 'vitest';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {gitVaultFixture} from '../helpers/git-vault.js';
import {gitProject} from '../helpers/git-project.js';
import {ensureLocalAuthority} from '../../src/projects/authority-domain.js';
import {runCli} from '../../src/cli.js';
it('uses the normal offline lock and shared native repository workflow with resume disabled',async()=>{const f=await gitVaultFixture();try{await ensureLocalAuthority(f.ctx,f.identity,'cli-authority');await expect(runCli(['repository','status','--state-dir',f.ctx.stateDir])).rejects.toMatchObject({code:'INSTANCE_BUSY'});const source=await gitProject(join(f.root,'code-origin')),input=join(f.root,'reviewed-clone.json');await writeFile(input,JSON.stringify({action:'clone',projectId:'code',title:'Code',url:source,parentPath:f.root,folderName:'code-checkout'}));const state=f.ctx.stateDir;await f.ctx.close();expect(await runCli(['repository','status','--state-dir',state])).toMatchObject({state:'local_only'});expect(await runCli(['repository','clone','--state-dir',state,'--input',input,'--request-id','native-clone'])).toMatchObject({result:{projectId:'code',state:'ready'}});expect(await runCli(['repository','status','--state-dir',state,'--repository','project','--id','code'])).toHaveProperty('state');expect(await runCli(['sharing','status','--state-dir',state])).toMatchObject({state:'local'});}finally{await f.close();}},30000);
