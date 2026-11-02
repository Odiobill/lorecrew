import {skillPreview} from './skill-preview.js';
const crew=await skillPreview();let closed=false;
async function close(){if(closed)return;closed=true;await crew.close();console.log('M4 preview stopped; disposable data removed.');}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
console.log('\nLorecrew M4 — disposable skill management preview');
console.log('Open: '+crew.url+'/#skills/'+encodeURIComponent(crew.candidatePath));
console.log('One-use login secret: '+crew.secret);
console.log('Public source fixtures: https://github.com/example/tools or https://skills.sh/example/tools/careful-review');
console.log('Ambiguous choices: https://github.com/example/multiple');
console.log('Unsupported bundle: https://github.com/example/unsupported');
console.log('main is advanced to upstream v2. An active v1 and an old session pin remain.');
console.log('Old pin: '+JSON.stringify(crew.oldPin));
console.log('All GitHub responses and model providers are scripted; no live downloads or model charges. Ctrl+C cleans up.\n');
