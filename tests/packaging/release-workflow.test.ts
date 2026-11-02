import {it,expect} from 'vitest';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
it('actual CI packing commands produce parseable npm manifests from the built app',async()=>{
 const workflow=YAML.parse(await readFile('.github/workflows/ci.yml','utf8'));
 const step=workflow.jobs.verify.steps.find((s:{name?:string})=>s.name==='Inspect and install packed artifact');
 const commands=(step.run as string).split('\n').filter(line=>line.trim().startsWith('npm pack '));expect(commands).toHaveLength(2);
 const root=await mkdtemp(join(tmpdir(),'lorecrew-ci-pack-'));
 try{
  for(const command of commands){const r=spawnSync('/bin/bash',['-eu','-c',command],{env:{...process.env,RUNNER_TEMP:root},encoding:'utf8',timeout:60000});expect(r.status,r.stderr).toBe(0);}
  for(const filename of ['lorecrew-pack-files.json','lorecrew-pack.json']){
   const manifest=JSON.parse(await readFile(join(root,filename),'utf8'));expect(manifest[0]).toMatchObject({name:'lorecrew',version:'0.1.0-preview.3'});expect(manifest[0].filename).toMatch(/\.tgz$/);
  }
 }finally{await rm(root,{recursive:true,force:true});}
},120000);
