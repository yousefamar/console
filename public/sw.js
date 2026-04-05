// Console PWA Service Worker — caches app shell for offline startup + notification clicks
const CACHE_NAME = 'console-v1'

// Cache app shell on install
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['/']))
  )
  self.skipWaiting()
})

// Clean old caches on activate
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Network-first for navigation, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event

  // Skip non-GET and cross-origin
  if (request.method !== 'GET') return
  if (!request.url.startsWith(self.location.origin)) return

  // Skip API calls and WebSocket upgrades
  if (request.url.includes('/api/')) return

  // Navigation requests: network-first (always get latest HTML)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
          return response
        })
        .catch(() => caches.match(request))
    )
    return
  }

  // Static assets: cache-first (JS/CSS are hashed by Vite)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached
      return fetch(request).then((response) => {
        if (response.ok) {
          const clone = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        }
        return response
      })
    })
  )
})

// Handle notification clicks — focus app window and route to correct pane
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length > 0) {
        clients[0].focus()
        clients[0].postMessage({ type: 'notification-click', data: event.notification.data })
      } else {
        self.clients.openWindow('/')
      }
    })
  )
})
