import { randomUUID } from 'node:crypto';
import type { StateContext } from '../instance/state.js';
import { newSecret, secretHash } from './sessions.js';
export type Scope='read'|'write';
interface TokenRecord {id:string;hash:string;name:string;scopes:Scope[];createdAt:number}
const publicToken=({id,name,scopes,createdAt}:TokenRecord)=>({id,name,scopes,createdAt});
export function openTokens(ctx:StateContext) {
  return {
    async create(name:string,scopes:Scope[]){
      const token=newSecret();const record:TokenRecord={id:randomUUID(),hash:secretHash(token),name,scopes:[...new Set(scopes)],createdAt:ctx.clock.now()};
      await ctx.store.transact(tx=>tx.insert('auth-token',record.hash,record));return {...publicToken(record),token};
    },
    async authenticate(token:string){return ctx.store.read<TokenRecord>('auth-token',secretHash(token));},
    async list(){return (await ctx.store.list<TokenRecord>('auth-token')).map(publicToken);},
    async revoke(id:string){const tokens=await ctx.store.list<TokenRecord>('auth-token');await ctx.store.transact(tx=>{for(const token of tokens)if(token.id===id)tx.delete('auth-token',token.hash);});},
  };
}
