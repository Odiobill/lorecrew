import {validateHandoffManifest} from '../projects/handoff-manifest.js';
import {validateAuthorityMarker} from '../repositories/authority-marker.js';
import {AppError} from '../contracts/base.js';
import type {PublicationBatch,RedactionPolicy} from '../export/types.js';
import {redact} from '../export/redact.js';
import {component} from '../export/history.js';
import {validateVaultIdentity} from '../repositories/identity.js';
import {validateProjectCatalogEntry} from '../projects/catalog.js';
import {validateLiveContent} from './apply.js';
import {managedPath} from './recovery.js';

export function assertPublicationSafe(value:unknown,policy:RedactionPolicy={}):void {
 const held=(item:unknown):boolean=>typeof item==='string'?redact(item,policy).held:Array.isArray(item)?item.some(held):!!item&&typeof item==='object'?Object.entries(item).some(([key,value])=>held(key)||held(value)):false;
 if(held(value))throw new AppError('PUBLICATION_HELD','Publication held: possible secret; original local bytes are retained');
}
export function portableMetadataPath(path:string){return path==='.lorecrew/vault.json'||path==='.lorecrew/authority.json'||/^\.lorecrew\/handoffs\/[a-f0-9]{64}\.json$/.test(path)||/^\.lorecrew\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.json$/.test(path);}
export function validatePortableContent(path:string,content:string|null){
 if(portableMetadataPath(path)){
  if(content===null)throw new AppError('PUBLICATION_HELD','Portable identity removal requires explicit repair');
  const value:unknown=JSON.parse(content);
  if(path==='.lorecrew/vault.json')validateVaultIdentity(value);else if(path==='.lorecrew/authority.json')validateAuthorityMarker(value);else if(path.startsWith('.lorecrew/handoffs/')){const manifest=validateHandoffManifest(value);if(path!=='.lorecrew/handoffs/'+manifest.id+'.json')throw new AppError('INVALID_HANDOFF_MANIFEST','Manifest filename and identity differ');}
  else {const entry=validateProjectCatalogEntry(value);if(path!=='.lorecrew/projects/'+entry.projectId+'.json')throw new AppError('INVALID_PROJECT_CATALOG','Project filename and identity differ');}
  return;
 }
 if(!managedPath(path)||!path.endsWith('.md'))throw new AppError('PUBLICATION_HELD','The ordinary commit contains unsupported or private content');
 if(content!==null){const concept=validateLiveContent(path,content),extension=concept.metadata.lorecrew;if(/^(?:Assignment|Ownership|OwnershipGrant|Control)$/i.test(String(concept.metadata.type))||extension&&typeof extension==='object'&&!Array.isArray(extension)&&['ownerId','generation','transitionId','ownerInstanceId','assignment','assignments'].some(key=>key in extension))throw new AppError('PUBLICATION_HELD','Executable assignment projections cannot enter vault publication');}
}
export function validateLocalBatch(batch:PublicationBatch,origin:string,policy:RedactionPolicy={}){
 if(batch.originId!==origin||!batch.id||!batch.files.length)throw new AppError('INVALID_PUBLICATION','Capture must belong to this instance');
 assertPublicationSafe(batch,policy);
 const paths=new Set<string>();
 for(const file of batch.files){
  if(paths.has(file.path))throw new AppError('INVALID_PUBLICATION','Duplicate capture path');paths.add(file.path);
  validatePortableContent(file.path,file.content);
  const parts=file.path.split('/');
  if(['history','status','devices'].includes(parts[0]!)){const owner=parts[0]==='devices'?parts[1]?.replace(/\.md$/,''):parts[1];if(owner!==component(origin))throw new AppError('PUBLICATION_HELD','A local capture cannot impersonate another origin');}
  if(['agents','projects'].includes(parts[0]!)&&parts.length>2&&parts[1]!==component(origin))throw new AppError('PUBLICATION_HELD','A local capture cannot rewrite another origin projection');
 }
}
