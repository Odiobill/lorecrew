import {dailyPreview} from './daily-preview.js';
const crew=await dailyPreview();let closed=false;
const tick=setInterval(()=>{void crew.schedules.tick(new Date().toISOString()).catch(e=>console.error('Preview scheduler:',e.message));},10_000);
async function close(){if(closed)return;closed=true;clearInterval(tick);await crew.close();console.log('M5 preview stopped; disposable data removed.');}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
console.log('\nLorecrew M5 — disposable daily-use and PWA preview');
console.log('Open: '+crew.url+'/#inbox');
console.log('One-use login secret: '+crew.secret);
console.log('Scripted model responses: arbitrary conversation text gets a fixed Ada reply.');
console.log('The task objective "Improve team greeting" runs the scripted decision/delegation journey.');
console.log('Public sources are fixtures ONLY. Supported: https://github.com/example/tools or https://skills.sh/example/tools/careful-review');
console.log('Ambiguous choices: https://github.com/example/multiple; blocked binary: https://github.com/example/unsupported');
console.log('Other external URLs are not supported fixture inputs. No live GitHub or model calls.');
console.log('Includes a pending decision, completed/failed tasks, a disabled Rome routine, contested lesson, evidence, remote report, active skill and old pin.');
console.log('Enabling a routine schedules scripted work while this preview host runs. Ctrl+C removes disposable data.\n');
