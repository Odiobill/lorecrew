import { localTeam } from './local-team.js';
// Fresh setup with real local services and scripted model output. Never reads real credentials.
const coding=process.argv.includes('--coding');
const crew=await localTeam({emptyDefinitions:true,noFleet:true});
let closing=false;
async function close(){if(closing)return;closing=true;await crew.close();console.log('Setup preview closed; disposable state removed.');}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
console.log('\nLorecrew M2 — fresh '+(coding?'coding':'personal')+' setup preview');
console.log('Open: '+crew.url);console.log('One-use login secret: '+crew.secret);
if(coding){console.log('Enable project setup in the PWA. Browse the host folders or create a new project.');console.log('Disposable existing Git project: '+crew.ctx.vaultDir);}
console.log('Choose scripted · test-model for free deterministic replies. Other provider login prompts are fixture flows.\nNo real model requests. Press Ctrl+C to remove all preview data.\n');
