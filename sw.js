/**
 * Service Worker for 試卷出題配圖生成大師
 *
 * Purpose: enable cross-tab version-update detection. Does NOT cache requests
 * (this app is online-only; offline support not needed). The BUILD_VERSION
 * placeholder gets replaced by GitHub Actions on every deploy, so sw.js byte
 * content always differs → browser always detects update → install + activate
 * lifecycle fires → SW_ACTIVATED postMessage tells the page to show banner.
 *
 * Per skill `pwa-cache-bust` 雷 #12: if BUILD_VERSION stays constant the SW is
 * byte-identical across deploys and browsers never detect updates.
 */

const BUILD_VERSION = '__BUILD_VERSION__';

self.addEventListener('install', (event) => {
  // Take over immediately, don't wait for old SW to release clients
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      // Broadcast to all open tabs that a new SW just activated
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'SW_ACTIVATED', version: BUILD_VERSION });
      }
    })()
  );
});

// No fetch handler — we intentionally don't cache. Browser + GitHub Pages CDN
// handle HTTP caching. SW exists purely for update-notification lifecycle.
