import { createHash } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { stringify } from 'yaml';
import type { HistoryEntry, SessionRecord } from '../runtime/types.js';
import type { InstanceContext } from '../instance/open.js';
import type { RedactionPolicy } from './types.js';
import { redact } from './redact.js';
export const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export const component=(value:string)=>encodeURIComponent(value).replace(/\./g,'%2E');
export const relativeLink=(from:string,to:string)=>posix.relative(posix.dirname(from),to).split('/').map(part=>part==='..'?part:encodeURIComponent(part)).join('/');
export function document(type:string,title:string,metadata:Record<string,unknown>,body:string):string {
  return `---\n${stringify({type,title,lorecrew:metadata})}---\n${body}\n`;
}
function printable(entry:HistoryEntry):string {
  const data=entry.data;
  if(!data||typeof data!=='object'||Array.isArray(data))return typeof data==='string'?data:JSON.stringify(data,null,2);
  const content=data.content;
  if(!Array.isArray(content))return JSON.stringify(data,null,2);
  const text=content.map(part=>{
    if(part&&typeof part==='object'&&!Array.isArray(part)) {
      if(part.type==='text'&&typeof part.text==='string')return part.text;
      if(part.type==='toolCall')return `Tool: ${part.name}\nArguments:\n${JSON.stringify(part.arguments,null,2)}`;
    }
    return '';
  }).filter(Boolean).join('\n\n');
  return `${typeof data.toolName==='string'?`Tool: ${data.toolName}\n`:''}${text}${data.isError===true?'\nTool reported an error.':''}`;
}
export async function historyDocument(ctx:InstanceContext,record:SessionRecord,entry:HistoryEntry,policy:RedactionPolicy,sequence:number):Promise<{path:string;content:string;held:boolean}> {
  const path=`history/${component(ctx.instanceId)}/${component(record.session.id)}/${hash(entry.id)}.md`;
  const source=printable(entry);
  // Detect before truncation, and include provenance fields in the same policy.
  const checked=redact(JSON.stringify({entry,agentId:record.session.agentId,agentRevision:record.session.agentRevision}),policy);
  let body=checked.held?'Export held: possible_secret. Content remains local pending review.':source;
  if(!checked.held && entry.kind==='tool' && source.length>4000) {
    const id=hash(`${record.session.id}:${entry.id}`);const dir=join(ctx.stateDir,'artifacts','exports');await mkdir(dir,{recursive:true,mode:0o700});
    try {const file=await open(join(dir,`${id}.json`),'wx',0o600);try{await file.writeFile(JSON.stringify(entry,null,2));await file.sync();}finally{await file.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
    body=`${source.slice(0,1600)}\n\nOutput truncated. Full retained output is local-only: artifacts/exports/${id}.json on origin ${ctx.instanceId}. This is not a shared evidence link.`;
  }
  const status=`status/${component(ctx.instanceId)}/${component(record.input.teamTaskId??'')}.md`;
  const links=record.input.teamTaskId?`\n[Task status](${relativeLink(path,status)})\n`:'';
  const provenance=checked.held?'Provenance details held with content.':`Agent: ${record.session.agentId}; pinned definition: ${record.session.agentRevision}.`;
  return {path,held:checked.held,content:document('History',`${entry.kind} history`,{id:`history:${ctx.instanceId}:${record.session.id}:${hash(entry.id)}`,originId:ctx.instanceId,sessionId:record.session.id,entryId:redact(entry.id,policy).held?`held-${hash(entry.id)}`:entry.id,sequence,kind:entry.kind,at:entry.at,...(checked.held?{exportReason:'possible_secret'}:{})},`# ${entry.kind}\n\nReported at: ${entry.at}\n\n${body}\n\n${provenance}\nOrigin: ${ctx.instanceId}; session: ${record.session.id}; entry: ${redact(entry.id,policy).held?hash(entry.id):entry.id}.\n[Session history](index.md)${links}`)};
}
