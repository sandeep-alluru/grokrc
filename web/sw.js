/**
 * Service worker — receives push notifications when the app is closed.
 *
 * This is the only part of grokrc that runs when your phone is locked in your
 * pocket, which is exactly when the agent gets blocked on an approval.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Grok', body: 'Update' };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Grok', {
      body: data.body || '',
      // Same tag replaces rather than stacks, so one blocked agent produces one
      // notification instead of a pile.
      tag: data.tag,
      renotify: true,
      // Approvals stay on screen until acted on; completions can auto-dismiss.
      requireInteraction: !!data.requireInteraction,
      vibrate: data.requireInteraction ? [40, 60, 40] : [30],
      data: { sessionId: data.sessionId, requestId: data.requestId },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const { sessionId } = event.notification.data || {};
  const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : '/';

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse an open tab if there is one — opening a second copy of the app
      // would leave the user looking at a stale session list.
      for (const client of all) {
        if ('focus' in client) {
          client.postMessage({ type: 'open-session', sessionId });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});
