// Callout — cache para abrir rápido e funcionar sem internet depois da primeira visita
const V='callout-v145';
const CORE=['./','index.html','three.min.js','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
  const r=e.request;if(r.method!=='GET')return;
  const u=new URL(r.url);
  if(r.mode==='navigate'){ // página: tenta a rede (pega versão nova) e cai para o cache sem internet
    e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(ca=>ca.put('index.html',c));return x;}).catch(()=>caches.match('index.html')));return;}
  if(/\.bin$/.test(u.pathname)){ // malha real: rede primeiro, cache como plano B (evita entrada truncada travar o mapa)
    e.respondWith(fetch(r).then(x=>{const c=x.clone();caches.open(V).then(ca=>ca.put(r,c));return x;}).catch(()=>caches.match(r)));return;}
  if(u.origin===location.origin){e.respondWith(caches.match(r).then(m=>m||fetch(r).then(x=>{const c=x.clone();caches.open(V).then(ca=>ca.put(r,c));return x;})));return;}
  if(/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)){ // fontes: usa o cache e atualiza em segundo plano
    e.respondWith(caches.open(V).then(ca=>ca.match(r).then(m=>{const n=fetch(r).then(x=>{ca.put(r,x.clone());return x;}).catch(()=>m);return m||n;})));}
});
