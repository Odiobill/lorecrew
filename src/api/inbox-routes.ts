import type {ApiOptions,Route} from './routes.js';
import * as S from './schemas.js';
import {openInbox} from '../attention/service.js';
import {stableId} from '../runtime/admission.js';
export function inboxRoutes(options:ApiOptions):Route[]{const {ctx}=options,inbox=openInbox(options);return [
 {method:'GET',path:'/inbox',response:S.InboxSchema,handle:()=>inbox.list()},
 {method:'GET',path:'/inbox/results/:id',response:S.InboxResultSchema,query:[{name:'revision',schema:S.Type.String({minLength:1,maxLength:128})}],handle:c=>inbox.result(c.req.param('id')!,c.req.query('revision'))},
 {method:'GET',path:'/sessions/:id/results',response:S.SessionResultsSchema,handle:c=>inbox.resultsForSession(c.req.param('id')!)},
 {method:'GET',path:'/inbox/seen',response:S.InboxSeenSchema,async handle(){return {items:await ctx.store.list<{id:string;revision:string}>('ui-inbox-seen')};}},
 {method:'PUT',path:'/inbox/seen',body:S.InboxMarkerSchema,response:S.OkSchema,idempotent:true,async handle(_c,body){const marker=body as {id:string;revision:string};await ctx.store.transact(tx=>{const id=stableId(marker.id,marker.revision);if(!tx.get('ui-inbox-seen',id)){tx.put('ui-inbox-seen',id,marker);tx.emit('inbox.updated',{id:marker.id});}});return {ok:true};}},
 ];}
