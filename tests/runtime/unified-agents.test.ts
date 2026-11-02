import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
it.each(['tools','missing','permissions'])('Piren uses truthful project-free context: %s',async scenario=>{
 const root=await mkdtemp(join(tmpdir(),'lorecrew-unified-'));roots.push(root);
 const result=await new Promise<{code:number|null;output:string}>(done=>{const child=spawn(process.execPath,[resolve('node_modules/tsx/dist/cli.mjs'),resolve('tests/helpers/unified-runtime-worker.mjs'),resolve('.'),root,scenario],{env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),LORECREW_AUTH_FILE:join(root,'auth.json'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('close',code=>done({code,output}));});
 expect(result.code,result.output).toBe(0);expect(result.output).toContain('"ok":true');
},20_000);

it.each(['cancel','project','legacy'])('retains unified installed-proof contract in source fixture: %s',async scenario=>{
 const root=await mkdtemp(join(tmpdir(),'lorecrew-unified-proof-'));roots.push(root);
 const result=await new Promise<{code:number|null;output:string}>(done=>{const child=spawn(process.execPath,['--import',resolve('node_modules/tsx/dist/loader.mjs'),resolve('tests/helpers/unified-runtime-worker.mjs'),resolve('.'),root,scenario],{env:{PATH:'/usr/bin:/bin',HOME:join(root,'home'),LORECREW_AUTH_FILE:join(root,'auth.json'),GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.on('close',code=>done({code,output}));});
 expect(result.code,result.output).toBe(0);expect(result.output).toContain('"proof":"'+scenario+'"');
},30_000);
