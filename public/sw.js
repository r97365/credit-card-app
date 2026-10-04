const CACHE_NAME = 'card-rewards-shell-v1'

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    const scope = self.registration.scope
    try {
      await cache.addAll([
        scope,
        new URL('manifest.webmanifest', scope).href,
        new URL('icon.svg', scope).href,
      ])
    } catch {
      // Runtime caching will fill these later if first install happens on a weak connection.
    }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/version.json')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      try {
        const response = await fetch(request)
        if (response.ok) {
          await cache.put(new Request(self.registration.scope), response.clone())
        }
        return response
      } catch {
        return (await cache.match(new Request(self.registration.scope))) ||
          new Response('<!doctype html><html><body style="margin:0;background:#0b0c0f;color:#aaa;font-family:-apple-system;display:grid;place-items:center;min-height:100vh">Card Rewards 離線中</body></html>', { headers:{'Content-Type':'text/html; charset=utf-8'} })
      }
    })())
    return
  }

  if (['script','style','image','font','manifest'].includes(request.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(request)
      const network = fetch(request).then(response => {
        if (response.ok) cache.put(request, response.clone())
        return response
      }).catch(() => null)
      return cached || (await network) || Response.error()
    })())
  }
})
