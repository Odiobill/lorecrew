import { useEffect, useRef, useState } from 'react';
import type { ApiClient, KnowledgeDocument, KnowledgeSearch } from '../api.js';

function safeRelative(current:string,target:string):string|undefined{
 let path:string;try{path=decodeURIComponent(target.split('#')[0]!.split('?')[0]!);}catch{return;}
 if(!path||path.includes('\\')||path.includes('\0')||path.startsWith('/')||/^[a-z][a-z0-9+.-]*:/i.test(path))return;
 const parts=current.split('/').slice(0,-1);
 for(const part of path.split('/')){if(part==='.'||part==='')continue;if(part==='..'){if(!parts.length)return;parts.pop();}else parts.push(part);}
 const joined=parts.join('/');return joined.endsWith('.md')&&parts.every(part=>part!=='.git')?joined:undefined;
}
function title(path:string){return path.split('/').at(-1)!.replace(/\.md$/,'').replaceAll(/[-_]/g,' ').replace(/^./,c=>c.toUpperCase());}
function inline(text:string,current:string,open:(path:string)=>void,known:Map<string,boolean>){
 const result:React.ReactNode[]=[];const links=/\[([^\]]+)\]\(([^)]+)\)/g;let start=0;for(const match of text.matchAll(links)){
  result.push(text.slice(start,match.index));const path=safeRelative(current,match[2]!);
  result.push(path&&known.get(path)!==false?<a key={`${match.index}-${path}`} href={`#knowledge/${encodeURIComponent(path)}`} onClick={event=>{event.preventDefault();open(path);}}>{match[1]}</a>:<span key={match.index} className="muted">{match[1]} · Unavailable on this instance</span>);
  start=match.index!+match[0].length;
 }result.push(text.slice(start));return result;
}
function Markdown({document,open}:{document:KnowledgeDocument;open:(path:string)=>void}){
 const known=new Map(document.sources.map(source=>[source.path,source.available]));
 return <div className="markdown">{document.body.split(/\r?\n/).map((line,index)=>{
  if(!line.trim())return <div key={index} className="markdown-space"/>;
  const h=/^(#{1,3})\s+(.+)/.exec(line);if(h){const content=inline(h[2]!,document.path,open,known);return h[1]!.length===1?<h3 key={index}>{content}</h3>:<h4 key={index}>{content}</h4>;}
  return <p key={index}>{inline(line,document.path,open,known)}</p>;
 })}</div>;
}
export function Knowledge({api,requestedPath,onOpenDocument}:{api:ApiClient;requestedPath:string;onOpenDocument:(path:string)=>void}){
 const [query,setQuery]=useState('');const [framework,setFramework]=useState('');const [version,setVersion]=useState('');
 const [page,setPage]=useState<KnowledgeSearch>();const [cursor,setCursor]=useState<string>();const [document,setDocument]=useState<KnowledgeDocument>();const [history,setHistory]=useState<string[]>([]);const [error,setError]=useState('');
 async function search(next?:string){try{setError('');const result=await api.searchKnowledge({q:query,...(framework?{framework}:{}),...(version?{version}:{}),...(next?{cursor:next}:{}),limit:20});setPage(result);setCursor(next);}catch(cause){setError(cause instanceof Error?cause.message:'Search failed');}}
 const currentPath=useRef<string|undefined>(undefined);const [reload,setReload]=useState(0);
 const open=(path:string)=>{if(path===requestedPath)setReload(value=>value+1);else onOpenDocument(path);};
 useEffect(()=>{
  let live=true;setError('');setDocument(undefined);
  if(!requestedPath){currentPath.current=undefined;setHistory([]);return;}
  void api.knowledgeDocument(requestedPath).then(result=>{
   if(!live)return;
   const previous=currentPath.current;
   if(previous&&previous!==result.path)setHistory(old=>old.at(-1)===result.path?old.slice(0,-1):[...old,previous]);
   currentPath.current=result.path;setDocument(result);
  }).catch(cause=>{if(live)setError(cause instanceof Error?cause.message:'Document unavailable');});
  return()=>{live=false;};
 },[api,requestedPath,reload]);
 const back=()=>{const previous=history.at(-1);if(previous)open(previous);};
 const currentExecution=document?.evidence.filter(item=>item.appliesToCurrent&&item.kind!=='review')??[];
 const passingClaims=[...new Set(currentExecution.filter(item=>item.outcome==='pass').flatMap(item=>item.claimIds))];
 const conflictingClaims=[...new Set(currentExecution.filter(item=>item.outcome==='fail').flatMap(item=>item.claimIds))];
 const reviews=document?.evidence.filter(item=>item.appliesToCurrent&&item.kind==='review')??[];
 return <main className="inspection"><section className="panel"><p className="eyebrow">SHARED EXPERIENCE</p><h1>Knowledge</h1><p><a href="#knowledge/learning">Learning · proposals and evidence</a></p><form onSubmit={event=>{event.preventDefault();void search();}}><label>Search knowledge<input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Symptoms, remedy, framework…"/></label><div className="fields"><label>Framework<input value={framework} onChange={event=>setFramework(event.target.value)}/></label><label>Version<input value={version} onChange={event=>setVersion(event.target.value)}/></label></div><button type="submit">Search knowledge</button></form>{error&&<p role="alert" className="error-inline">{error}</p>}
 {page&&<><h2 className="list-title">Results</h2><ul className="inspection-list">{page.items.map(hit=><li key={hit.path}><button className="inspection-choice" onClick={()=>void open(hit.path)}><strong>{hit.title}</strong><span>{hit.description}</span><span>{hit.evidenceState} · {hit.path}</span></button></li>)}</ul>{!page.items.length&&<p className="empty">No matching knowledge.</p>}{page.nextCursor&&<button className="secondary" onClick={()=>void search(page.nextCursor)}>Next results</button>}{cursor&&<button className="text-button" onClick={()=>void search()}>First page</button>}</>}
 </section><section className="panel inspection-detail" aria-label="Knowledge document">{document?<><button className="text-button" onClick={back} disabled={!history.length}>Back to lesson</button><p className="eyebrow">{document.type.toUpperCase()}</p><h2>{document.title}</h2><p><span className="badge">{document.evidenceState[0]!.toUpperCase()+document.evidenceState.slice(1)}</span></p><p className="muted revision">Revision {document.revision}</p><Markdown document={document} open={path=>void open(path)}/><h3>Applicability</h3><pre className="inspection-data">{JSON.stringify(document.applicability,null,2)}</pre><h3>Claims</h3><p>{document.claims.length?document.claims.join(', '):'No named claims recorded.'}</p>
 {passingClaims.length>0&&<><h3>Validated for</h3><p>Executed checks passed for {passingClaims.join(', ')} in the exact applicability above. Check conflicts below before relying on this lesson.</p></>}
 {conflictingClaims.length>0&&<><h3>Conflicting evidence</h3><p>Recorded executions disagree with {conflictingClaims.join(', ')} in the exact applicability above.</p></>}
 {reviews.length>0&&<><h3>Reviews, not execution validation</h3><p>Reviewer assessments cover {reviews.map(item=>`${item.claimIds.join(', ')} (${item.outcome})`).join('; ')}. These do not establish a passing check or execution conflict.</p></>}
 <h3>Evidence</h3><ul className="inspection-list">{document.evidence.map(item=><li key={item.path}><button className="inspection-choice" onClick={()=>void open(item.path)}><strong>{item.kind==='review'?`Review: ${item.outcome}`:item.outcome==='fail'?'Conflicting execution':'Passing execution'} · {item.kind}</strong><span>{item.claimIds.join(', ')} · {item.at}</span><span>{item.appliesToCurrent?'Applies to this revision':'Historical context only'}</span></button>{item.artifacts.map(artifact=><div className="source-item" key={artifact.path}>{artifact.available?<a href={`#knowledge/${encodeURIComponent(artifact.path)}`} onClick={event=>{event.preventDefault();void open(artifact.path);}}>{title(artifact.path)}</a>:<span>{artifact.path} · Unavailable on this instance</span>}{artifact.localOnly&&<span className="muted"> · Full output local-only on originating instance</span>}</div>)}</li>)}</ul>
 <h3>Sources</h3><ul className="inspection-list">{document.sources.map(source=><li className="source-item" key={source.path}>{source.available?<a href={`#knowledge/${encodeURIComponent(source.path)}`} onClick={event=>{event.preventDefault();void open(source.path);}}>{title(source.path)}</a>:<span>{source.path} · Unavailable on this instance</span>}</li>)}</ul>
 </>:<><h2>Inspect a document</h2><p className="muted">Search to follow a lesson, its evidence, and the source task.</p></>}</section></main>;
}
