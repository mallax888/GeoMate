"use strict";

/* The app has to open INSTANTLY, and it must not be a version behind. The first attempt at this
 * traded the first thing away for the second and it was the wrong trade.
 *
 * It used to be network-first for the app shell: every load waited for the server before it would
 * use the copy it already had. That did keep it current, and it also meant a repeat visit on a slow
 * link took 4.1-4.6 seconds with the whole app already sitting in the cache. Measured, against a
 * deliberately slow server, with the service worker installed and everything cached.
 *
 * So: CACHE FIRST, always, for everything. The stored copy is served immediately and the network is
 * checked afterwards, in the background, off the critical path. When that check finds a genuinely
 * different file, the new one is stored and every open tab is told — the page puts up a small
 * "new version ready" bar with a Reload button, so an update is one click away and never costs a
 * wait. Worst case the user is one visit behind and can see that they are, which is a far better
 * deal than several seconds on every single open.
 *
 * CACHE_NAME is still bumped on a deploy — activate() drops every other cache, which clears
 * anything an older version of this file left behind.
 */
const CACHE_NAME = "geomate-v168";

const ASSETS = [
  "./",
  "./index.html",
  "./assets/style.css",
  "./assets/app.js",
  "./manifest.webmanifest",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-192.png",
  "./assets/icons/icon-maskable-512.png",
  // Precached too, so the first time the app opens with no signal it still has its own typefaces
  // rather than falling back to whatever the device happens to have.
  "./assets/fonts/PlexSans-400.woff2",
  "./assets/fonts/PlexSans-600.woff2",
  "./assets/fonts/PlexSans-700.woff2",
  "./assets/fonts/PlexMono-400.woff2",
  "./assets/fonts/PlexMono-600.woff2",
];

self.addEventListener("install", (event) => {
  // One missing file must not fail the whole install and leave the app with no offline copy at all,
  // so each is added on its own and a failure is skipped.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => Promise.all(ASSETS.map((url) => cache.add(url).catch(() => null))))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

/** Whether this request carries the app itself, as opposed to a font, an icon or the manifest. */
function isAppShell(request, url) {
  return request.mode === "navigate" || url.pathname.endsWith("/") || /\.(?:html|js|css)$/i.test(url.pathname);
}

/** Tell every open tab that a newer build is stored and one reload away. */
async function announceUpdate() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  clients.forEach((client) => client.postMessage({ type: "geomate-update-ready", cache: CACHE_NAME }));
}

/**
 * Has the file actually changed? ETag first, because that is what the host sends and comparing two
 * short strings costs nothing. Only when there is no ETag on both sides does it fall back to
 * reading the bodies — correctness matters more here than the few milliseconds, since getting this
 * wrong means telling somebody there is an update when there is not, or worse, never telling them.
 */
async function bodiesDiffer(cached, fresh) {
  const a = cached.headers.get("ETag"), b = fresh.headers.get("ETag");
  if (a && b) return a !== b;
  const la = cached.headers.get("Last-Modified"), lb = fresh.headers.get("Last-Modified");
  if (la && lb) return la !== lb;
  try {
    return (await cached.clone().text()) !== (await fresh.clone().text());
  } catch {
    return false;
  }
}

/**
 * Serve what is stored, then refresh it behind the scenes. The response goes back before the
 * network is even asked, so a repeat visit does not depend on the link at all.
 */
async function cacheFirstThenRefresh(request, watchForUpdates) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);

  // "no-cache" revalidates with the server rather than trusting the browser's own HTTP cache, so an
  // unchanged file comes back as an empty 304 instead of re-downloading half a megabyte.
  const refresh = fetch(new Request(request.url, { cache: "no-cache", credentials: "same-origin" }))
    .then(async (response) => {
      if (!response || !response.ok) return response;
      const changed = watchForUpdates && cached ? await bodiesDiffer(cached, response) : false;
      await cache.put(request, response.clone());
      if (changed) await announceUpdate();
      return response;
    })
    .catch(() => cached);

  if (cached) {
    // Deliberately not awaited: the point is that the answer does not wait for it.
    refresh.catch(() => {});
    return cached;
  }

  // Nothing stored yet — the very first visit, or a URL never seen. This one has to wait.
  const response = await refresh;
  if (response) return response;
  if (request.mode === "navigate") {
    const shell = (await cache.match("./index.html")) || (await cache.match("./"));
    if (shell) return shell;
  }
  throw new Error("offline and nothing cached for " + request.url);
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith(cacheFirstThenRefresh(request, isAppShell(request, url)));
});
