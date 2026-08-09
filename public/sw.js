/**
 * Service worker: the only thing that can show an alert when the app is closed.
 *
 * Deliberately does nothing else. It does not cache pages and it does not
 * intercept requests — a stale cache in a kitchen app is a way to show somebody
 * yesterday's numbers, which is worse than being offline.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  const title = data.title || 'Breakfast';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || 'A day sheet was submitted.',
    // Same tag every morning, so a re-submission replaces the earlier alert
    // rather than stacking a second one underneath it.
    tag: data.day ? `day-${data.day}` : 'breakfast',
    renotify: true,
    // No icon is named on purpose: the browser falls back to the site's own,
    // and pointing at a file that does not exist gets you a broken one.
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';

  // Bring an already-open tab forward rather than opening a second one.
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
        if ('navigate' in client && target) await client.navigate(target).catch(() => {});
        return client.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
