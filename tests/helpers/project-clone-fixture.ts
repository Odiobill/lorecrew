import {afterEach} from 'vitest';
import {join} from 'node:path';
import {gitVaultFixture} from './git-vault.js';
import {ensureLocalAuthority} from '../../src/projects/authority-domain.js';
import {openProjectCatalog} from '../../src/projects/catalog.js';
import {openProjectWorkflows} from '../../src/projects/workflows.js';
const closes:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
export async function cloneFixture(empty=false){const f=await gitVaultFixture();closes.push(f.close);await ensureLocalAuthority(f.ctx,f.identity,'authority');await openProjectCatalog(f).register({projectId:'recorded',title:'Recorded title',repositoryAliases:['fork:opaque']},'record');await f.gitAt(['add','.lorecrew']);await f.gitAt(['-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','Catalog']);const other=await f.device('foreign');let url=join(f.root,'repo');if(empty){url=join(f.root,'empty.git');await f.git.run(f.root,['init','--bare','--initial-branch=main',url]);}const selection={mode:'catalog-clone' as const,projectId:'recorded',url,parentPath:f.root,folderName:'selected',acknowledgeOpaque:true};return {f,other,selection,flow:openProjectWorkflows({...other,git:f.git})};}
