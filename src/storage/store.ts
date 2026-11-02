import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { AppError, encodeJson, type AppEvent, type Clock, type Json } from '../contracts/base.js';
import { migrate } from './migrations.js';

export interface Tx {
  get<T>(kind: string, id: string): T | undefined;
  put<T>(kind: string, id: string, value: T): void;
  insert<T>(kind: string, id: string, value: T): void;
  delete(kind: string, id: string): void;
  emit(kind: string, data: Json): AppEvent;
}
export interface Store {
  read<T>(kind: string, id: string): Promise<T | undefined>;
  list<T>(kind: string): Promise<T[]>;
  keys(kind:string):Promise<string[]>;
  scan<T>(kind:string,options?:{prefix?:string;after?:string;field?:string;value?:string|number|boolean;limit?:number}):Promise<T[]>;
  transact<T>(fn: (tx: Tx) => T): Promise<T>;
  events(afterSeq: number): Promise<AppEvent[]>;
  eventPage(afterSeq: number, limit?: number): Promise<{events:AppEvent[];minSeq:number;maxSeq:number}>;
  repositoryFormat():1|2;
  completeRepositoryMigration(migrationId:string):Promise<void>;
  durability(): { journalMode: string; synchronous: number };
  close(): Promise<void>;
}
export function openStore(path: string, clock: Clock): Store {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    migrate(db);
    for(const field of ['sessionId','executingSessionId','returnSessionId','parentTaskId','taskId','fromSessionId','toSessionId','state'])db.exec(`CREATE INDEX IF NOT EXISTS projection_${field} ON records(kind,json_extract(value,'$.${field}'),id)`);
  } catch (error) { db.close(); throw error; }
  let tail = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  function ordered<T>(fn: () => T): Promise<T> {
    if (closed) return Promise.reject(new AppError('STORE_CLOSED', 'The control store is closed'));
    const result = tail.then(fn);
    tail = result.then(() => {}, () => {});
    return result;
  }
  const get = <T>(kind: string, id: string): T | undefined => {
    const row = db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    return row ? JSON.parse(String(row.value)) as T : undefined;
  };
  return {
    read: <T>(kind: string, id: string) => ordered(() => get<T>(kind, id)),
    list: <T>(kind: string) => ordered(() => db.prepare('SELECT value FROM records WHERE kind=? ORDER BY id').all(kind).map(row => JSON.parse(String(row.value)) as T)),
    keys:kind=>ordered(()=>db.prepare('SELECT id FROM records WHERE kind=? ORDER BY id').all(kind).map(row=>String(row.id))),
    scan:<T>(kind:string,options:{prefix?:string;after?:string;field?:string;value?:string|number|boolean;limit?:number}={})=>ordered(()=>{
      const params:Array<string|number>=[kind];let where='kind=?';
      if(options.prefix!==undefined){where+=' AND id>=? AND id<?';params.push(options.prefix,options.prefix+'\uffff');}
      if(options.after!==undefined){where+=' AND id>?';params.push(options.after);}
      if(options.field!==undefined){if(!/^[A-Za-z][A-Za-z0-9]*$/.test(options.field))throw new AppError('INVALID_FIELD','Invalid projection field');where+=` AND json_extract(value,'$.${options.field}')=?`;params.push(typeof options.value==='boolean'?Number(options.value):options.value??'');}
      if(options.limit!==undefined&&(!Number.isSafeInteger(options.limit)||options.limit<1))throw new AppError('INVALID_LIMIT','Invalid projection limit');
      return db.prepare(`SELECT value FROM records WHERE ${where} ORDER BY id${options.limit===undefined?'':' LIMIT '+options.limit}`).all(...params).map(row=>JSON.parse(String(row.value)) as T);
    }),
    events: afterSeq => ordered(() => db.prepare('SELECT seq, id, kind, at, data FROM events WHERE seq>? ORDER BY seq').all(afterSeq).map(row => ({ seq: Number(row.seq), id: String(row.id), kind: String(row.kind), at: String(row.at), data: JSON.parse(String(row.data)) as Json }))),
    eventPage: (afterSeq, limit=256) => ordered(() => {
      if(!Number.isSafeInteger(afterSeq)||afterSeq<0||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new AppError('INVALID_CURSOR','Invalid event cursor or page size');
      const bounds=db.prepare('SELECT MIN(seq) AS min, MAX(seq) AS max FROM events').get();
      const rows=db.prepare('SELECT seq,id,kind,at,data FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(afterSeq,limit);
      return {minSeq:Number(bounds?.min??0),maxSeq:Number(bounds?.max??0),events:rows.map(row=>({seq:Number(row.seq),id:String(row.id),kind:String(row.kind),at:String(row.at),data:JSON.parse(String(row.data)) as Json}))};
    }),
    transact: <T>(fn: (tx: Tx) => T) => ordered(() => {
      let active = true;
      const assertActive = () => { if (!active) throw new AppError('TRANSACTION_CLOSED', 'Transaction callback has finished'); };
      const track=(kind:string,id:string,value:unknown)=>{
        if(value===null||typeof value!=='object'||Array.isArray(value))return;
        const v=value as Record<string,any>;const sessionIds=new Set<string>();
        if(kind==='team-history'&&typeof v.sessionId==='string'&&v.entry&&typeof v.entry==='object'&&typeof v.entry.id==='string'){const stream='team-history-stream:'+v.sessionId;if(!get('team-history-stream-id:'+v.sessionId,v.entry.id)){const sequence=(get<{sequence:number}>('team-history-sequence',v.sessionId)?.sequence??0)+1;for(const [k,i,data] of [[stream,String(sequence).padStart(16,'0'),{sequence,entry:v.entry}],['team-history-stream-id:'+v.sessionId,v.entry.id,{sequence}],['team-history-sequence',v.sessionId,{sequence}]] as const)db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(k,i,encodeJson(data));}}
        if(kind==='sync-captured')db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run('sync-captured-index',id,encodeJson({id,acknowledged:!!v.acknowledged,delivered:!!v.delivered}));
        if(kind==='export-batch'&&typeof v.state==='string')db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run('export-batch-index',id,encodeJson({id,state:v.state,acknowledged:!!v.acknowledged}));
        if(kind==='runtime-session'&&v.session&&typeof v.session.id==='string'){
          sessionIds.add(v.session.id);
          db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run('runtime-session-index',id,encodeJson({sessionId:id,...Object.fromEntries(['instanceId','agentId','agentRevision','projectId'].filter(key=>typeof v.session[key]==='string').map(key=>[key,v.session[key]])),finished:!!v.finished,cancelled:!!v.cancelled,cancellationSettled:!!v.cancellationSettled}));
        }
        if(kind==='team-history'||kind==='runtime-effect'||kind==='runtime-outbox')if(typeof v.sessionId==='string')sessionIds.add(v.sessionId);
        if(kind==='team-task')for(const key of ['executingSessionId','returnSessionId'])if(typeof v[key]==='string')sessionIds.add(v[key]);
        for(const sessionId of sessionIds){const old=get<{generation:number}>('session-source',sessionId);db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run('session-source',sessionId,encodeJson({sessionId,generation:(old?.generation??0)+1}));}
      };
      const tx: Tx = {
        get: <R>(kind: string, id: string) => { assertActive(); return get<R>(kind, id); },
        put: (kind, id, value) => { assertActive(); const encoded=encodeJson(value);if(db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind,id)?.value===encoded)return;track(kind,id,value);db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, encoded); },
        insert: (kind, id, value) => { assertActive(); const encoded = encodeJson(value); if (get(kind, id) !== undefined) throw new AppError('RECORD_EXISTS', 'Record already exists', { kind, id }); track(kind,id,value);db.prepare('INSERT INTO records(kind,id,value) VALUES(?,?,?)').run(kind, id, encoded); },
        delete: (kind, id) => { assertActive(); db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id); },
        emit: (kind, data) => {
          assertActive(); const encoded = encodeJson(data); const id = randomUUID(); const at = new Date(clock.now()).toISOString();
          const result = db.prepare('INSERT INTO events(id,kind,at,data) VALUES(?,?,?,?)').run(id, kind, at, encoded);
          db.prepare('DELETE FROM events WHERE seq <= ?').run(Number(result.lastInsertRowid)-10_000);
          return { seq: Number(result.lastInsertRowid), id, kind, at, data: JSON.parse(encoded) as Json };
        },
      };
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(tx);
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          // Consume a rejected async continuation, whose expired Tx cannot mutate the store.
          void Promise.resolve(result).catch(() => {});
          throw new AppError('ASYNC_TRANSACTION', 'Transaction callbacks must be synchronous');
        }
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { active = false; }
    }),
    repositoryFormat:()=>Number(db.prepare('PRAGMA user_version').get()?.user_version) as 1|2,
    completeRepositoryMigration:migrationId=>ordered(()=>{
      db.exec('BEGIN IMMEDIATE');try{
        const record=get<{state:string;stoppedProof?:{quiescent:boolean};selections?:Array<{repo:{id:string}}> ;baselines?:Array<{repositoryId:string;commit:string}>}>('repository-migration',migrationId);
        if(!record||record.state!=='baselines_verified'||!record.stoppedProof?.quiescent||!record.selections?.length||record.selections.some(s=>!record.baselines?.some(b=>b.repositoryId===s.repo.id&&/^[0-9a-f]{40,64}$/.test(b.commit))))throw new AppError('MIGRATION_INCOMPLETE','Every selected repository needs its frozen stopped baseline before format conversion');
        db.prepare('UPDATE records SET value=? WHERE kind=? AND id=?').run(encodeJson({...record,state:'completed'}),'repository-migration',migrationId);db.exec('PRAGMA user_version=2; COMMIT');
      }catch(e){db.exec('ROLLBACK');throw e;}
    }),
    durability: () => {
      if (closed) throw new AppError('STORE_CLOSED', 'The control store is closed');
      return { journalMode: String(db.prepare('PRAGMA journal_mode').get()?.journal_mode), synchronous: Number(db.prepare('PRAGMA synchronous').get()?.synchronous) };
    },
    close: () => { if (!closing) { closed = true; closing = tail.then(() => { db.close(); }); } return closing; },
  };
}
