/* The Jewels — service worker.
 *
 * Deliberately tiny. This exists so the browser will hand out a push
 * subscription at all; it does not cache anything, because a stale cache of a
 * comic reader is a worse problem than a slow one.
 */

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'The Jewels', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'The Jewels', {
      body: payload.body || '',
      icon: '/icon-192.png',
      badge: '/icon-32.png',
      // Same tag, so two chapters announced close together replace rather than
      // stack into a pile of notifications nobody reads.
      tag: payload.tag || 'the-jewels',
      data: { url: payload.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;

  // Focus a tab that already has the site open rather than piling up new ones.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
