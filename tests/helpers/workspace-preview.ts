import { localTeam } from './local-team.js';
import { fauxAssistantMessage } from './scripted-provider.js';

// A disposable local UX preview. Model output is scripted; all instance state is isolated.
const crew=await localTeam({modelIds:['test-model','alternate-model']});
let closing=false;
async function close(){
  if(closing)return;closing=true;
  await crew.close();console.log('Preview closed. Its disposable data has been removed.');
}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
const response=`## A clear starting point

Let's give the week a little structure.

| Focus | Next step |
| --- | --- |
| Build | Choose one meaningful outcome |
| Learn | Capture what worked and why |
| Review | Leave space to adjust the plan |

### Keep it practical

- Start with the smallest useful version.
- Put the important decisions in writing.
- Review the result before adding more.

This is a **scripted preview**, running through Pi Durable with disposable local data. Use your configured instance for real model work.

\`\`\`ts
const nextStep = 'Make something useful';
\`\`\`
`;
crew.faux.setResponses(Array.from({length:100},()=>fauxAssistantMessage(response)));
try {
  await crew.vault.propose({id:'m3-preview-group-skill',path:'skills/engineering-guide.md',expectedRevision:null,actor:'fixture:preview',content:'---\n'+JSON.stringify({type:'Skill',description:'An engineering working agreement for the disposable preview',lorecrew:{skill:{schemaVersion:1,name:'working-agreement',scope:'group',scopeId:'group-engineering',status:'active',resources:[]}}})+'\n---\nKeep work focused, explain decisions and verify results.\n'});
  const session=await crew.runtime.createSession({requestId:'workspace-preview-welcome',agentId:'agent-ada'});
  await crew.runtime.submit({sessionId:session.id,requestId:'workspace-preview-first-message',text:'Help me make a thoughtful plan for the week.'});
  console.log('\nLorecrew M3 — disposable scripted preview');
  console.log('Open: '+crew.url+'/#conversations/'+session.id);
  console.log('One-use login secret: '+crew.secret);
  console.log('No real model requests. Changes are discarded when you press Ctrl+C.\n');
}catch(error){await close();throw error;}
