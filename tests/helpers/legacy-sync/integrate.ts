/** Historical version1 writer fixture from1a6814a; never imported by application code. */
import { posix } from 'node:path';
import { AppError } from '../../../src/contracts/base.js';
import { agentDefinition, groupDefinition } from '../../../src/agents/resolve.js';
import { document, relativeLink } from '../../../src/export/history.js';
import { assertUniqueIds, containsCredentials } from '../../../src/vault/indexes.js';
import { parseConcept, revisionOf } from '../../../src/vault/parse.js';
import { hash, type StagingRepository } from './contributions.js';
import type { ConflictProposal, Contribution } from '../../../src/sync/types.js';
export interface AcceptedBatch {id:string;originId:string;commit:string}
export interface IntegrationMetadata {format:'lorecrew-integration-v1';accepted:AcceptedBatch[]}
/** Remove only service-generated additions; authored root bytes remain significant. */
function authoredRoot(text:string):string {
 return text.replace(/\n<!-- lorecrew:device:[^\n]+ -->\n\[Device [^\n]+\]\([^\n]+\)\n/g,'').replace(/\n<!-- lorecrew:sync-catalog -->\n\[Shared catalog\]\(catalogs\/sync\/index\.md\)\n/g,'');
}
export async function acceptedBatches(repo:StagingRepository,head:string|null):Promise<AcceptedBatch[]>{
 if(head===null)return [];const cached=await repo.options.ctx.store.read<AcceptedBatch[]>('sync-accepted-metadata-v1',head);if(cached)return cached;
 const known=new Map<string,AcceptedBatch>();const commits=(await repo.run(['rev-list','--first-parent',head])).trim().split('\n').filter(Boolean);
 for(const commit of commits){const prior=await repo.options.ctx.store.read<AcceptedBatch[]>('sync-accepted-metadata-v1',commit);if(prior){for(const item of prior)if(!known.has(item.id))known.set(item.id,item);break;}const metadata=await repo.metadata(commit) as IntegrationMetadata|undefined;if(metadata?.format==='lorecrew-integration-v1')for(const item of metadata.accepted)if(!known.has(item.id))known.set(item.id,item);}
 const result=[...known.values()];await repo.options.ctx.store.transact(tx=>tx.put('sync-accepted-metadata-v1',head,result));return result;
}
/** Inline destinations can contain balanced or escaped parentheses. Keep URI
 * decoding separate so encoded delimiters never affect Markdown balancing. */
function* linkDestinations(body:string):Generator<string>{
 for(const match of body.matchAll(/\[[^\]]*\]\(/g)){
  let cursor=match.index+match[0].length;while(/\s/.test(body[cursor]??'')&&cursor<body.length)cursor++;
  const angled=body[cursor]==='<';if(angled)cursor++;
  let depth=0;let destination='';let closed=false;
  for(;cursor<body.length;cursor++){
   const char=body[cursor]!;const next=body[cursor+1];
   // CommonMark backslash escapes apply to ASCII punctuation only.
   if(char==='\\'&&next&&/[!-/:-@\[-`{-~]/.test(next)){destination+=next;cursor++;continue;}
   if(angled){if(char==='>'){closed=true;break;}if(char==='\n'||char==='<')break;}
   else{
    if(char==='(')depth++;
    else if(char===')'){if(depth===0){closed=true;break;}depth--;}
    else if(/\s/.test(char)){closed=depth===0;break;}
   }
   destination+=char;
  }
  if(!closed||depth!==0)continue;
  if(angled)cursor++; // The destination's > does not close the surrounding link.
  if(body[cursor]===')'){yield destination;continue;}
  const separator=cursor;while(cursor<body.length&&/\s/.test(body[cursor]!))cursor++;
  if(body[cursor]===')'){yield destination;continue;}
  // Optional titles require separating whitespace, matching delimiters, and
  // the link's own final ). Unfinished Markdown is ordinary text, not a link.
  if(cursor===separator)continue;
  const opener=body[cursor];const closer=opener==='('?')':opener;
  if(opener!=='"'&&opener!=="'"&&opener!=='(')continue;
  let titleClosed=false;
  for(cursor++;cursor<body.length;cursor++){
   const char=body[cursor]!;
   if(char==='\\'&&body[cursor+1]&&/[!-/:-@\[-`{-~]/.test(body[cursor+1]!)){cursor++;continue;}
   if(char===closer){titleClosed=true;cursor++;break;}
   if(opener==='('&&char==='(')break;
  }
  if(!titleClosed)continue;
  while(cursor<body.length&&/\s/.test(body[cursor]!))cursor++;
  if(body[cursor]===')')yield destination;
 }
}
function validate(files:Map<string,string>){
 const concepts=[...files].filter(([path])=>path.endsWith('.md')).map(([path,text])=>parseConcept(path,text));
 if(!files.has('index.md'))throw new AppError('SYNC_STRUCTURE','Shared knowledge requires a root index');assertUniqueIds(concepts);
 for(const concept of concepts){
  if(concept.metadata.type==='Agent')agentDefinition(concept);if(concept.metadata.type==='Group')groupDefinition(concept);
  if(containsCredentials(concept.metadata.lorecrew))throw new AppError('SYNC_STRUCTURE','Candidate portable configuration contains credentials');
  for(const destination of linkDestinations(concept.body)){
   const href=destination.split('#')[0]!.split('?')[0]!;if(!href||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href))continue;
   let target:string;try{const decoded=decodeURIComponent(href);target=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(concept.path),decoded));}catch{throw new AppError('SYNC_LINK','Invalid candidate link');}
   if(!posix.extname(target))target=posix.join(target,'index.md');if(!files.has(target))throw new AppError('SYNC_LINK','Unresolved candidate link',{path:concept.path,target});
  }
 }
}
function indexes(files:Map<string,string>){
 const catalog='catalogs/sync/index.md';const marker='<!-- lorecrew:sync-catalog:generated -->';
 if(files.has(catalog)&&!files.get(catalog)!.startsWith(marker+'\n'))throw new AppError('SYNC_CATALOG','Generated catalog path contains authored content');
 const paths=[...files.keys()].filter(p=>p.endsWith('.md')&&p!=='index.md'&&p!==catalog).sort();
 files.set(catalog,`${marker}\n# Shared knowledge\n\nGenerated from accepted files.\n\n${paths.map(path=>`- [${path.replace(/[\[\]]/g,'')}](${relativeLink(catalog,path).replace(/\(/g,'%28').replace(/\)/g,'%29')})`).join('\n')}\n`);
 const root=files.get('index.md');if(root===undefined)return;
 let rebuilt=authoredRoot(root);
 for(const path of paths.filter(p=>/^devices\/[^/]+\.md$/.test(p))) {const id=path.slice(8,-3);rebuilt+=`\n<!-- lorecrew:device:${id} -->\n[Device ${id}](${path})\n`;}
 rebuilt+='\n<!-- lorecrew:sync-catalog -->\n[Shared catalog](catalogs/sync/index.md)\n';files.set('index.md',rebuilt);
}
async function proposal(repo:StagingRepository,head:string|null,files:Map<string,string>,item:Contribution,reason:string):Promise<ConflictProposal>{
 const id=revisionOf(`${item.batch.originId}:${item.batch.id}:${item.commit}`);const versions:ConflictProposal['versions']=[];
 for(const file of item.batch.files){const text=files.get(file.path)??null;const base=item.bases[file.path]!;
  // A prior successful batch in this candidate can supply left bytes. Its
  // contribution commit is already immutable and remotely retained.
  let leftCommit=head;
  if(hash(await repo.text(head,file.path))!==hash(text))leftCommit=null;
  versions.push({path:file.path,base,left:{hash:hash(text),commit:leftCommit,path:file.path},right:{hash:hash(file.content),commit:item.commit,path:file.path}});
 }
 const old=files.get(`proposals/sync/${id}.md`);
 if(old){const extension=parseConcept(`proposals/sync/${id}.md`,old).metadata.lorecrew;const stored=extension&&typeof extension==='object'&&!Array.isArray(extension)?extension.proposal:undefined;
  if(stored&&typeof stored==='object'&&!Array.isArray(stored)){const prior=stored as unknown as ConflictProposal;if(prior.reason===reason&&prior.versions.every((v,i)=>v.left.hash===versions[i]?.left.hash))return prior;}
 }
 return {id,batchId:item.batch.id,originId:item.batch.originId,paths:item.batch.files.map(f=>f.path),reason,versions};
}
export async function buildIntegration(repo:StagingRepository,head:string|null,items:Contribution[]){
 let files=await repo.tree(head);let parent=head;const accepted=await acceptedBatches(repo,head);const seen=new Set(accepted.map(x=>x.id));const conflicts:ConflictProposal[]=[];
 const appliedSources=new Map<string,{commit:string;hash:string|null}>();
 for(const item of items){if(seen.has(item.batch.id))continue;
  let reason=item.dependencies.some(id=>!seen.has(id))?'predecessor_pending':'';const candidate=new Map(files);
  for(const file of item.batch.files){const current=candidate.get(file.path)??null;const base=await repo.text(item.bases[file.path]!.commit,file.path);
   let content=file.content;
   if(file.path==='index.md'&&current!==null&&base!==null&&content!==null){if(authoredRoot(current)===authoredRoot(base)||authoredRoot(current)===authoredRoot(content))content=authoredRoot(content);else reason||='content_conflict';}
   else if(hash(current)!==file.baseHash&&current!==content)reason||='content_conflict';
   if(content===null)candidate.delete(file.path);else candidate.set(file.path,content);
  }
  if(!reason){try{indexes(candidate);validate(candidate);}catch(error){if(!(error instanceof AppError))throw error;reason=error.code;}}
  if(reason){let conflict=await proposal(repo,parent,files,item,reason);
   for(const version of conflict.versions)if(version.left.commit===null&&version.left.hash!==null){const source=appliedSources.get(version.path);if(source?.hash===version.left.hash)version.left.commit=source.commit;}
   if(conflict.versions.some(version=>version.left.commit===null&&version.left.hash!==null)){
    // Generated catalog combinations have no contribution preimage. Keep a
    // coherent checkpoint in shared ancestry before publishing their references.
    validate(files);parent=await repo.commit(parent,files,{format:'lorecrew-integration-v1',accepted});conflict=await proposal(repo,parent,files,item,reason);
   }
   conflicts.push(conflict);files.set(`proposals/sync/${conflict.id}.md`,document('ConflictProposal','Pending contribution',{id:`sync-conflict:${conflict.id}`,proposal:conflict},`# Pending contribution ${item.batch.id}\n\nReason: ${reason}. No semantic resolution has been selected.\n\n${conflict.versions.map(v=>`- ${v.path}\n  - Base: ${v.base.hash??'absent'}; git:${v.base.commit??'absent'}:${v.path}\n  - Left: ${v.left.hash??'absent'}; git:${v.left.commit??'absent'}:${v.path}\n  - Right: ${v.right.hash??'absent'}; git:${v.right.commit}:${v.path}`).join('\n')}`));
  }else{files=candidate;seen.add(item.batch.id);accepted.push({id:item.batch.id,originId:item.batch.originId,commit:item.commit});for(const file of item.batch.files)appliedSources.set(file.path,{commit:item.commit,hash:hash(file.content)});}
 }
 indexes(files);validate(files);
 return {files,accepted,conflicts,parent};
}

export async function sharedConflicts(repo:StagingRepository,head:string):Promise<ConflictProposal[]>{
 const accepted=new Set((await acceptedBatches(repo,head)).map(item=>item.id));const conflicts:ConflictProposal[]=[];
 for(const [path,text] of await repo.tree(head))if(/^proposals\/sync\/[0-9a-f]+\.md$/.test(path)){
  const ext=parseConcept(path,text).metadata.lorecrew;if(ext&&typeof ext==='object'&&!Array.isArray(ext)&&ext.proposal){const proposal=ext.proposal as unknown as ConflictProposal;if(!accepted.has(proposal.batchId))conflicts.push(proposal);}
 }return conflicts;
}
