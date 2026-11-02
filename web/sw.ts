/// <reference lib="webworker" />
const worker=self as unknown as ServiceWorkerGlobalScope;
const cacheName='lorecrew-assets-__LORECREW_BUILD__';
worker.addEventListener('message',event=>{if(event.data?.type==='ACTIVATE_UPDATE')event.waitUntil(worker.skipWaiting());});
worker.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('lorecrew-assets-')&&name!==cacheName)await caches.delete(name);await worker.clients.claim();})()));
worker.addEventListener('fetch',event=>{
  const request=event.request;const url=new URL(request.url);
  // No API, HTML, credentials, or user-created content is cached. Only Vite's hashed app files qualify.
  if(request.method!=='GET'||url.origin!==worker.location.origin||!/^\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(url.pathname)){
    if(request.mode==='navigate'&&url.origin===worker.location.origin&&!url.pathname.startsWith('/api/'))event.respondWith(fetch(request).catch(()=>new Response('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Unavailable offline</title><body><h1>Unavailable offline</h1><p>Reconnect to your local Lorecrew instance. Work continues only while the service host runs. Reconnecting does not send unsent drafts.</p></body></html>',{status:503,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})));
    return;
  }
  event.respondWith((async()=>{const cache=await caches.open(cacheName);const cached=await cache.match(url.href);if(cached)return cached;const response=await fetch(new Request(request,{credentials:'omit'}));if(response.ok&&!response.headers.has('set-cookie'))await cache.put(url.href,response.clone());return response;})());
});
