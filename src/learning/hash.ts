import type { Json } from '../contracts/base.js';
import { revisionOf } from '../vault/parse.js';
import type { Concept } from '../vault/types.js';
export function canonical(value:Json):string {
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
 return JSON.stringify(value);
}
/** Claim identifiers are substantive too: renaming them cannot inherit validation. */
export function subjectHash(concept:Concept):string {
 const m=concept.metadata;return revisionOf(canonical({body:concept.body,type:m.type??null,title:m.title??null,applicability:m.applicability??{},claims:m.claims??[]}));
}
