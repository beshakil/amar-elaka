/*
 * Web Push for the site (ADR 060). FCM delivers a push here, to our own
 * service worker — no Firebase script runs in it and no config is baked in.
 * The page gets the FCM token with this registration (lib/notifications/web-push.ts).
 *
 *  - The site is open and in front: the page already shows chat live and the
 *    bell refreshes, so the push is handed to it instead of a system banner.
 *  - Otherwise: the API's rendered Bengali title and body, collapsed by tag
 *    ("৪টি নতুন মেসেজ" replaces the one before it).
 *  - A click opens /notifications/open, which marks it read and goes to the
 *    exact page (one mapping, lib/notifications/links.ts).
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch {
        payload = {};
      }
      const notification = payload.notification || {};
      const data = payload.data || {};
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const front = windows.find((w) => w.focused && w.visibilityState === 'visible');
      if (front) {
        front.postMessage({ type: 'amar-elaka:push', data });
        return;
      }
      const title = notification.title || data.title || '';
      if (!title && !notification.body) return;
      await self.registration.showNotification(title, {
        body: notification.body || data.body || '',
        tag: notification.tag || data.collapseKey || undefined,
        renotify: Boolean(notification.tag),
        lang: 'bn',
        data: { deepLink: data.deepLink || null, notificationId: data.notificationId || null },
      });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { deepLink, notificationId } = event.notification.data || {};
  const url = new URL('/notifications/open', self.location.origin);
  if (deepLink) url.searchParams.set('link', deepLink);
  if (notificationId) url.searchParams.set('id', notificationId);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        await open.navigate(url.href);
        return;
      }
      await self.clients.openWindow(url.href);
    })(),
  );
});
