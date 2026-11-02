import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readFile,copyFile} from 'node:fs/promises';
const metadata=['manifest.webmanifest','icon.svg','icon-192.png','icon-512.png','icon-maskable-512.png'];
export default defineConfig(({mode})=>{
 let outputDir=resolve('dist/web');
 return {root:'web',plugins:[react(),{
  name:'public-pwa-metadata',
  configResolved(config){outputDir=resolve(config.root,config.build.outDir);},
  async generateBundle(_options,bundle){
   // Any built client/metadata change produces a new worker, without timestamps.
   const hash=createHash('sha256').update(mode);
   for(const [name,item] of Object.entries(bundle).sort(([a],[b])=>a.localeCompare(b)))if(name!=='sw.js')hash.update(name).update(item.type==='chunk'?item.code:item.source);
   for(const file of metadata)hash.update(await readFile(resolve('web',file)));
   const sw=bundle['sw.js'];if(sw?.type==='chunk')sw.code=sw.code.replaceAll('__LORECREW_BUILD__',hash.digest('hex').slice(0,24));
  },
  async closeBundle(){await Promise.all(metadata.map(file=>copyFile(resolve('web',file),resolve(outputDir,file))));},
 }],build:{outDir:'../dist/web',emptyOutDir:true,rolldownOptions:{input:{index:resolve('web/index.html'),sw:resolve('web/sw.ts')},output:{entryFileNames:chunk=>chunk.name==='sw'?'sw.js':'assets/[name]-[hash].js'}}}};
});
