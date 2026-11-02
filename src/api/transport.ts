import { Hono } from 'hono';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { bodyLimit } from 'hono/body-limit';
import type { Context } from 'hono';
import { Value } from 'typebox/value';
import { AppError, type Json } from '../contracts/base.js';
import { matches, secretHash, type BrowserSessions } from '../auth/sessions.js';
import { openTokens } from '../auth/tokens.js';
import { apiError } from './errors.js';
import type { Principal, Route } from './routes.js';
import type { StateContext } from '../instance/state.js';
import { ErrorSchema, EventSchema, ResetSchema, SseMessageSchema } from './schemas.js';
export interface TransportSecurity {principal(c:Context):Principal;authorize(c:Context):Promise<Principal>}
export interface TransportOptions {state:StateContext;auth:BrowserSessions;origin:string;describe:(security:TransportSecurity)=>Route[];webAssetsDir?:string;notReady?:boolean}
const lifetimes=new WeakMap<Hono,{closing:boolean;active:Set<Promise<unknown>>}>();
export async function closeTransport(app:Hono):Promise<void>{const lifecycle=lifetimes.get(app);if(!lifecycle)return;lifecycle.closing=true;await Promise.allSettled([...lifecycle.active]);}
function canonical(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
  return JSON.stringify(value);
}
interface Receipt {fingerprint:string;requestId:string;response?:Json}
export function createTransport(options:TransportOptions):Hono {
  const app=new Hono();const ctx=options.state;const auth=options.auth;const tokens=openTokens(ctx);const lifecycle={closing:false,active:new Set<Promise<unknown>>()};lifetimes.set(app,lifecycle);
  const origin=options.origin;let url:URL;
  try{url=new URL(origin);}catch{throw new AppError('INVALID_ORIGIN','Configure a valid public origin');}
  if(url.origin!==origin || !['http:','https:'].includes(url.protocol))throw new AppError('INVALID_ORIGIN','Use an exact HTTP or HTTPS origin');
  const principals=new WeakMap<Context,Principal>();
  const principal=(c:Context)=>principals.get(c)!;
  const authorize=async(c:Context):Promise<Principal>=>{
    const authorization=c.req.header('authorization');
    if(authorization!==undefined){
      const match=/^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);const token=match?await tokens.authenticate(match[1]!):undefined;
      if(!token)throw new AppError('UNAUTHORIZED','Valid authentication is required');return {id:token.id,kind:'token',scopes:token.scopes};
    }
    const session=await auth.authenticate(c.req.header('cookie'));if(!session)throw new AppError('UNAUTHORIZED','Valid authentication is required');
    return {id:session.id,kind:'browser',scopes:['read','write'],session};
  };
  const descriptors=options.describe({principal,authorize});
  const transient=new Map<string,{fingerprint:string;expiresAt:number;work:Promise<unknown>}>();
  const inFlight=new Map<string,Promise<unknown>>();
  app.use('/api/v1/*',async(_c,next)=>{if(lifecycle.closing)throw new AppError('API_CLOSED','The application is stopping');const work=next();lifecycle.active.add(work);try{await work;}finally{lifecycle.active.delete(work);}});
  app.use('/api/v1/*',bodyLimit({maxSize:1_048_576,onError:c=>c.json({error:{code:'INVALID_REQUEST',message:'Request body is too large'}},400)}));
  app.use('/api/v1/*',async(c,next)=>{c.header('cache-control','no-store');c.header('x-content-type-options','nosniff');await next();});
  app.onError((error,c)=>{const result=apiError(error);return c.json(result.body,result.status);});
  app.notFound(c=>c.json({error:{code:'NOT_FOUND',message:'Unknown API route'}},404));
  for(const route of descriptors)app.on(route.method,'/api/v1'+route.path,async c=>{
    const login=route.path==='/auth/login';const mutation=route.method!=='GET';
    if(login){if(c.req.header('origin')!==origin)throw new AppError('FORBIDDEN','Use the configured same origin');}
    else {
      const who=await authorize(c);principals.set(c,who);
      if(!who.scopes.includes(mutation?'write':'read') || (route.browserOnly&&who.kind!=='browser'))throw new AppError('FORBIDDEN','This credential does not allow this operation');
      if(mutation && who.kind==='browser' && (c.req.header('origin')!==origin || !matches(c.req.header('x-csrf-token')??'',who.session!.csrfHash)))throw new AppError('FORBIDDEN','Same-origin request and valid CSRF token are required');
    }
    let body:unknown={};
    if(route.body){
      const raw=await c.req.text();
      if(raw && !/^application\/json(?:\s*;|$)/i.test(c.req.header('content-type')??''))throw new AppError('INVALID_REQUEST','Use application/json');
      try{body=raw?JSON.parse(raw):{};}catch{throw new AppError('INVALID_REQUEST','Request body is not JSON');}
      if(!Value.Check(route.body,body))throw new AppError('INVALID_REQUEST','Request body does not match the API schema');
    }
    const run=async(requestId:string)=>{
      const output=await route.handle(c,body,requestId);
      if(output instanceof Response)return output;
      if(!Value.Check(route.response,output))throw new AppError('INTERNAL_CONTRACT','Service response does not match the public contract',{path:c.req.path,issues:[...Value.Errors(route.response,output)].map(e=>({path:e.instancePath,message:e.message}))});
      return output;
    };
    let output:unknown;
    if(route.transient){
      const key=c.req.header('idempotency-key');if(!key||key.length>256||/[\x00-\x20\x7f]/.test(key))throw new AppError('INVALID_REQUEST','A nonempty Idempotency-Key of at most 256 characters is required');
      const now=Date.now();for(const [id,receipt] of transient)if(receipt.expiresAt<=now)transient.delete(id);
      const id=secretHash(`${principal(c).id}\0${key}`),fingerprint=secretHash(`${route.method}\0${c.req.path}\0${canonical(body)}`);
      let receipt=transient.get(id);
      if(receipt&&receipt.fingerprint!==fingerprint)throw new AppError('REQUEST_CONFLICT','Idempotency key was already used for a different request');
      if(!receipt){if(transient.size>=1000)throw new AppError('REQUEST_LIMIT','Too many sign-in actions. Try again later.');receipt={fingerprint,expiresAt:now+10*60_000,work:run('transient-'+id)};transient.set(id,receipt);}
      output=await receipt.work;
    }else if(route.idempotent){
      const key=c.req.header('idempotency-key');if(!key || key.length>256 || /[\x00-\x20\x7f]/.test(key))throw new AppError('INVALID_REQUEST','A nonempty Idempotency-Key of at most 256 characters is required');
      const id=secretHash(`${principal(c).id}\0${key}`);const fingerprint=secretHash(`${route.method}\0${c.req.path}\0${canonical(body)}`);
      // Persist intent before touching execution; service-level stable IDs recover a lost API receipt.
      const receipt=await ctx.store.transact(tx=>{
        const previous=tx.get<Receipt>('api-request',id);
        if(previous && previous.fingerprint!==fingerprint)throw new AppError('REQUEST_CONFLICT','Idempotency key was already used for a different request');
        const next=previous??{fingerprint,requestId:'http-'+id};if(!previous)tx.insert('api-request',id,next);return next;
      });
      if(receipt.response!==undefined)output=receipt.response;
      else {
        let work=inFlight.get(id);
        if(!work){work=(async()=>{const result=await run(receipt.requestId);await ctx.store.transact(tx=>tx.put('api-request',id,{...receipt,response:result}));return result;})();inFlight.set(id,work);}
        try{output=await work;}finally{if(inFlight.get(id)===work)inFlight.delete(id);}
      }
    }else output=await run('');
    if(output instanceof Response)return output;
    return c.json(output as never,route.status??200);
  });
  app.get('/api/v1/openapi.json',async c=>{const who=await authorize(c);if(!who.scopes.includes('read'))throw new AppError('FORBIDDEN','Read scope is required');return c.json(openApi(descriptors,origin));});
  if(options.notReady)app.on(['GET','POST','PUT','DELETE'],'/api/v1/*',async c=>{
    if(!/^\/api\/v1\/(?:instance|snapshot|events|setup|models|agents|groups|projects|sessions|tasks|decisions|workspaces|knowledge|skills|learning|inbox|routines|schedules|sync|remote-status)(?:\/|$)/.test(c.req.path))return c.notFound();
    const who=await authorize(c);const mutation=c.req.method!=='GET';if(!who.scopes.includes(mutation?'write':'read'))throw new AppError('FORBIDDEN','This credential does not allow this operation');if(mutation&&who.kind==='browser'&&(c.req.header('origin')!==origin||!matches(c.req.header('x-csrf-token')??'',who.session!.csrfHash)))throw new AppError('FORBIDDEN','Same-origin request and valid CSRF token are required');throw new AppError('INSTANCE_NOT_READY','Choose a vault and complete initialization before using the workspace');
  });
  serveWeb(app,options.webAssetsDir??fileURLToPath(new URL('../web/',import.meta.url)));
  return app;
}
function openApi(descriptors:Route[],origin:string) {
  const paths:Record<string,Record<string,unknown>>={};
  for(const route of descriptors){
    const path='/api/v1'+route.path.replace(/:([A-Za-z]+)/g,'{$1}');const parameters:unknown[]=[...route.path.matchAll(/:([A-Za-z]+)/g)].map(match=>({name:match[1],in:'path',required:true,schema:{type:'string',minLength:1}}));
    const mutation=route.method!=='GET';const login=route.path==='/auth/login';
    if(mutation){
      parameters.push({name:'Origin',in:'header',required:login||!!route.browserOnly,description:login?'Required exact configured browser origin.':'Required for cookie-authenticated mutations; bearer authentication does not require this header.',schema:{type:'string',const:origin},...login?{}:{'x-required-with':'browserSession'}});
      if(!login)parameters.push({name:'X-CSRF-Token',in:'header',required:!!route.browserOnly,description:'Required for cookie-authenticated mutations. Obtain from login or GET /api/v1/auth/session; bearer authentication does not require this header.',schema:{type:'string',minLength:1},'x-required-with':'browserSession'});
    }
    if(route.idempotent||route.transient)parameters.push({name:'Idempotency-Key',in:'header',required:true,schema:{type:'string',minLength:1,maxLength:256}});
    if(route.path==='/events')parameters.push({name:'Last-Event-ID',in:'header',schema:{type:'string',pattern:'^(0|[1-9][0-9]*)$'}},{name:'after',in:'query',schema:{type:'string',pattern:'^(0|[1-9][0-9]*)$'}});
    for(const item of route.query??[])parameters.push({name:item.name,in:'query',required:item.required??false,schema:item.schema});
    const status=String(route.status??200);const media=route.path==='/events'?'text/event-stream':'application/json';
    const responses:Record<string,unknown>={[status]:{description:route.path==='/events'?'SSE frames: regular events have id=seq, event=AppEvent.kind and JSON AppEvent data. Reset frames have event=reset, JSON EventReset data and no id; refresh the snapshot and reconnect at its seq. Heartbeats are SSE comments.':'Success',content:{[media]:{schema:route.response}}}};
    for(const code of ['400','401','403','404','409','422','500'])responses[code]={description:'Request failed',content:{'application/json':{schema:ErrorSchema}}};
    (paths[path]??={})[route.method.toLowerCase()]={...(mutation?{description:login?'Bootstrap login requires the configured Origin.':`Origin and X-CSRF-Token are required for cookie-authenticated mutations.${route.browserOnly?'':' Bearer tokens use their explicit scope without browser headers.'}`}:{ }),operationId:route.method.toLowerCase()+route.path.replace(/[^a-zA-Z0-9]/g,'_'),parameters,security:route.path==='/auth/login'?[]:route.browserOnly?[{browserSession:[]}]:[{browserSession:[]},{bearerToken:[]}],...(route.body?{requestBody:{required:true,content:{'application/json':{schema:route.body}}}}:{}),responses};
  }
  paths['/api/v1/openapi.json']={get:{responses:{200:{description:'OpenAPI 3.1 document',content:{'application/json':{schema:{type:'object'}}}}},security:[{browserSession:[]},{bearerToken:[]}]}};
  return {openapi:'3.1.0',info:{title:'Lorecrew API',version:'1.0.0'},components:{schemas:{AppEvent:EventSchema,EventReset:ResetSchema,SseMessage:SseMessageSchema},securitySchemes:{browserSession:{type:'apiKey',in:'cookie',name:'lorecrew_session',description:'Cookie mutations require exact configured Origin and X-CSRF-Token from login or GET /api/v1/auth/session.'},bearerToken:{type:'http',scheme:'bearer',description:'Instance-local token with read and/or write scopes'}}},paths};
}

/** Built assets are public; private routes never fall through to the SPA. */
function serveWeb(app:Hono,directory:string) {
  const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json','.woff2':'font/woff2'};
  app.get('*',async c=>{
    const path=c.req.path;
    if(/^\/(api|auth)(?:\/|$)/.test(path))return c.notFound();
    let decoded:string;try{decoded=decodeURIComponent(path);}catch{return c.notFound();}
    if(/[\\\0]/.test(decoded)||decoded.split('/').some(part=>part==='.'||part==='..')||/%(?:2f|5c)/i.test(path))return c.notFound();
    const filename=decoded==='/'?'index.html':decoded.slice(1);
    const load=async(name:string)=>{
      try{
        const root=await realpath(directory);const file=await realpath(resolve(root,name));
        if(!file.startsWith(root+sep))return undefined;
        return {bytes:await readFile(file),name};
      }catch{return undefined;}
    };
    const file=await load(filename)??(!extname(filename)?await load('index.html'):undefined);
    if(!file)return c.notFound();
    const versioned=/^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?)$/.test(file.name);
    return new Response(file.bytes,{headers:{'content-type':mime[extname(file.name)]??'application/octet-stream','cache-control':versioned?'public, max-age=31536000, immutable':'no-store','x-content-type-options':'nosniff'}});
  });
}
