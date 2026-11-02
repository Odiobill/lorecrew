import {readFile,writeFile,mkdir,readdir,copyFile,rm,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {docs} from './lib/content.mjs';
import publicFiles from '../packaging/public-files.json' with {type:'json'};
import {normalizeBase,guidePage,escape} from './lib/render.mjs';
import {home,docsHome,notFound} from './lib/pages.mjs';
import {checkPublic} from '../packaging/check-public.mjs';
const site=dirname(fileURLToPath(import.meta.url)),repo=dirname(site),args=process.argv.slice(2),options={base:'/lorecrew/',origin:'https://odiobill.github.io',out:join(site,'dist')};
try{
 for(let i=0;i<args.length;i+=2){if(!['--base','--origin','--out'].includes(args[i])||!args[i+1])throw Error('Usage: build.mjs [--base PATH] [--origin URL] [--out DIRECTORY]');options[args[i].slice(2)]=args[i+1];}
 const base=normalizeBase(options.base),origin=new URL(options.origin);if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('UNSAFE_ORIGIN');
 const out=resolve(options.out);for(const p of [repo,join(repo,'src'),join(repo,'web'),join(repo,'docs'),join(repo,'tests'),join(repo,'packaging'),join(site,'assets'),join(site,'lib')])if(out===p||p.startsWith(out+'/')||out.startsWith(p+'/')&&p!==repo)throw Error('UNSAFE_OUTPUT');
 const policy=await checkPublic(repo);if(!policy.ok)throw Error('PUBLIC_SOURCE_REJECTED: '+JSON.stringify(policy.issues));
 if(JSON.stringify(docs.map(d=>'docs/'+d.file).sort())!==JSON.stringify([...publicFiles.guides].sort()))throw Error('PUBLIC_GUIDE_INVENTORY_MISMATCH');
 const sources=await Promise.all(docs.map(async d=>({doc:d,source:await readFile(join(repo,'docs',d.file),'utf8')})));const pages=[['index.html',home(base,origin.origin)],['docs/index.html',docsHome(base,origin.origin)],['404.html',notFound(base,origin.origin)],...sources.map(({doc,source})=>['docs/'+doc.slug+'/index.html',guidePage(doc,source,base,origin.origin)])];
 let info;try{info=await lstat(out);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(info){if(!info.isDirectory()||info.isSymbolicLink()||await realpath(out)!==out)throw Error('UNSAFE_OUTPUT');const entries=await readdir(out);if(entries.length){const marker=await readFile(join(out,'.lorecrew-site-output'),'utf8').catch(()=>null);if(marker!=='lorecrew-public-site-v1\n')throw Error('OUTPUT_NOT_GENERATED');await rm(out,{recursive:true});}}
 await mkdir(out,{recursive:true});await writeFile(join(out,'.lorecrew-site-output'),'lorecrew-public-site-v1\n');for(const [path,text]of pages){await mkdir(dirname(join(out,path)),{recursive:true});await writeFile(join(out,path),text);}
 await mkdir(join(out,'assets'));for(const asset of publicFiles.siteAssets)await copyFile(join(site,'assets',asset),join(out,'assets',asset));await writeFile(join(out,'.nojekyll'),'');
 const index=sources.map(({doc,source})=>({title:doc.title,description:doc.description,url:base+'docs/'+doc.slug+'/',text:source.replace(/```[\s\S]*?```/g,' ').replace(/[#*`|\[\]()]/g,' ').replace(/\s+/g,' ').slice(0,14000)}));await writeFile(join(out,'search-index.json'),JSON.stringify(index));
 const urls=['','docs/',...docs.map(d=>'docs/'+d.slug+'/')].map(path=>`<url><loc>${escape(new URL(base+path,origin.origin).href)}</loc></url>`).join('');await writeFile(join(out,'sitemap.xml'),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);await writeFile(join(out,'robots.txt'),`User-agent: *\nAllow: /\nSitemap: ${new URL(base+'sitemap.xml',origin.origin).href}\n`);console.log(JSON.stringify({out,base,pages:pages.length,guides:docs.length,origin:origin.origin}));
}catch(error){console.error(error.message);process.exitCode=1;}
