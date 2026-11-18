/* NEXUS v1.03 — cache exclusivo de arte; app y Firebase siempre vía red. */
const CACHE='nexus-art-v103';
self.addEventListener('install',event=>{self.skipWaiting();});
self.addEventListener('activate',event=>{event.waitUntil(self.clients.claim());});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||!url.pathname.includes('/assets/'))return;
  event.respondWith(caches.open(CACHE).then(async cache=>{
    const hit=await cache.match(event.request);if(hit)return hit;
    const response=await fetch(event.request);if(response.ok)cache.put(event.request,response.clone());return response;
  }));
});
