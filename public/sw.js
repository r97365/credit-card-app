const CACHE_NAME = 'card-rewards-shell-v4'
const APP_URL = self.registration.scope

function sameAppUrl(value) {
  try {
    const url = new URL(value, APP_URL)
    return url.origin === self.location.origin &&
      url.href.startsWith(APP_URL) &&
      !url.pathname.endsWith('/version.json') &&
      !url.pathname.endsWith('/sw.js')
  } catch {
    return false
  }
}

async function cacheResponse(cache, request, response) {
  if (response?.ok) await cache.put(request, response.clone())
  return response
}

async function cacheBuildAssets(cache, html) {
  const optionalUrls = [
    new URL('manifest.webmanifest', APP_URL).href,
    new URL('icon.svg', APP_URL).href,
  ]
  const requiredUrls = new Set()
  const pattern = /(?:src|href)=["']([^"']+)["']/g
  let match
  while ((match = pattern.exec(html))) {
    const absolute = new URL(match[1], APP_URL).href
    if (sameAppUrl(absolute) && /\.(?:js|css)(?:[?#]|$)/.test(absolute)) {
      requiredUrls.add(absolute)
    }
  }
  if (!requiredUrls.size) throw new Error('No application assets found in the HTML')

  // Cache all required JS/CSS before publishing the new HTML entry point.
  // This prevents an offline white screen after an interrupted update.
  await Promise.all([...requiredUrls].map(async url => {
    const cached = await cache.match(url)
    if (cached) return
    const response = await fetch(url, { cache:'no-store' })
    if (!response.ok) throw new Error('Missing app asset: ' + url)
    await cache.put(url,response)
  }))
  await Promise.allSettled(optionalUrls.map(async url => {
    const response = await fetch(url,{ cache:'no-store' })
    if (response.ok) await cache.put(url,response)
  }))
}

async function fetchAndCacheShell(cache) {
  const response = await fetch(APP_URL, { cache:'no-store' })
  if (!response.ok) throw new Error('App shell fetch failed')

  const html = await response.clone().text()
  await cacheBuildAssets(cache,html)
  await cache.put(APP_URL,response.clone())
  return response
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await fetchAndCacheShell(cache)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    const shell = await cache.match(APP_URL)

    // Only remove the previous working cache after the new shell is safely available.
    if (shell) {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter(key => key.startsWith('card-rewards-shell-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    }

    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.endsWith('/version.json') || url.pathname.endsWith('/sw.js')) return

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      const cachedShell = await cache.match(APP_URL)

      // App startup is cache-first: never make a weak connection block the first paint.
      if (cachedShell) {
        event.waitUntil(fetchAndCacheShell(cache).catch(() => {}))
        return cachedShell
      }

      try {
        return await fetchAndCacheShell(cache)
      } catch {
        return new Response(
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b0c0f"></head><body style="margin:0;background:#0b0c0f;color:#858d98;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:100vh">Card Rewards 離線中</body></html>',
          { headers:{'Content-Type':'text/html; charset=utf-8'} }
        )
      }
    })())
    return
  }

  if (['script','style','image','font','manifest'].includes(request.destination)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME)
      const cached = await cache.match(request)
      if (cached) return cached

      try {
        const response = await fetch(request)
        return await cacheResponse(cache, request, response)
      } catch {
        return Response.error()
      }
    })())
  }
})
