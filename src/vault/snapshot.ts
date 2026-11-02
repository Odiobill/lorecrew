import { revisionOf } from './parse.js';
import type { Concept } from './types.js';
/** Only portable types that affect the reviewed audience/catalog participate. */
export function vaultSnapshotRevision(concepts:readonly Concept[],types:readonly string[]):string {
 const normalized=[...new Set(types.map(t=>t.trim()).filter(Boolean))].sort();
 return revisionOf(JSON.stringify({types:normalized,documents:concepts.filter(c=>normalized.includes(String(c.metadata.type))).map(c=>[c.path,c.revision]).sort((a,b)=>a[0]!.localeCompare(b[0]!))}));
}
