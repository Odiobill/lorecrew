import {afterEach,expect,it} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const roots:string[]=[];afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(){const root=await mkdtemp(join(tmpdir(),'lorecrew-public-contract-'));roots.push(root);await mkdir(join(root,'docs'));await writeFile(join(root,'README.md'),'# Public project\n');await writeFile(join(root,'docs/getting-started.md'),'# Getting started\n');return root;}
const guard=(root:string)=>spawnSync(process.execPath,['packaging/check-public.mjs','--root',root],{cwd:resolve('.'),env:process.env,encoding:'utf8'});
it('public guard accepts a public-only source tree',async()=>{const r=guard(await fixture());expect(r.status,r.stderr).toBe(0);});
it('public guard refuses internal planning and private host paths',async()=>{const root=await fixture();await mkdir(join(root,'docs/superpowers'));await writeFile(join(root,'docs/superpowers/plan.md'),'# Private execution plan\n');let r=guard(root);expect(r.status).toBe(1);expect(r.stderr).toContain('PUBLIC_INTERNAL_MATERIAL');await rm(join(root,'docs/superpowers'),{recursive:true});await writeFile(join(root,'docs/getting-started.md'),'# Guide\nPrivate location: /home/private-user/.codex/attachments/abc\n');r=guard(root);expect(r.status).toBe(1);expect(r.stderr).toContain('PUBLIC_PRIVATE_PATH');await writeFile(join(root,'docs/getting-started.md'),'# Guide\nPrivate location: /home/private-user/projects/personal\n');r=guard(root);expect(r.status).toBe(1);expect(r.stderr).toContain('PUBLIC_PRIVATE_PATH');});
it('actual npm archive excludes internal reports and ships user guides and MIT notice',()=>{const npm=process.env.npm_execpath;expect(npm,'Run through npm test so the active npm executable is known').toBeTruthy();const r=spawnSync(process.execPath,[npm!,'pack','--dry-run','--ignore-scripts','--offline','--json'],{env:process.env,encoding:'utf8',maxBuffer:16*1024*1024});expect(r.status,r.stderr).toBe(0);const files=JSON.parse(r.stdout)[0].files.map((f:{path:string})=>f.path) as string[];expect(files.filter(p=>p.startsWith('docs/operations/')||p.startsWith('docs/superpowers/')||p.startsWith('docs/')&&/evidence|screenshots|review-disposition/.test(p))).toEqual([]);expect(files).toContain('LICENSE');expect(files).toContain('README.md');expect(files).toContain('docs/getting-started.md');expect(files.some(p=>p.startsWith('website/'))).toBe(false);});
it('public guard rejects every unapproved guide and tracked private artifact',async()=>{
 for(const name of ['docs/test-results.md','docs/build-report.md','.artifacts/timing.log']){
  const root=await fixture();await mkdir(join(root,'.artifacts'),{recursive:true});await writeFile(join(root,name),'Synthetic internal record\n');
  const r=guard(root);expect(r.status,name).toBe(1);
 }
});
it('actual npm archive contains exactly the approved guides even when reports are present',async()=>{
 const reports=['docs/test-results.md','docs/build-report.md'],created:string[]=[];
 try{
  for(const path of reports){await writeFile(path,'Synthetic internal report\n',{flag:'wx'});created.push(path);}
  const r=spawnSync(process.execPath,[process.env.npm_execpath!,'pack','--dry-run','--ignore-scripts','--offline','--json'],{env:process.env,encoding:'utf8',maxBuffer:16*1024*1024});expect(r.status,r.stderr).toBe(0);
  const expected=['getting-started','installation','configuration','agents','projects','knowledge-and-skills','routines','multi-device','backup-and-recovery','security','troubleshooting','architecture','api-and-cli'].map(n=>'docs/'+n+'.md').sort();
  expect(JSON.parse(r.stdout)[0].files.map((f:{path:string})=>f.path).filter((p:string)=>p.startsWith('docs/')).sort()).toEqual(expected);
 }finally{for(const path of created)await rm(path);}
});
