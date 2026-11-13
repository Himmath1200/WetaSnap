/* Push notifications (imported into the generated service worker).
   The server sends { id, kind, title, body, link }. */
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'WeTa Snap', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'WeTa Snap';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.kind || 'wetasnap',
      data: { link: data.link || '/', id: data.id },
      renotify: false,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) { client.navigate(link); return client.focus(); }
      }
      return self.clients.openWindow(link);
    }),
  );
});

/* Background Sync API (triggers outbox flush when connectivity returns in background) */
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-leads' || event.tag === 'wetasnap-outbox') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        for (const client of clients) {
          client.postMessage({ type: 'WETASNAP_TRIGGER_SYNC' });
        }
      }),
    );
  }
});
