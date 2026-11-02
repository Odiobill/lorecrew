import { DatabaseSync } from 'node:sqlite';
import { AppError, type Json } from '../contracts/base.js';
import { revisionOf } from '../vault/parse.js';
import type { Concept } from '../vault/types.js';
import type { SearchHit, SearchPage, SearchRequest } from './types.js';
import { deriveEvidenceState, vaultEvidence, object } from '../learning/evidence.js';
export const stringList=(value:Json|undefined):string[]=>Array.isArray(value)?value.filter((x):x is string=>typeof x==='string'):[];
export const mapping=(value:Json|undefined):Record<string,Json>=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const text=(value:Json|undefined)=>typeof value==='string'?value:'';
export const searchTerms=(query:string)=>[...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu)??[])].slice(0,64);
export function pageOffset(cursor:string|undefined,generation:string,query:string):number {
 if(!cursor)return 0;
 try{const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString());return parsed.g===generation&&parsed.q===query&&Number.isSafeInteger(parsed.o)&&parsed.o>=0?parsed.o:0;}catch{return 0;}
}
export const pageCursor=(generation:string,query:string,offset:number)=>Buffer.from(JSON.stringify({g:generation,q:query,o:offset})).toString('base64url');
/** This database is a disposable projection, never a source of accepted knowledge. */
export class KnowledgeIndex {
 constructor(private readonly path:string){}
 private open(){const db=new DatabaseSync(this.path);try{db.exec(`CREATE TABLE IF NOT EXISTS generation (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS hits(path TEXT PRIMARY KEY, hit TEXT NOT NULL);
 CREATE VIRTUAL TABLE IF NOT EXISTS discovery USING fts5(path UNINDEXED,title,description,symptoms,tags,body);`);return db;}catch(error){db.close();throw error;}}
 async rebuild(concepts:Concept[]):Promise<void>{
  const evidence=vaultEvidence(concepts);
  const db=this.open();try{db.exec('BEGIN IMMEDIATE');db.exec('DELETE FROM hits; DELETE FROM discovery;');
   for(const c of concepts){if(typeof c.metadata.type!=='string')continue;
    const linked=evidence.filter(e=>e.record.subjectId===c.path);
    const evidencePaths=concepts.filter(p=>p.metadata.type==='Evidence'&&object(object(p.metadata.lorecrew).evidence).subjectId===c.path).map(p=>p.path);
    const provenance=concepts.filter(p=>p.metadata.type==='LearningProvenance'&&object(p.metadata.lorecrew).subjectId===c.path).map(p=>p.path);
    const m=c.metadata;const hit:SearchHit={path:c.path,revision:c.revision,title:text(m.title)||c.path,description:text(m.description),evidenceState:m.evidenceState==='contested'?'contested':deriveEvidenceState(c,linked.map(e=>e.record)),applicability:mapping(m.applicability),sourcePaths:[...new Set([...stringList(m.sourcePaths),...evidencePaths,...provenance])]};
    db.prepare('INSERT INTO hits VALUES(?,?)').run(c.path,JSON.stringify(hit));
    db.prepare('INSERT INTO discovery VALUES(?,?,?,?,?,?)').run(c.path,hit.title,hit.description,[text(m.symptoms),...stringList(m.symptoms)].join(' '),stringList(m.tags).join(' '),c.body);
   }
   const generation=revisionOf(JSON.stringify(concepts.map(c=>[c.path,c.revision]).sort((a,b)=>a[0]!.localeCompare(b[0]!))));
   db.prepare('INSERT OR REPLACE INTO generation VALUES(1,?)').run(generation);db.exec('COMMIT');
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{db.close();}
 }
 async search(input:SearchRequest):Promise<SearchPage>{
  if(typeof input.query!=='string'||input.query.length>8192)throw new AppError('INVALID_QUERY','Use a search query up to 8192 characters');
  const limit=input.limit??20;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AppError('INVALID_LIMIT','Search page size must be from 1 to 100');
  const terms=searchTerms(input.query);if(!terms.length)return {items:[]};const db=this.open();
  try{const generation=String(db.prepare('SELECT value FROM generation WHERE id=1').get()?.value??'empty');const key=JSON.stringify([terms,input.framework??null,input.version??null,limit]);const offset=pageOffset(input.cursor,generation,key);
   const matches=db.prepare(`SELECT hits.hit FROM discovery JOIN hits USING(path) WHERE discovery MATCH ? ORDER BY bm25(discovery,0,6,4,3,2,1),path`).all(terms.map(t=>`"${t.replaceAll('"','""')}"`).join(' OR ')).map(r=>JSON.parse(String(r.hit)) as SearchHit).filter(hit=>['framework','version'].every(field=>{
    const wanted=input[field as 'framework'|'version'];const applicable=hit.applicability[field];return !wanted||applicable===undefined||applicable===wanted||Array.isArray(applicable)&&applicable.includes(wanted);
   }));const items=matches.slice(offset,offset+limit);return {items,...(offset+limit<matches.length?{nextCursor:pageCursor(generation,key,offset+limit)}:{})};
  }finally{db.close();}
 }
 async close():Promise<void>{/* Connections belong to individual atomic operations. */}
}
