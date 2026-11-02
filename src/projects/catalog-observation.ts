import {constants} from 'node:fs';
import {lstat,open,readdir} from 'node:fs/promises';
import {AppError} from '../contracts/base.js';
import {hash,inputHash} from '../repositories/inspect.js';
import {safeRepositoryPath} from '../repositories/checkpoint.js';
import {validateProjectCatalogEntry,type ProjectCatalogEntry} from './catalog.js';
export interface CatalogObservation {revision:string;entries:ProjectCatalogEntry[];diagnostics:Array<{path:string;code:string;projectIds:string[]}>;blockedProjectIds:string[]}
const directory='.lorecrew/projects',maxBytes=1024*1024,maxRecords=4096;
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);
/** A tolerant read projection. Strict writers continue to reject the entire bad inventory. */
export function observeProjectCatalog(vaultDir:string):Promise<CatalogObservation>{return observeCatalog(vaultDir);}
/** Private workflow recovery comparison; the public catalog always observes every record. */
export function observeProjectCatalogExcluding(vaultDir:string,projectId:string):Promise<CatalogObservation>{if(!validId(projectId))throw new AppError('INVALID_PROJECT','Invalid project identity');return observeCatalog(vaultDir,projectId);}
async function observeCatalog(vaultDir:string,excludedProjectId?:string):Promise<CatalogObservation>{
 const entries:ProjectCatalogEntry[]=[],diagnostics:CatalogObservation['diagnostics']=[],blocked=new Set<string>(),inventory:unknown[]=[];
 const diagnose=(path:string,code:string,ids:string[])=>{const projectIds=[...new Set(ids)].sort();diagnostics.push({path,code,projectIds});projectIds.forEach(id=>blocked.add(id));inventory.push({path,code,projectIds});};
 let names:string[];
 try{names=(await readdir(await safeRepositoryPath(vaultDir,directory))).filter(name=>name.endsWith('.json')&&(excludedProjectId===undefined||name!==excludedProjectId+'.json')).sort();}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {revision:excludedProjectId?inputHash([{names:[]}]):inputHash({directory:'missing'}),entries,diagnostics,blockedProjectIds:[]};diagnose(directory,error instanceof AppError?error.code:'CATALOG_READ_FAILED',[]);return {revision:inputHash(inventory),entries,diagnostics,blockedProjectIds:[]};}
 inventory.push({names});
 if(names.length>maxRecords)diagnose(directory,'CATALOG_LIMIT',names.map(n=>n.slice(0,-5)).filter(validId));
 for(const name of names.slice(0,maxRecords)){
  const path=directory+'/'+name,filenameId=name.slice(0,-5),ids=validId(filenameId)?[filenameId]:[];
  try{
   const target=await safeRepositoryPath(vaultDir,path),before=await lstat(target);
   inventory.push({path,dev:before.dev,ino:before.ino,size:before.size,mtime:before.mtimeMs,mode:before.mode});
   if(!before.isFile())throw new AppError('INVALID_PROJECT_CATALOG','Catalog records must be ordinary files');
   const file=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let bytes:Buffer;
   try{
    const opened=await file.stat(),current=await lstat(await safeRepositoryPath(vaultDir,path));
    if(!current.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||current.dev!==opened.dev||current.ino!==opened.ino)throw new AppError('CATALOG_CHANGED','Catalog file changed during observation');
    if(opened.size>maxBytes)throw new AppError('CATALOG_RECORD_TOO_LARGE','Catalog record exceeds the read limit');
    const buffer=Buffer.alloc(Math.min(opened.size+1,maxBytes+1)),read=await file.read(buffer,0,buffer.length,0);bytes=buffer.subarray(0,read.bytesRead);
    if(bytes.length>maxBytes)throw new AppError('CATALOG_RECORD_TOO_LARGE','Catalog record exceeds the read limit');
    const after=await file.stat();if(after.size!==bytes.length||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw new AppError('CATALOG_CHANGED','Catalog file changed during observation');
   }finally{await file.close();}
   inventory.push({path,rawHash:hash(bytes)});
   const parsed:unknown=JSON.parse(bytes.toString('utf8'));if(parsed&&typeof parsed==='object'&&validId((parsed as ProjectCatalogEntry).projectId))ids.push((parsed as ProjectCatalogEntry).projectId);
   const entry=validateProjectCatalogEntry(parsed);if(name!==entry.projectId+'.json')throw new AppError('INVALID_PROJECT_CATALOG','Catalog filename and identity differ');entries.push(entry);
  }catch(error){diagnose(path,error instanceof AppError?error.code:error instanceof SyntaxError?'INVALID_PROJECT_CATALOG':'CATALOG_READ_FAILED',ids);}
 }
 const aliases=new Map<string,string[]>();
 for(const entry of entries)for(const alias of entry.repositoryAliases)aliases.set(alias,[...aliases.get(alias)??[],entry.projectId]);
 for(const [alias,ids] of [...aliases].sort(([a],[b])=>a.localeCompare(b)))if(ids.length>1){inventory.push({alias,ids});diagnose(directory,'AMBIGUOUS_REPOSITORY',ids);}
 return {revision:inputHash(inventory),entries,diagnostics,blockedProjectIds:[...blocked].sort()};
}
