import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,readdir,rm,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const roots=[];afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function root(){const p=await realpath(await mkdtemp(join(tmpdir(),'lorecrew-site-build-')));roots.push(p);return p;}
function build(out,base='/lorecrew/'){return spawnSync(process.execPath,['website/build.mjs','--out',out,'--base',base,'--origin','https://odiobill.github.io'],{cwd:resolve('.'),env:process.env,encoding:'utf8',maxBuffer:8*1024*1024});}
async function htmlFiles(path){const out=[];for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())out.push(...await htmlFiles(p));else if(p.endsWith('.html'))out.push(p);}return out;}
test('builds reading-ready home and every guide at root and GitHub repository prefixes',async()=>{for(const base of ['/','/lorecrew/']){const out=join(await root(),'site'),r=build(out,base);assert.equal(r.status,0,r.stderr);const home=await readFile(join(out,'index.html'),'utf8');assert.match(home,/<h1[ >]/);assert.ok(home.includes(base+'docs/getting-started/'));assert.ok(home.includes('https://github.com/Odiobill/lorecrew'));assert.ok(!home.includes('/home/'));for(const file of (await readdir('docs')).filter(f=>f.endsWith('.md'))){const page=await readFile(join(out,'docs',file.slice(0,-3),'index.html'),'utf8');assert.match(page,/<main[ >]/);assert.ok(page.includes('<h1'));}const index=JSON.parse(await readFile(join(out,'search-index.json'),'utf8'));assert.ok(index.some(p=>p.url===base+'docs/projects/'));assert.ok(!index.some(p=>/superpowers|operations|evidence/.test(p.url)));assert.ok((await readFile(join(out,'sitemap.xml'),'utf8')).includes('https://odiobill.github.io'+base));await readFile(join(out,'.nojekyll'));await readFile(join(out,'404.html'));}});
test('all generated same-origin links and fragment targets exist under the public prefix',async()=>{const out=join(await root(),'site'),r=build(out);assert.equal(r.status,0,r.stderr);for(const file of await htmlFiles(out)){const html=await readFile(file,'utf8');for(const match of html.matchAll(/(?:href|src)="([^"]+)"/g)){const url=match[1].replaceAll('&amp;','&');if(/^(https?:|mailto:|data:)/.test(url))continue;let path,hash;if(url.startsWith('#')){path=file;hash=url.slice(1);}else{assert.ok(url.startsWith('/lorecrew/'),file+': '+url);const parts=url.slice('/lorecrew/'.length).split('#');path=join(out,decodeURIComponent(parts[0].split('?')[0]));if(path.endsWith('/')||url.split('#')[0].endsWith('/'))path=join(path,'index.html');hash=parts[1];}const target=await readFile(path);if(hash)assert.ok(target.toString().includes('id="'+decodeURIComponent(hash)+'"'),file+': missing '+url);}}});
test('rejects unsafe base paths before creating output',async()=>{const out=join(await root(),'site');for(const base of ['//outside.test/','/../secret/','/%2e%2e/secret/','/crew\\escape/','/"><script>/']){const r=build(out,base);assert.equal(r.status,1);assert.match(r.stderr,/UNSAFE_BASE/);}});
test('refuses to clear a nonempty directory it did not generate',async()=>{const out=await root(),sentinel=join(out,'keep-me.txt');await writeFile(sentinel,'Unrelated user content');const r=build(out);assert.equal(r.status,1);assert.match(r.stderr,/OUTPUT_NOT_GENERATED/);assert.equal(await readFile(sentinel,'utf8'),'Unrelated user content');});
test('publishes only approved visitor assets even when private local assets are Git-ignored',async()=>{
 const probe=resolve('website/assets/.env.public-boundary-probe');
 await writeFile(probe,'SYNTHETIC_PRIVATE_ASSET=do-not-publish\n',{flag:'wx'});
 try{const out=join(await root(),'site'),r=build(out);assert.equal(r.status,0,r.stderr);
  assert.deepEqual((await readdir(join(out,'assets'))).sort(),['logo.svg','site.css','site.js','social-card.png']);
 }finally{await rm(probe);}
});
test('default production build uses lorecrew.dev at the domain root across pages and discovery files',async()=>{
 const out=join(await root(),'site');
 const r=spawnSync(process.execPath,['website/build.mjs','--out',out],{cwd:resolve('.'),env:process.env,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 const home=await readFile(join(out,'index.html'),'utf8');
 assert.ok(home.includes('rel="canonical" href="https://lorecrew.dev/"'));
 assert.ok(home.includes('href="/docs/getting-started/"'));
 assert.ok(home.includes('content="https://lorecrew.dev/assets/social-card.png"'));
 for(const file of await htmlFiles(out)){
  const html=await readFile(file,'utf8');assert.ok(!html.includes('https://odiobill.github.io'));assert.ok(!html.includes('href="/lorecrew/'));assert.ok(!html.includes('src="/lorecrew/'));
 }
 assert.ok((await readFile(join(out,'sitemap.xml'),'utf8')).includes('https://lorecrew.dev/docs/projects/'));
 assert.ok((await readFile(join(out,'robots.txt'),'utf8')).includes('https://lorecrew.dev/sitemap.xml'));
 assert.ok(JSON.parse(await readFile(join(out,'search-index.json'),'utf8')).every(doc=>doc.url.startsWith('/docs/')));
});
