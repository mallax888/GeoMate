"use strict";

/* The app has to open with no signal on site, and it must not be a version behind when there IS
 * signal. Those two pull against each other, so the two kinds of file are treated differently:
 *
 *   - THE APP ITSELF (the page, its script, its stylesheet) is fetched from the NETWORK FIRST, and
 *     falls back to the stored copy only when the network fails or is too slow to wait for. Open it
 *     with signal and you are on the current version, always, without refreshing.
 *   - FONTS, ICONS AND THE MANIFEST do not change between deploys, so they come straight from the
 *     cache and are refreshed quietly afterwards. Nothing is gained by waiting on the network.
 *
 * This used to be stale-while-revalidate for everything: answer from the cache, refresh in the
 * background for next time. That is why every update took two visits to appear and the first one
 * always showed the old app.
 *
 * CACHE_NAME still gets bumped on a deploy — activate() drops every other cache, which is what
 * clears anything stale an older version of this file left behind.
 */
const CACHE_NAME = "geomate-v158";

/* How long to wait for the network before giving up and using the stored copy. Long enough for a
 * poor site connection to win, short enough that a dead one is not a blank screen. */
const NETWORK_TIMEOUT_MS = 3500;

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

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    // "no-cache" means revalidate with the server rather than trust the browser's own HTTP cache —
    // without it the host's max-age could hand back a stale file and undo the point of this. It is a
    // conditional request, so an unchanged file comes back as an empty 304 rather than a fresh
    // download of the whole 400 kB.
    const response = await fetch(new Request(request.url, { cache: "no-cache", credentials: "same-origin" }), {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response && response.ok) await cache.put(request, response.clone());
    return response;
  } catch (err) {
    clearTimeout(timer);
    const cached = await cache.match(request);
    if (cached) return cached;
    // A navigation to a URL nothing is stored under still opens on the app shell.
    if (request.mode === "navigate") {
      const shell = (await cache.match("./index.html")) || (await cache.match("./"));
      if (shell) return shell;
    }
    throw err;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached || network;
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
  event.respondWith(isAppShell(request, url) ? networkFirst(request) : cacheFirst(request));
});
