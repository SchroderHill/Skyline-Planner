// Service worker: cache-first strategy for raster tile requests
// Tiles are cached on disk so repeat visits and basemap switches are instant.

const CACHE_NAME = "skyline-basemap-v1";

const TILE_HOSTS = new Set([
  "mt0.google.com",
  "mt1.google.com",
  "mt2.google.com",
  "mt3.google.com",
  "basemaps.linz.govt.nz",
  "sh.dataspace.copernicus.eu",
]);

function isTile(url) {
  try {
    return TILE_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  // Delete old cache versions when the sw updates
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (!isTile(event.request.url)) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      if (cached) return cached;

      const response = await fetch(event.request);
      if (response.ok) {
        // Clone before consuming — cache the copy, return the original
        cache.put(event.request, response.clone());
      }
      return response;
    })
  );
});
