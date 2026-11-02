import type { Context } from 'hono';
import type { StateContext } from '../instance/state.js';
import { COOKIE_NAME, type BrowserSessions } from '../auth/sessions.js';
import { openTokens } from '../auth/tokens.js';
import type { Principal,Route } from './routes.js';
import * as S from './schemas.js';
export function authRoutes(ctx:StateContext,auth:BrowserSessions,origin:string,principal:(c:Context)=>Principal,onCancel?:(id:string)=>void):Route[]{
 const tokens=openTokens(ctx);const param=(c:Context)=>c.req.param('id')!;
 const cookie=(value:string,maxAge:number)=>`${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith('https:')?'; Secure':''}`;
 return [
    {method:'POST',path:'/auth/login',body:S.LoginSchema,response:S.AuthSessionSchema,async handle(c,body){
      const result=await auth.login((body as {secret:string}).secret);c.header('set-cookie',cookie(result.cookie,30*24*60*60));return {id:result.session.id,csrfToken:result.csrfToken,expiresAt:result.session.expiresAt};
    }},
    {method:'GET',path:'/auth/session',response:S.AuthSessionSchema,browserOnly:true,async handle(c){const session=principal(c).session!;return {id:session.id,csrfToken:auth.csrfToken(c.req.header('cookie')!),expiresAt:session.expiresAt};}},
    {method:'GET',path:'/auth/sessions',response:S.BrowserSessionListSchema,browserOnly:true,async handle(){return auth.list();}},
    {method:'DELETE',path:'/auth/sessions/:id',response:S.OkSchema,browserOnly:true,async handle(c){onCancel?.(param(c));await auth.revoke(param(c));return {ok:true};}},
    {method:'POST',path:'/auth/logout',body:S.EmptySchema,response:S.OkSchema,browserOnly:true,async handle(c){onCancel?.(principal(c).id);await auth.revoke(principal(c).id);c.header('set-cookie',cookie('',0));return {ok:true};}},
    {method:'POST',path:'/auth/tokens',body:S.TokenInputSchema,response:S.CreatedTokenSchema,status:201,browserOnly:true,async handle(_c,body){const input=body as S.TokenInput;return tokens.create(input.name,input.scopes);}},
    {method:'GET',path:'/auth/tokens',response:S.Type.Array(S.TokenSchema),browserOnly:true,async handle(){return tokens.list();}},
    {method:'DELETE',path:'/auth/tokens/:id',response:S.OkSchema,browserOnly:true,async handle(c){await tokens.revoke(param(c));return {ok:true};}},
 ];
}
