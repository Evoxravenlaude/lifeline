/* lifeline's service worker. Served from the root (/sw.js) by Vercel and by the Railway server, so it covers every page.
   It keeps the app shell for fast loads, shows a calm page when there's no connection, and turns web pushes into
   notifications. It never caches /api or /auth: your day is always fetched fresh. See docs/APP.md. */
const VERSION = "lifeline-shell-v1";
const SHELL = ["/offline", "/styles.css", "/app.js", "/mascot.js", "/path.js", "/icon.svg", "/icon-192.png", "/manifest.webmanifest",
  "/fonts/libre-caslon-display-latin-400-normal.woff2", "/fonts/eb-garamond-latin-wght-normal.woff2", "/fonts/eb-garamond-latin-wght-italic.woff2"];

self.addEventListener("install", (event) => {
  // Each file on its own, so one missing font never stops the rest from being kept.
  event.waitUntil(caches.open(VERSION).then((c) => Promise.all(SHELL.map((u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok && !r.redirected ? c.put(u, r) : null)).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("lifeline-shell-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || /^\/(api|auth|webhooks|health)(\/|$)/.test(url.pathname) || url.pathname === "/sw.js") return;
  // Pages: always the network, so a new version shows at once. With no connection, the calm offline page.
  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(async () => (await caches.match("/offline")) || new Response("You're offline. Try again once you're connected.", { headers: { "content-type": "text/plain; charset=utf-8" } })));
    return;
  }
  event.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then((r) => { if (r.ok && r.type === "basic" && !r.redirected) c.put(req, r.clone()); return r; }).catch(() => null);
    // Fonts and pictures never change under the same name: answer from the cache at once and refresh behind the scenes.
    if (hit && /^\/fonts\/|\.(?:png|svg|woff2)$/.test(url.pathname)) { event.waitUntil(fresh); return hit; }
    // Code and styles: the network first, so the page and its script always match; the kept copy if it's slow or gone.
    const slow = new Promise((res) => setTimeout(() => res(null), 3000));
    return (await Promise.race([fresh, hit ? slow : fresh])) || hit || (await fresh) || new Response("", { status: 504 });
  }));
});

/* ---------- notifications ---------- */
self.addEventListener("push", (event) => {
  let n = {};
  try { n = event.data ? event.data.json() : {}; } catch { n = { body: event.data ? event.data.text() : "" }; }
  const canAct = typeof Notification !== "undefined" && "actions" in Notification.prototype;
  const actions = canAct && Array.isArray(n.actions) ? n.actions.slice(0, Math.min(2, Notification.maxActions || 2)) : [];
  event.waitUntil(self.registration.showNotification(n.title || "lifeline", {
    body: n.body || "Something from lifeline.",
    tag: n.tag, icon: "/icon-192.png", badge: "/icon-192.png", lang: "en",
    data: { url: n.url || "/#chat", buttons: n.buttons || [], private: n.private === true },
    actions,
  }));
});

/** Bring the app forward at the right page, or open it. */
async function openApp(url) {
  const target = new URL(url || "/#today", self.location.origin).href;
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of wins) {
    if (new URL(w.url).origin === self.location.origin) {
      await w.focus();
      try { await w.navigate(target); } catch { w.postMessage({ type: "open", url: target }); }
      return;
    }
  }
  await self.clients.openWindow(target);
}

self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const data = n.data || {};
  n.close();
  if (!event.action) { event.waitUntil(openApp(data.url)); return; }
  // A button on the notification (Done, Snooze, Taken, Skip): press it, then say what happened, quietly.
  event.waitUntil((async () => {
    try {
      const r = await fetch("/api/button", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: event.action }) });
      const j = r.headers.get("content-type")?.includes("application/json") ? await r.json() : null;
      if (!r.ok || !j || typeof j.text !== "string") return openApp(data.url);
      // A private one (a dose, a check-in) only says it went through; the answer itself stays inside the app.
      const said = data.private ? "Done. Open lifeline for the details." : j.text.replace(/[*_`#]/g, "").slice(0, 300);
      await self.registration.showNotification("lifeline", { body: said, tag: `${n.tag || "ll"}-done`, icon: "/icon-192.png", badge: "/icon-192.png", silent: true, data: { url: data.url, private: data.private === true } });
    } catch { return openApp(data.url); }
  })());
});

/* The browser rolled the push keys: subscribe again with the same server key and tell lifeline. */
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription && event.oldSubscription.options && event.oldSubscription.options.applicationServerKey;
  if (!key) return;
  event.waitUntil(self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
    .then((sub) => fetch("/api/push/subscribe", { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: sub.toJSON(), device: "renewed" }) }))
    .catch(() => null));
});

self.addEventListener("message", (event) => { if (event.data === "skipWaiting") self.skipWaiting(); });
