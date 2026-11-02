/** A suggestion only: never silently rename an upstream skill or resolve a collision. */
export function suggestSkillIdentifier(name:string){return name.normalize('NFKD').replace(/\p{M}/gu,'').trim().toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[^a-z0-9]+/,'').slice(0,128).replace(/[-.]+$/,'')||'imported-skill';}
