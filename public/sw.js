const CACHE='govcareer-shell-v21';
const ASSETS=['/','/index.html','/styles.css','/app.js','/account.js','/account.css','/bridge.js','/bridge.css','/live.js','/metrics.js','/live.css','/autolive.js','/autolive.css','/advanced.js','/advanced.css','/jobsplus.js','/jobsplus.css','/prep.js','/prep.css','/embed.css','/embed.js','/trust.js','/trust.css','/national.js','/national.css','/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
 const u=new URL(e.request.url);
 if(u.pathname.startsWith('/api/')||u.pathname.startsWith('/campus'))return;
 if(e.request.mode==='navigate'||u.pathname==='/'||u.pathname==='/index.html'){e.respondWith(fetch(e.request).catch(()=>caches.match('/index.html')));return;}
 e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return r}).catch(()=>caches.match('/index.html'))));
});

// v2.10.0 Web Push: a new official notice arrives here even when the site is closed. Text comes from the server's stored event only.
self.addEventListener('push',e=>{
 let d={}; try{d=e.data?e.data.json():{}}catch(_){d={title:'GovCareer AI',body:e.data?e.data.text():''}}
 const https=u=>{try{const x=new URL(u);return x.protocol==='https:'?x.href:null}catch(_){return null}};
 const data={url:'/?open=latest',official_url:https(d.official_url),feed_id:d.feed_id||null};
 const actions=data.official_url?[{action:'official',title:'Official notice'}]:[];
 e.waitUntil(self.registration.showNotification(String(d.title||'GovCareer AI').slice(0,120),{body:String(d.body||'').slice(0,260),tag:String(d.tag||'gc'),data,actions,requireInteraction:false,badge:undefined}));
});
self.addEventListener('notificationclick',e=>{
 e.notification.close(); const d=e.notification.data||{};
 const target=(e.action==='official'&&d.official_url)?d.official_url:(d.url||'/');
 e.waitUntil((async()=>{
  if(target.startsWith('http')){await clients.openWindow(target);return}
  const all=await clients.matchAll({type:'window',includeUncontrolled:true});
  for(const c of all){if(new URL(c.url).origin===self.location.origin){try{await c.focus();c.postMessage({type:'gc:feed'});return}catch(_){}}}
  await clients.openWindow(target);
 })());
});
