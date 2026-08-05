// Service worker: what makes this thing usable in a driveway with one bar.
//
// The rules are deliberately blunt:
//   - the app itself is cached and served from the cache, so it opens instantly
//     and opens at all with no signal
//   - anything talking to Supabase is never cached, because a stale balance is
//     worse than no balance
//
// Bump CACHE whenever the shell changes. Old caches are deleted on activate,
// so a stale version cannot outlive a deploy.
const CACHE = "pet-shell-v10";

const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./data.js",
  "./offline.js",
  "./ocr.js",
  "./alta.js",
  "./store.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // One bad URL should not sink the whole install, so each is added on its
      // own and a failure is logged rather than thrown.
      Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch((err) => {
            console.warn("[sw] could not cache " + url, err);
          })
        )
      )
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// The app asks for the new version to take over the moment the user agrees to
// reload, rather than waiting for every tab to close.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

function isSupabase(url) {
  return url.hostname.endsWith(".supabase.co");
}

// Things that never change once published: the icons, and the CDN bundle, whose
// URL carries its own version number. These are safe to serve from the cache
// forever. Everything else is the app's own code, which changes on every deploy.
function isImmutable(url) {
  return url.origin !== self.location.origin || /\.(png|svg|ico|woff2?)$/.test(url.pathname);
}

// Answer from the cache, and quietly fetch a fresh copy for next time.
function cacheFirst(req) {
  return caches.match(req, { ignoreSearch: true }).then((hit) => {
    const fresh = fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => hit);
    return hit || fresh;
  });
}

// Ask the network, fall back to the cache. Costs one round trip when there is
// signal and gives the cached copy the instant there is not.
function networkFirst(req, fallback) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    })
    .catch(() => caches.match(fallback || req, { ignoreSearch: true }));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Live data and receipt images are always fetched fresh. When there is no
  // signal the request simply fails and the app falls back to what it saved.
  if (isSupabase(url)) return;

  // A deep link like #/p/xyz is still a request for index.html.
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, "./index.html"));
    return;
  }

  // The app's own code is never served stale. Doing so means every deploy is
  // one reload behind, which looks exactly like the deploy not having happened.
  event.respondWith(isImmutable(url) ? cacheFirst(req) : networkFirst(req));
});
