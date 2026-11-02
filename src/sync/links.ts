import {posix} from 'node:path';
import {AppError} from '../contracts/base.js';
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
export function validateCandidateLinks(path:string,body:string,paths:ReadonlySet<string>){for(const destination of linkDestinations(body)){const href=destination.split('#')[0]!.split('?')[0]!;if(!href||/^[A-Za-z][A-Za-z0-9+.-]*:/.test(href))continue;let target:string;try{const decoded=decodeURIComponent(href);target=posix.normalize(decoded.startsWith('/')?decoded.slice(1):posix.join(posix.dirname(path),decoded));}catch{throw new AppError('SYNC_LINK','Invalid candidate link');}if(!posix.extname(target))target=posix.join(target,'index.md');if(!paths.has(target))throw new AppError('SYNC_LINK','Unresolved candidate link');}}
