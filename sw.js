// Ekip İletişim service worker: yalnız bildirim. Sayfa kapalıyken gelen Web Push'u gösterir, dokununca uygulamayı açar.
// Önbellek ya da ağ isteği işlemez (sayfa her zaman güncel sürümden yüklenir).
self.addEventListener('push', (e) => {
  let v = {};
  try { v = e.data ? e.data.json() : {}; } catch (h) { v = { govde: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(v.baslik || 'Ekip İletişim', {
    body: v.govde || '', icon: 'simge-192.png', badge: 'simge-192.png', lang: 'tr',
    tag: v.etiket || undefined, renotify: !!v.etiket, requireInteraction: !!v.cagri, // görüşme çağrısı kendiliğinden kaybolmaz
    vibrate: v.cagri ? [300, 150, 300, 150, 300] : [120], data: { url: v.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const pencereler = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const acik = pencereler.find((w) => w.url.startsWith(self.registration.scope));
    if (acik) { await acik.focus(); return acik.navigate(url).catch(() => clients.openWindow(url)); }
    return clients.openWindow(url);
  })());
});
