import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from '../contracts/base.js';
import type { StateContext } from '../instance/state.js';
export const COOKIE_NAME='lorecrew_session';
export const secretHash=(secret:string)=>createHash('sha256').update(secret).digest('hex');
function cookieSecret(header:string):string|undefined{return header.split(';').map(part=>part.trim()).find(part=>part.startsWith(COOKIE_NAME+'='))?.slice(COOKIE_NAME.length+1);}
export const newSecret=()=>randomBytes(32).toString('base64url');
export function matches(secret:string,hash:string):boolean {
  const actual=Buffer.from(secretHash(secret),'hex');const expected=Buffer.from(hash,'hex');
  return actual.length===expected.length && timingSafeEqual(actual,expected);
}
export interface BrowserSession {id:string;hash:string;csrfHash:string;createdAt:number;expiresAt:number}
export function openBrowserSessions(ctx:StateContext) {
  return {
    async issueBootstrap():Promise<string> {
      const secret=newSecret();await ctx.store.transact(tx=>tx.put('auth-bootstrap','login',{hash:secretHash(secret),expiresAt:ctx.clock.now()+15*60_000}));return secret;
    },
    async login(secret:string) {
      const cookie=newSecret();const csrfToken=secretHash(`csrf\0${cookie}`);const now=ctx.clock.now();
      const session:BrowserSession={id:randomUUID(),hash:secretHash(cookie),csrfHash:secretHash(csrfToken),createdAt:now,expiresAt:now+30*24*60*60_000};
      await ctx.store.transact(tx=>{
        const bootstrap=tx.get<{hash:string;expiresAt:number}>('auth-bootstrap','login');
        if(!bootstrap || bootstrap.expiresAt<=now || !matches(secret,bootstrap.hash))throw new AppError('UNAUTHORIZED','Invalid or expired login secret');
        tx.delete('auth-bootstrap','login');tx.insert('auth-session',session.hash,session);
      });return {session,cookie,csrfToken};
    },
    async authenticate(cookieHeader:string|undefined):Promise<BrowserSession|undefined> {
      const cookie=cookieHeader?cookieSecret(cookieHeader):undefined;
      if(!cookie)return undefined;
      const session=await ctx.store.read<BrowserSession>('auth-session',secretHash(cookie));
      return session && session.expiresAt>ctx.clock.now()?session:undefined;
    },
    csrfToken(cookieHeader:string){return secretHash(`csrf\0${cookieSecret(cookieHeader)??''}`);},
    async list(){return (await ctx.store.list<BrowserSession>('auth-session')).filter(s=>s.expiresAt>ctx.clock.now()).map(({id,createdAt,expiresAt})=>({id,createdAt,expiresAt}));},
    async revoke(id:string){const sessions=await ctx.store.list<BrowserSession>('auth-session');
      await ctx.store.transact(tx=>{for(const session of sessions)if(session.id===id)tx.delete('auth-session',session.hash);});
    },
  };
}
export type BrowserSessions=ReturnType<typeof openBrowserSessions>;
