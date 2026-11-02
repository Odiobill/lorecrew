import {AppError} from '../contracts/base.js';
import {validateRemote} from '../repositories/create.js';
import {validateProjectCatalogEntry,type ProjectCatalogEntry} from './catalog.js';
import {canonicalRepositoryKey} from './registry.js';
/** Display suggestions only; no remembered transport, portable writes or authority effects. */
export function suggestedCloneSources(entry:ProjectCatalogEntry):Array<{alias:string;url:string}>{
 validateProjectCatalogEntry(entry);
 return entry.repositoryAliases.filter(alias=>alias.startsWith('repo:')).sort().map(alias=>({alias,url:'https://'+alias.slice(5)+'.git'}));
}
/** Canonical keys are catalog identities, never evidence merely because a remote contains one. */
export function projectSourceAlias(url:string):string|undefined {
 if(/^(?:repo|fork):/.test(url))return undefined;
 try{const alias=canonicalRepositoryKey(url);return alias.startsWith('repo:')?alias:undefined;}catch{
  const host=/^git@([^:]+):/.exec(url)?.[1]??(()=>{try{return new URL(url).hostname;}catch{return undefined;}})();
  if(host&&['github.com','gitlab.com','bitbucket.org'].includes(host.toLowerCase()))throw new AppError('PROJECT_SOURCE_MISMATCH','Use a source that matches a recorded repository alias.');
  return undefined;
 }
}
export function reviewProjectSource(entry:ProjectCatalogEntry,url:string,acknowledgeOpaque:boolean):{kind:'alias'|'operator_assertion';url:string;alias?:string}{
 validateProjectCatalogEntry(entry);validateRemote(url);const alias=projectSourceAlias(url);
 if(alias){if(!entry.repositoryAliases.includes(alias))throw new AppError('PROJECT_SOURCE_MISMATCH','This source belongs to a different repository identity.');return {kind:'alias',url,alias};}
 if(!acknowledgeOpaque)throw new AppError('OPAQUE_SOURCE_ACK_REQUIRED','Confirm that this opaque source belongs to the selected project. This assertion grants no execution ownership.');
 return {kind:'operator_assertion',url};
}
