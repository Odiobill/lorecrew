import { gzipSync } from 'node:zlib';

// Hand-built ustar fixture: independent of the installer's read-only tar scanner.
export function makeInstallerArchive(version = '0.1.0-preview.1', mode = 'success') {
  const metadata = {name: mode === 'invalid' ? 'other' : 'lorecrew', version, private:true, type:'module', bin:{lorecrew:'dist/cli.js'}, engines:{node:'>=24 <25',npm:'>=11 <12'}, dependencies:{'@earendil-works/pi-durable':'1.4.0','@earendil-works/pi-ai':'1.4.0'}};
  const shrinkwrap = {name:'lorecrew',version,lockfileVersion:3,...mode === 'large-shrinkwrap' ? {description:'x'.repeat(70000)} : {},packages:{'':{...metadata},'node_modules/@earendil-works/pi-durable':{version:'1.4.0'},'node_modules/@earendil-works/pi-ai':{version:'1.4.0'}}};
  const files = {'package.json':JSON.stringify(metadata)};
  if (mode !== 'missing-shrinkwrap') files['npm-shrinkwrap.json'] = JSON.stringify(shrinkwrap);
  const blocks = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value), header = Buffer.alloc(512);
    header.write('package/' + name, 0); header.write('0000644\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136); header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257); header.write('00',263);
    const checksum = header.reduce((sum,b)=>sum+b,0); header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148);
    blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));
  return {bytes:gzipSync(Buffer.concat(blocks)), metadata, shrinkwrap};
}
