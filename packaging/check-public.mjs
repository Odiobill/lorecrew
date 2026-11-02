#!/usr/bin/env node
import publicFiles from './public-files.json' with {type:'json'};
import {lstat,readFile,readdir} from 'node:fs/promises';
import {resolve,relative,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ignored=new Set(['.git','node_modules','dist','coverage','test-results','playwright-report','.superpowers','.tools']);
async function walk(root,path=root){const files=[];for(const entry of await readdir(path,{withFileTypes:true})){if(ignored.has(entry.name))continue;const p=join(path,entry.name);if(entry.isDirectory())files.push(...await walk(root,p));else files.push(relative(root,p).split('\\').join('/'));}return files;}
export async function checkPublic(root){root=resolve(root);const git=spawnSync('git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8'});const isRoot=git.status===0&&resolve(git.stdout.trim())===root;const listing=isRoot?spawnSync('git',['-C',root,'ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}):null;if(listing&&listing.status!==0)throw Error('PUBLIC_INVENTORY_FAILED');const files=listing?[...new Set(listing.stdout.split('\0').filter(Boolean))]:await walk(root),issues=[];let checked=0;
 for(const name of files){const p=resolve(root,name);if(p!==root&&!p.startsWith(root+'/')){issues.push({code:'PUBLIC_PATH_ESCAPE',path:name});continue;}let info;try{info=await lstat(p);}catch(error){if(error.code==='ENOENT')continue;throw error;}if(!info.isFile()){issues.push({code:'PUBLIC_SYMLINK_OR_SPECIAL_FILE',path:name});continue;}checked++;
  if(/^docs\/(operations|superpowers)(\/|$)/.test(name)||/(^|\/)(\.superpowers|\.codex|\.tools|\.artifacts|test-results|playwright-report|coverage)(\/|$)/.test(name)||/^docs\/.*(?:-evidence\.|-review\.|-plan\.)/.test(name))issues.push({code:'PUBLIC_INTERNAL_MATERIAL',path:name});
  if(name.startsWith('docs/')&&!publicFiles.guides.includes(name))issues.push({code:'PUBLIC_UNAPPROVED_DOCUMENTATION',path:name});
  if(name.startsWith('website/assets/')&&![...publicFiles.siteAssets,...publicFiles.sourceOnlyAssets].includes(name.slice('website/assets/'.length)))issues.push({code:'PUBLIC_UNAPPROVED_ASSET',path:name});
  if((name.endsWith('.md')||name.startsWith('website/'))&&/\.(md|html|js|mjs|css|json|svg|txt)$/.test(name)){const text=await readFile(p,'utf8');if(/\/(?:home|Users)\/[^/\s]+\/(?:\.codex|\.local\/share\/lorecrew-preview-evidence)/.test(text)||/\/(?:home|Users)\/[^/\s]+(?:\/|$)/.test(text)||/run-2026\d{4}-(?:thinking|git-centric|preview|public-docs)/.test(text))issues.push({code:'PUBLIC_PRIVATE_PATH',path:name});}
 }
 return {ok:issues.length===0,checked,issues};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){try{const args=process.argv.slice(2);if(args.length&&!(args.length===2&&args[0]==='--root'))throw Error('Usage: check-public.mjs [--root PATH]');const result=await checkPublic(args[1]??resolve('.'));if(!result.ok){console.error(JSON.stringify(result,null,2));process.exitCode=1;}else console.log(JSON.stringify(result));}catch(error){console.error(error.message);process.exitCode=1;}}
