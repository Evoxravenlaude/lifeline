/* lifeline web. One file, no build step, hash routes. Every action goes through the same gate as Telegram. See docs/DESIGN.md. */
window.App = (function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  /** Every call returns an object; anything that isn't lifeline's own JSON comes back as { error }, never as a silent success. */
  const api = async (p, b, m) => {
    try {
      const r = await fetch(p, { method: m || (b ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined, credentials: "same-origin" });
      const type = r.headers.get("content-type") || "";
      if (!type.includes("application/json")) return { error: "unreachable", status: r.status, text: "I can't reach lifeline right now. It may be restarting; try again in a minute." };
      const j = await r.json();
      if (!r.ok) {
        if (r.status === 401 && signedIn && !p.startsWith("/auth/")) { signedIn = false; setTimeout(() => { location.hash = ""; location.reload(); }, 2200); return { error: "signed out", status: 401, text: "You've been signed out on this device. Taking you to sign in again." }; }
        return { status: r.status, ...j, error: j.error || "failed", text: j.text || "That didn't go through on my side. Try once more?" };
      }
      return j;
    } catch { return { error: "offline", text: "You look to be offline. Check your connection and try again." }; }
  };
  let signedIn = false;
  /** The brain answers /api/public with its bot name. Anything else means this page can't reach it. */
  async function reachable() { const p = await api("/api/public"); return !p.error && typeof p.botUsername === "string"; }
  function cantReach() {
    const onVercel = /vercel\.app$/.test(location.hostname) || !/railway\.app$/.test(location.hostname);
    const box = document.createElement("div");
    box.className = "wrap"; box.style.padding = "24px var(--gutter)";
    box.innerHTML = `<div class="card k-hack" role="alert"><div class="card-head">${ico("x")}<span>This page can't reach the lifeline server</span></div><div class="card-body" style="display:grid;gap:10px"><p>The site loaded, but the server that keeps your day didn't answer.</p>${onVercel ? `<p class="muted">If this is the Vercel site, <b>web/vercel.json</b> must send <b>/api</b> and <b>/auth</b> to your Railway address (Railway, your service, Settings, Networking). Push the fix and Vercel redeploys.</p>` : `<p class="muted">The server may be restarting. Try again in a minute.</p>`}<div class="row"><button class="btn sm" onclick="location.reload()">Try again</button></div></div></div>`;
    document.body.insertBefore(box, document.body.firstChild.nextSibling);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /* Replies come in a small markdown (see src/core/format.ts). Render it here so nobody sees a raw asterisk,
     and make codes, addresses and drafted messages tap-to-copy. */
  const ADDR = /\b0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\b|(?<![\w/.=?&#])(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[A-Z])(?=[1-9A-HJ-NP-Za-km-z]*[a-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![\w/])/g;
  const marks = (t, b, i) => t
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, (_, x) => b(x))
    .replace(/(?<![\w])__(?=\S)([^_\n]+?)(?<=\S)__(?![\w])/g, (_, x) => b(x))
    .replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g, (_, x) => i(x))
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g, (_, x) => i(x));
  const untable = (t) => t.split("\n").flatMap((l) => !/^\s*\|.*\|\s*$/.test(l) ? [l] : /^\s*\|[\s:|-]+\|\s*$/.test(l) ? [] : [l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ")]).join("\n");
  function md(src) {
    const blocks = [], spans = [];
    let t = untable(String(src ?? "")).replace(/```[ \t]*[\w+-]*[ \t]*\n?([\s\S]*?)```/g, (_, b) => { blocks.push(b.replace(/\n$/, "")); return `\u0000B${blocks.length - 1}\u0000`; })
      .replace(/`([^`\n]+)`/g, (_, x) => { spans.push(x); return `\u0000S${spans.length - 1}\u0000`; });
    t = t.split("\n").map((line) => {
      const bullet = /^\s*[-*+•]\s+/.test(line); if (bullet) line = line.replace(/^\s*[-*+•]\s+/, "");
      const head = /^\s*#{1,6}\s+/.test(line); if (head) line = line.replace(/^\s*#{1,6}\s+/, "").replace(/\s*#+\s*$/, "");
      let e = esc(line)
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, l, u) => `<a href="${u}" target="_blank" rel="noopener">${l}</a>`)
        .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
      e = marks(e, (x) => `<b>${x}</b>`, (x) => `<i>${x}</i>`);
      e = e.split(/(<a [^>]*>.*?<\/a>|<[^>]+>)/).map((p) => p.startsWith("<") ? p : p.replace(ADDR, (m) => `<code class="cp" role="button" tabindex="0" title="Copy">${m}</code>`)).join("");
      if (head) e = `<b>${e}</b>`;
      return (bullet ? "• " : "") + e;
    }).join("\n");
    return t
      .replace(/\u0000S(\d+)\u0000/g, (_, k) => `<code class="cp" role="button" tabindex="0" title="Copy">${esc(spans[+k])}</code>`)
      .replace(/\u0000B(\d+)\u0000/g, (_, k) => `<div class="draft"><pre>${esc(blocks[+k])}</pre><button class="btn sm" type="button" data-copy="${esc(blocks[+k])}">${ico("copy", "sm")}Copy</button></div>`);
  }
  /** The same reply as plain words, for toasts. */
  const plain = (src) => untable(String(src ?? "")).replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1").replace(/`([^`\n]+)`/g, "$1").replace(/^\s*#{1,6}\s+/gm, "").replace(/^\s*[-*+]\s+/gm, "• ").replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1");
  const linkify = (s) => md(s);
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); }
    catch { const ta = document.createElement("textarea"); ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch {} ta.remove(); }
    toast("Copied.");
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest(".cp, [data-copy]");
    if (!el) return;
    e.preventDefault();
    copyText(el.dataset.copy ?? el.textContent);
    if (el.matches(".cp")) { el.classList.add("copied"); setTimeout(() => el.classList.remove("copied"), 900); }
  });
  document.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".cp")) { e.preventDefault(); copyText(e.target.textContent); } });
  const ico = (n, cls = "") => `<svg class="ico ${cls}"><use href="#i-${n}"/></svg>`;
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const title = (s) => String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());

  /* ---------- time, always in the person's own zone ---------- */
  const tz = () => (me && me.tz) || undefined;
  const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz(), hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "long" }).formatToParts(new Date(d)).map((p) => [p.type, p.value]));
  const minsOf = (d) => { const p = parts(d); return Number(p.hour) * 60 + Number(p.minute); };
  const dayKey = (d) => { const p = parts(d); return `${p.year}-${p.month}-${p.day}`; };
  const isToday = (d) => dayKey(d) === dayKey(Date.now());
  const hhmm = (d) => { const p = parts(d); return `${p.hour}:${p.minute}`; };
  const when = (d) => { const dt = new Date(d); if (isToday(dt)) return `today, ${hhmm(dt)}`; if (dayKey(dt) === dayKey(Date.now() + 864e5)) return `tomorrow, ${hhmm(dt)}`; return dt.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() }).replace(",", ""); };
  const dateLong = (s) => new Date(s.length === 10 ? s + "T12:00:00" : s).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const inMins = (d) => { const m = Math.round((new Date(d) - Date.now()) / 6e4); if (m < 1) return "now"; if (m < 60) return `in ${m} min`; const h = Math.round(m / 60); if (h < 24) return `in ${h} hour${h > 1 ? "s" : ""}`; const dd = Math.round(h / 24); return `in ${dd} day${dd > 1 ? "s" : ""}`; };
  const partOfDay = () => { const h = Math.floor(minsOf(Date.now()) / 60); return h < 5 ? "Late" : h < 12 ? "Morning" : h < 17 ? "Afternoon" : h < 21 ? "Evening" : "Night"; };

  const toast = (t, kind) => { const e = $("#toast"); e.textContent = t; e.style.setProperty("--k", kind ? `var(--k-${kind})` : ""); e.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("show"), 2600); };
  /** Say what happened in words: the reply on success, a plain sentence on failure, never a blank or a code. */
  const tell = (r, fallback, kind) => toast(r && r.error ? r.text || "That didn't go through. Try once more?" : plain(r && r.text) || fallback, r && r.error ? null : kind);

  /* ---------- look: palette × day/night, changed with a circle from the control ---------- */
  const PALETTES = { manor: ["Manor", "linen, bottle green, brass", "#EDE6D6", "#2D4A3A", "#0F1411", "#8DB39A", "#A8843F"], claret: ["Claret", "bone, oxblood, gold", "#F1EBE3", "#6B1F2A", "#170D10", "#D88A93", "#B48A3C"], riviera: ["Riviera", "sand, navy, brass", "#EFE9DC", "#1F3550", "#0D1420", "#8FB0D6", "#B08A4E"], tobacco: ["Tobacco", "leaf, amber, cream", "#EEE5D6", "#5A3A22", "#17110C", "#D9A066", "#B7792E"], ivory: ["Ivory", "paper, ink, a little brass", "#F2F0EA", "#141414", "#0B0B0A", "#EFEDE6", "#9C7F45"] };
  const root = document.documentElement;
  function paintBar() { const c = getComputedStyle(root).getPropertyValue("--paper").trim(); $('meta[name="theme-color"]').setAttribute("content", c || "#EDE6D6"); $$("#modeBtn use, #modeBtnL use").forEach((u) => u.setAttribute("href", root.dataset.mode === "night" ? "#i-sun" : "#i-moon")); }
  function look(change, from) {
    const apply = () => { change(); paintBar(); repaintScenes(); };
    if (document.startViewTransition && from && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const r = from.getBoundingClientRect(); root.style.setProperty("--vt-x", `${r.left + r.width / 2}px`); root.style.setProperty("--vt-y", `${r.top + r.height / 2}px`);
      document.startViewTransition(apply);
    } else { root.classList.add("theme-fade"); apply(); setTimeout(() => root.classList.remove("theme-fade"), 400); }
  }
  function setMode(m, from, save = true) { look(() => { root.dataset.mode = m; try { localStorage.setItem("ll_mode", m); } catch {} }, from); if (save && me) api("/api/settings", { mode: m }, "PATCH"); }
  function setPalette(p, from, save = true) { look(() => { root.dataset.palette = p; try { localStorage.setItem("ll_palette", p); } catch {} }, from); if (save && me) api("/api/settings", { palette: p }, "PATCH"); }
  const toggleMode = (e) => setMode(root.dataset.mode === "night" ? "day" : "night", e.currentTarget);

  /* ---------- state ---------- */
  let me = null, state = null, view = "today", pip = null, scenes = [], lastMsgId = 0;
  const VIEWS = [["today", "Today", "today"], ["chat", "Chat", "chat"], ["lists", "Lists", "list"], ["health", "Health", "heart"], ["trips", "Trips", "case"], ["money", "Money", "coin"], ["hackathons", "Hackathons", "flag"], ["scout", "Scout", "compass"], ["what", "What I do", "shell"], ["settings", "Settings", "sliders"], ["more", "More", "more"]];
  const PHONE = ["today", "chat", "lists", "health", "more"];
  /** Work tools (hackathons, scout) sit in the bar only for people who use them; everyone else finds them under More. */
  const workOn = () => me && (me.work === true || (me.work == null && ((state && state.ledger && state.ledger.length) || (me.tags && me.tags.length))));
  const tabs = () => ["today", "chat", "lists", "health", "trips", "money", ...(workOn() ? ["hackathons", "scout"] : [])];

  function repaintScenes() { scenes.forEach((s) => s.update({ accent: getComputedStyle(root).getPropertyValue("--accent").trim() })); }

  /* ---------- boot ---------- */
  async function boot() {
    paintBar();
    $("#modeBtnL").addEventListener("click", toggleMode);
    if (!(await reachable())) { cantReach(); window.__bootDone && window.__bootDone(); return landing(true); }
    me = await api("/api/me");
    if (me.error || typeof me.id !== "number") { me = null; return landing(); }
    signedIn = true;
    document.body.classList.add("app");
    $("#app").hidden = false;
    if (me.palette && !localStorage.getItem("ll_palette")) setPalette(me.palette, null, false);
    if (me.mode && !localStorage.getItem("ll_mode")) setMode(me.mode, null, false);
    $("#who").textContent = me.name ? `Signed in as ${me.name}` : "";
    drawTabs();
    $("#tabbar").innerHTML = PHONE.map((k) => { const v = VIEWS.find((x) => x[0] === k); return `<a href="#${k}" data-v="${k}">${ico(v[2])}${v[1]}</a>`; }).join("");
    $("#modeBtn").addEventListener("click", toggleMode);
    $("#sayBtn").addEventListener("click", openSay);
    $("#logoutBtn").addEventListener("click", async () => { await api("/auth/logout", {}); location.hash = ""; location.reload(); });
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openSay(); }
      else if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); openSay(); }
      else if (e.key === "Escape") closeSay();
    });
    window.addEventListener("hashchange", route);
    state = await api("/api/state");
    if (state.error || !Array.isArray(state.pending)) state = { pending: [], reminders: [], events: [], meds: [], ledger: [], lists: [], memory: [], dates: [], classes_today: [], habits: [], quiet: false };
    drawTabs();
    route();
    window.__bootDone && window.__bootDone();
    setInterval(refresh, 30000);
  }
  async function refresh() { const s = await api("/api/state"); if (s.error || !Array.isArray(s.pending)) return; state = s; if (view === "today") renderToday(true); updatePip(); }

  function drawTabs() {
    $("#tabs").innerHTML = tabs().map((k) => { const v = VIEWS.find((x) => x[0] === k); return `<a href="#${k}" data-v="${k}">${ico(v[2])}<span>${v[1]}</span></a>`; }).join("");
    $$("#tabs a").forEach((a) => a.classList.toggle("on", a.dataset.v === view));
  }

  function route() {
    const h = location.hash.replace("#", "") || "today";
    view = VIEWS.some((v) => v[0] === h) ? h : "today";
    document.body.dataset.view = view;
    $$("#tabs a, #tabbar a").forEach((a) => a.classList.toggle("on", a.dataset.v === view || (view !== "today" && a.dataset.v === "more" && !PHONE.includes(view))));
    scenes.forEach((s) => s.destroy()); scenes = []; pip = null;
    const main = $("#main"); main.innerHTML = "";
    window.scrollTo(0, 0);
    ({ today: renderToday, chat: renderChat, lists: renderLists, health: renderHealth, trips: renderTrips, hackathons: renderHackathons, scout: renderScout, money: renderMoney, what: renderWhat, settings: renderSettings, more: renderMore }[view])();
    document.title = view === "today" ? "lifeline" : `${VIEWS.find((v) => v[0] === view)[1]} · lifeline`;
  }

  /* ---------- the day as items with a time ---------- */
  function todayItems() {
    if (!state || state.error) return [];
    const items = [];
    state.events.filter((e) => isToday(e.starts_at)).forEach((e) => items.push({ min: minsOf(e.starts_at), time: hhmm(e.starts_at), label: cap(e.title), sub: e.location, kind: "event" }));
    state.reminders.filter((r) => isToday(r.due_at)).forEach((r) => items.push({ min: minsOf(r.due_at), time: hhmm(r.due_at), label: cap(r.text), kind: "rem", id: r.id, actions: [["Done", `rem:done:${r.id}`], ["Snooze", `rem:snooze:${r.id}`]] }));
    state.classes_today.forEach((c) => { const [h, m] = c.start_time.split(":").map(Number); items.push({ min: h * 60 + m, time: c.start_time.slice(0, 5), label: cap(c.name), sub: c.location, kind: "class" }); });
    state.meds.forEach((m) => m.times.forEach((t) => { const [h, mm] = t.split(":").map(Number); items.push({ min: h * 60 + mm, time: t.slice(0, 5), label: cap(m.name), sub: m.dose || "dose", kind: "dose" }); }));
    return items.sort((a, b) => a.min - b.min);
  }
  const KIND_WORD = { event: "Event", rem: "Reminder", class: "Class", dose: "Dose" };

  function mountScene(host, items, opts = {}) {
    const tip = $("#tip");
    const s = Path.mount(host, Object.assign({
      items, nowMin: minsOf(Date.now()), nowLabel: hhmm(Date.now()), quiet: me ? [me.quiet_start, me.quiet_end] : [22, 7],
      waiting: Boolean(state && state.pending && state.pending.length), accent: getComputedStyle(root).getPropertyValue("--accent").trim(), inkHost: host,
      onHover(it, g) {
        if (!it) { tip.hidden = true; return; }
        const r = g.getBoundingClientRect();
        tip.innerHTML = `<b>${esc(it.label)}</b>${esc(it.time)}${it.sub ? `, ${esc(it.sub)}` : ""}`; tip.style.setProperty("--k", `var(--k-${it.kind})`);
        tip.style.left = `${r.left + r.width / 2 + window.scrollX}px`; tip.style.top = `${r.top + window.scrollY}px`; tip.style.position = "absolute"; tip.hidden = false;
      },
      onPick(it) { const li = $(`#clock li[data-min="${it.min}"]`); if (li) { li.scrollIntoView({ behavior: "smooth", block: "center" }); li.animate([{ background: `var(--k-${it.kind})` }, { background: "transparent" }], { duration: 1400 }); } },
    }, opts));
    scenes.push(s);
    const tick = setInterval(() => { if (!document.body.contains(host)) return clearInterval(tick); s.update({ nowMin: minsOf(Date.now()), nowLabel: hhmm(Date.now()) }); }, 60000);
    return s;
  }

  /* ---------- Pip ---------- */
  function mountPip(el, size) {
    pip = Mascot.mount(el, { api: (s) => api("/api/pip?state=" + s), greeting: (me && me.pip) || "I'm Pip. I keep your day.", size });
    updatePip();
    return pip;
  }
  function updatePip() {
    if (!pip || ["thinking", "done", "error"].includes(pip.state())) return;
    const s = state || {}; const kept = (s.reminders || []).length + (s.events || []).length + (s.meds || []).length + (s.lists || []).length + (s.ledger || []).length;
    if (s.pending && s.pending.length) pip.set("pending", s.pending.length === 1 ? "One thing is waiting on your yes. I won't move until you say." : `${s.pending.length} things are waiting on your yes.`);
    else if (s.quiet) pip.set("quiet", "Quiet hours. I'll hold anything new until morning.");
    else if (!kept) pip.set("empty", "Nothing kept yet. Tell me one thing you'd hate to forget.");
    else {
      // On Today the next thing already has its own card, so Pip speaks to what comes after it.
      const up = upcoming(); const n = view === "today" ? up[1] : up[0];
      const line = n ? (view === "today" ? `After that, ${n.label.charAt(0).toLowerCase() + n.label.slice(1)} at ${hhmm(n.at)}.` : `Next up: ${n.label}, ${inMins(n.at)}.`) : view === "today" && up[0] ? "That's the last thing on today's path. The evening is yours." : "Nothing's on fire. Good moment to plan something.";
      pip.set("idle", line);
    }
  }
  function nextThing() { return upcoming()[0] || null; }
  function upcoming() {
    const now = Date.now();
    const c = [...(state.events || []).map((e) => ({ at: e.starts_at, label: cap(e.title), sub: e.location, kind: "event" })), ...(state.reminders || []).map((r) => ({ at: r.due_at, label: cap(r.text), kind: "rem", id: r.id }))].filter((x) => new Date(x.at) > now).sort((a, b) => new Date(a.at) - new Date(b.at));
    return c;
  }

  /* ---------- shared bits ---------- */
  const cardHead = (icon, text, extra = "") => `<div class="card-head">${ico(icon)}<span>${text}</span><span class="sp"></span>${extra}</div>`;
  const empty = (html) => `<div class="empty">${html}</div>`;
  const tryLink = (s) => `<b data-try="${esc(s)}">${esc(s)}</b>`;
  function wireTries(scope) { $$("[data-try]", scope).forEach((b) => b.addEventListener("click", () => openSay(b.dataset.try))); }
  function pendingCards() {
    return (state.pending || []).map((p) => `<div class="card waiting-card"><div class="card-head">${ico("hourglass")}<span>Waiting on your yes</span><span class="sp"></span><span class="small">ten minutes from asking</span></div><div class="card-body"><p>${esc(p.echo)}</p><div class="row"><button class="btn metal" data-btn="confirm:${p.id}">Yes, go ahead</button><button class="btn" data-btn="cancel:${p.id}">No</button></div></div></div>`).join("");
  }
  function wireButtons(scope) { $$("[data-btn]", scope).forEach((b) => b.addEventListener("click", () => press(b.dataset.btn, b))); }
  async function press(data, el) {
    if (el) el.disabled = true;
    const r = await api("/api/button", { data });
    if (r.error) { if (el) el.disabled = false; return tell(r); }
    tell(r, "Done.", /confirm/.test(data) ? "metal" : null);
    pip && pip.set(/undo|cancel/.test(data) ? "idle" : "done", r.text && r.text.length < 80 ? r.text : undefined);
    state = await api("/api/state");
    if (view === "today" || view === "lists") route(); else updatePip();
  }
  async function act(action, args, okKind) {
    const r = await api("/api/do", { action, args });
    if (r.error) return tell(r);
    tell(r, "Done.", okKind);
    state = await api("/api/state");
    return r;
  }

  /* ---------- Today ---------- */
  function renderToday(soft) {
    const items = todayItems();
    const nowMin = minsOf(Date.now());
    const next = nextThing();
    const first = me.name ? me.name.split(" ")[0] : "";
    const left = items.filter((i) => i.min >= nowMin).length;
    const hello = `${partOfDay()}${first ? `, ${esc(first)}` : ""}.`;
    const lead = state.pending.length ? (state.pending.length === 1 ? "One thing is waiting on your yes." : `${state.pending.length} things are waiting on your yes.`) : left ? `${left === 1 ? "One thing" : `${left} things`} still ahead today.` : items.length ? "Everything on today's path is behind you." : "A clear path today.";
    if (soft && $("#clock")) { scenes.forEach((s) => s.update({ items, waiting: state.pending.length > 0 })); }
    const main = $("#main");
    main.innerHTML = `
      <section class="path-wrap" id="todayPath"><div class="path-overlay"><div class="wrap"><div class="path-hello"><h2>${hello}</h2><p>${lead}</p></div></div></div></section>
      <div class="wrap page"><div class="home-grid">
        <div class="stack">
          ${pendingCards()}
          ${next ? `<div class="card k-${next.kind}"><div class="card-body next"><div class="when">${hhmm(next.at)}</div><div><div class="what">${esc(next.label)}</div><div class="sub">${esc(cap(when(next.at)))}, ${inMins(next.at)}${next.sub ? `. ${esc(next.sub)}` : ""}</div></div>${next.id ? `<div class="row"><button class="btn sm" data-btn="rem:done:${next.id}">Done</button><button class="btn sm ghost" data-btn="rem:snooze:${next.id}">Snooze</button></div>` : ""}</div></div>` : ""}
          <div class="card k-event"><div class="card-head">${ico("clock")}<span>On the clock today</span></div>
            ${items.length ? `<ul class="lines" id="clock">${items.map((i) => `<li data-min="${i.min}" class="${i.min < nowMin ? "done" : ""}"><span class="t">${i.time}</span><span class="dot k-${i.kind}"></span><span class="w">${esc(i.label)}<small>${KIND_WORD[i.kind]}${i.sub && i.kind !== "dose" ? `, ${esc(i.sub)}` : i.kind === "dose" && i.sub !== "dose" ? `, ${esc(i.sub)}` : ""}</small></span><span class="a">${(i.actions || []).map(([l, d]) => `<button class="btn sm" data-btn="${d}">${l}</button>`).join("")}</span></li>`).join("")}</ul>` : `<div id="clock">${empty(`Nothing on the clock. Tell me what's on: ${tryLink("dentist at 3pm")}, ${tryLink("class Algorithms tuesday 10 to 12")}.`)}</div>`}
          </div>
          <div class="card k-list"><div class="card-head">${ico("today")}<span>The morning note</span><span class="sp"></span><button class="btn ghost sm" id="briefBtn">Rebuild from now</button></div><div class="card-body"><p id="brief" class="serif" style="white-space:pre-wrap;font-size:1.1875rem;line-height:1.55">Writing it.</p></div></div>
        </div>
        <div class="stack">
          <div class="card k-trip"><div class="pip-card"><div id="pipHome"></div><p class="pip-line" id="pipLine"></p></div></div>
          <div class="card k-dose">${cardHead("pill", "Doses")}${state.meds.length ? `<ul class="lines">${state.meds.map((m) => `<li><span class="w">${esc(cap(m.name))}<small>${m.times.join(" and ")}${m.days_left != null ? `, about ${m.days_left} days left` : ""}</small></span></li>`).join("")}</ul>` : empty(`None kept. Say ${tryLink("I take vitamin D at 8am and 8pm")}.`)}</div>
          <div class="card k-hack">${cardHead("flag", "Deadlines")}${deadlines()}</div>
          <div class="card k-list">${cardHead("list", "Lists", `<a class="small" href="#lists">Open</a>`)}${listsSummary()}</div>
          ${state.habits.length ? `<div class="card k-money">${cardHead("check", "Habits this week")}<div class="card-body chips" style="margin:0">${state.habits.map((h) => `<button class="chip" data-habit="${esc(h.name)}">${esc(cap(h.name))}, ${h.n} of ${h.target_per_week}</button>`).join("")}</div></div>` : ""}
        </div>
      </div></div>`;
    mountScene($("#todayPath"), items);
    mountPip($("#pipHome"));
    const pl = $("#pipLine"); const lineEl = $("#pipHome .pip-line"); if (lineEl) { lineEl.hidden = true; const sync = () => (pl.textContent = lineEl.textContent); sync(); new MutationObserver(sync).observe(lineEl, { childList: true, characterData: true, subtree: true }); }
    wireButtons(main); wireTries(main);
    $$("[data-habit]", main).forEach((b) => b.addEventListener("click", () => act("habit.checkin", { name: b.dataset.habit }, "money").then(() => route())));
    const loadBrief = () => api("/api/digest").then((d) => { const b = $("#brief"); if (b) b.textContent = d.text || "Nothing to say yet."; });
    loadBrief(); $("#briefBtn").addEventListener("click", () => { $("#brief").textContent = "Writing it."; loadBrief(); });
  }
  function deadlines() {
    const open = state.ledger.filter((h) => h.deadline && !["won", "lost", "withdrawn"].includes(h.status)).slice(0, 4);
    return open.length ? `<ul class="lines">${open.map((h) => `<li><span class="w">${esc(h.title)}<small>closes ${esc(when(h.deadline))}, ${inMins(h.deadline)}</small></span><span class="status k-hack">${esc(h.status)}</span></li>`).join("")}</ul>` : empty(`No deadlines in play. When you commit to one, say ${tryLink("I'm entering NEAR, due nov 14")}.`);
  }
  function listsSummary() {
    const by = {}; state.lists.forEach((l) => (by[l.list] = [...(by[l.list] || []), l]));
    const names = Object.keys(by);
    return names.length ? `<ul class="lines">${names.slice(0, 4).map((n) => `<li><span class="w">${esc(cap(n))}<small>${by[n].slice(0, 3).map((i) => esc(i.text)).join(", ")}${by[n].length > 3 ? `, and ${by[n].length - 3} more` : ""}</small></span><span class="status k-list">${by[n].length}</span></li>`).join("")}</ul>` : empty(`No lists yet. Try ${tryLink("I need to buy milk and eggs")}.`);
  }

  /* ---------- Chat ---------- */
  let capsCache = null;
  async function renderChat() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Chat</h2><p>Say it the way you'd say it to a person. This is the same conversation as Telegram.</p></div>
      <div class="convo"><div><div class="thread" id="log" aria-live="polite"></div>
        <div class="composer"><div class="chips" id="chips"></div><form id="chatForm"><textarea id="t" rows="1" placeholder="Say it plainly" aria-label="Message"></textarea><button class="btn primary" type="submit">Send</button></form></div></div>
        <aside class="stack"><div class="card k-trip"><div class="card-body" style="padding:16px 18px 12px"><div id="pipChat" style="max-width:150px;margin:0 auto"></div></div></div>${pendingCards()}<div class="card k-list">${cardHead("shell", "Things you can ask")}<div class="card-body" id="askList" style="display:grid;gap:8px"></div></div></aside></div></div>`;
    mountPip($("#pipChat"));
    const t = $("#t");
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    t.addEventListener("input", () => { t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; });
    $("#chatForm").addEventListener("submit", (e) => { e.preventDefault(); send(); });
    $("#chips").innerHTML = ["what's on today", "remind me to call mum on sunday at 5", "my period started today", "slept 7 hours"].map((s) => `<button class="chip" data-fill="${esc(s)}">${esc(s)}</button>`).join("");
    $$("[data-fill]").forEach((b) => b.addEventListener("click", () => { t.value = b.dataset.fill; t.focus(); t.dispatchEvent(new Event("input")); }));
    wireButtons(main);
    capsCache = capsCache || (await api("/api/capabilities"));
    $("#askList").innerHTML = (capsCache.capabilities || []).slice(0, 8).map((c) => `<button class="chip" style="justify-content:flex-start" data-fill="can you do ${esc(c.name.toLowerCase())}?">${esc(c.name)}</button>`).join("");
    $$("#askList [data-fill]").forEach((b) => b.addEventListener("click", () => send(b.dataset.fill)));
    lastMsgId = 0; await loadMessages(); t.focus();
    const pre = sessionStorage.getItem("ll_prefill"); if (pre) { sessionStorage.removeItem("ll_prefill"); t.value = pre; t.dispatchEvent(new Event("input")); }
  }
  function addMsg(role, text, buttons, at) {
    const log = $("#log"); if (!log) return;
    const holds = buttons && buttons.some((b) => /^confirm:/.test(b.data));
    const d = document.createElement("div");
    if (role === "user") { d.className = "msg me"; d.innerHTML = esc(text) + (at ? `<span class="at">${esc(when(at))}</span>` : ""); }
    else { d.className = "msg bot" + (holds ? " hold" : ""); d.innerHTML = `<div class="av" aria-hidden="true"><svg viewBox="0 0 32 32"><use href="#mark"/></svg></div><div><div class="tx">${linkify(text)}</div>${buttons && buttons.length ? `<div class="btns">${buttons.map((b) => `<button class="btn sm ${/^confirm:/.test(b.data) ? "metal" : ""}" data-btn="${esc(b.data)}">${esc(b.label)}</button>`).join("")}</div>` : ""}${at ? `<span class="at">${esc(when(at))}</span>` : ""}</div>`; }
    log.appendChild(d);
    $$("[data-btn]", d).forEach((b) => b.addEventListener("click", async () => { $$("[data-btn]", d).forEach((x) => (x.disabled = true)); const r = await api("/api/button", { data: b.dataset.btn }); addMsg("assistant", r.text, r.buttons); pip && pip.set("done", r.text.length < 80 ? r.text : undefined); state = await api("/api/state"); }));
    d.scrollIntoView({ block: "end", behavior: "smooth" });
    return d;
  }
  async function loadMessages() {
    const ms = await api("/api/messages"); if (!Array.isArray(ms)) return;
    if (!ms.length) { $("#log").innerHTML = empty(`Nothing said yet. Try ${tryLink("remind me to call Ada tomorrow at 9")} or ask ${tryLink("what can you do")}.`); wireTries($("#log")); return; }
    ms.forEach((m, i) => addMsg(m.role, m.content, null, i === ms.length - 1 || (ms[i + 1] && new Date(ms[i + 1].created_at) - new Date(m.created_at) > 30 * 6e4) ? m.created_at : null));
    lastMsgId = ms[ms.length - 1].id;
  }
  async function send(text) {
    const t = $("#t"); const msg = (text || t.value).trim(); if (!msg) return;
    if (!text) { t.value = ""; t.style.height = "auto"; }
    if ($("#log .empty")) $("#log").innerHTML = "";
    addMsg("user", msg);
    const th = document.createElement("div"); th.className = "msg bot thinking"; th.innerHTML = `<div class="av"><svg viewBox="0 0 32 32"><use href="#mark"/></svg></div><div class="tx">Reading that properly</div>`; $("#log").appendChild(th); th.scrollIntoView({ block: "end" });
    pip && pip.set("thinking", "Reading that properly.");
    const r = await api("/api/chat", { text: msg });
    th.remove();
    if (r.error || typeof r.text !== "string") { addMsg("assistant", "I couldn't reach the server just now, so that wasn't kept. Once more in a moment?"); pip && pip.set("error", "That one slipped."); return; }
    addMsg("assistant", r.text, r.buttons);
    const waits = r.buttons && r.buttons.some((b) => /^confirm:/.test(b.data));
    state = await api("/api/state");
    pip && pip.set(waits ? "pending" : "done", waits ? "I won't move on that until you say." : undefined);
    setTimeout(updatePip, 2600);
  }

  /* ---------- Say anything (⌘K) ---------- */
  function openSay(prefill) {
    if ($(".say")) return $(".say input").focus();
    const o = document.createElement("div"); o.className = "say"; o.setAttribute("role", "dialog"); o.setAttribute("aria-label", "Say anything");
    o.innerHTML = `<div class="card"><form>${ico("say", "lg")}<input placeholder="Say anything" aria-label="Say anything" autocomplete="off"><button class="btn sm primary" type="submit">Send</button></form><div class="out" hidden></div><div class="hints">${["what's on today", "remind me to drink water at 3pm", "I spent 2000 naira on lunch", "when is my next period", "my lists"].map((s) => `<button class="chip" type="button">${esc(s)}</button>`).join("")}</div></div>`;
    document.body.appendChild(o);
    const input = $("input", o), out = $(".out", o);
    if (typeof prefill === "string") input.value = prefill;
    input.focus();
    o.addEventListener("click", (e) => { if (e.target === o) closeSay(); });
    $$(".hints .chip", o).forEach((c) => c.addEventListener("click", () => { input.value = c.textContent; input.focus(); }));
    $("form", o).addEventListener("submit", async (e) => {
      e.preventDefault(); const text = input.value.trim(); if (!text) return;
      out.hidden = false; out.innerHTML = `<p class="faint serif"><i>Reading that properly.</i></p>`;
      const r = await api("/api/chat", { text });
      out.innerHTML = `<p>${linkify(r.text || "I couldn't reach the server just now, so that wasn't kept.")}</p>${r.buttons && r.buttons.length ? `<div class="row">${r.buttons.map((b) => `<button class="btn sm ${/^confirm:/.test(b.data) ? "metal" : ""}" data-btn="${esc(b.data)}">${esc(b.label)}</button>`).join("")}</div>` : ""}`;
      $$("[data-btn]", out).forEach((b) => b.addEventListener("click", async () => { const rr = await api("/api/button", { data: b.dataset.btn }); out.innerHTML = `<p>${linkify(rr.text)}</p>`; state = await api("/api/state"); if (view === "today" || view === "lists") route(); }));
      input.value = ""; state = await api("/api/state"); if (view === "today" || view === "lists") { const keep = o; route(); document.body.appendChild(keep); } updatePip();
    });
  }
  function closeSay() { const o = $(".say"); if (o) o.remove(); }

  /* ---------- Lists ---------- */
  function renderLists() {
    const by = {}; state.lists.forEach((l) => (by[l.list] = [...(by[l.list] || []), l]));
    if (!by.todo) by.todo = []; if (!by.shopping) by.shopping = [];
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Lists</h2><p>Anything you'd keep on paper. Tick it here or tell me "done with milk".</p></div>
      <div class="grid auto">${Object.entries(by).map(([name, items]) => `<div class="card k-list"><div class="card-head">${ico("list")}<span>${esc(cap(name))}</span><span class="sp"></span><span>${items.length || ""}</span></div>
        ${items.length ? `<ul class="lines">${items.map((i) => `<li><button class="check" aria-label="Tick ${esc(i.text)}" data-done="${esc(i.text)}" data-list="${esc(name)}">${ico("check")}</button><span class="w">${esc(i.text)}</span></li>`).join("")}</ul>` : empty("Empty. Add the first thing below.")}
        <form class="row" data-add="${esc(name)}" style="padding:12px 16px;border-top:var(--edge-w) solid var(--line);flex-wrap:nowrap"><input placeholder="Add to ${esc(name)}" aria-label="Add to ${esc(name)}"><button class="btn sm" type="submit">${ico("plus", "sm")}Add</button></form></div>`).join("")}
        <div class="card flat" style="border-style:dashed"><div class="card-body"><h4>A new list</h4><p class="muted small" style="margin:6px 0 12px">Books to read, gifts, packing, anything.</p><form class="row" id="newList" style="flex-wrap:nowrap"><input placeholder="its name" aria-label="New list name"><button class="btn sm" type="submit">Start</button></form></div></div>
      </div>
      ${state.dates.length ? `<div class="section-title" style="margin-top:40px"><h3>Dates that matter</h3></div><div class="card k-rem"><ul class="lines">${state.dates.map((d) => `<li><span class="t" style="min-width:7em">${esc(dateLong(d.on_date))}</span><span class="w">${esc(d.label)}</span><span class="faint small">${d.yearly ? "every year" : ""}</span></li>`).join("")}</ul></div>` : ""}</div>`;
    $$("[data-done]", main).forEach((b) => b.addEventListener("click", async () => { b.classList.add("on"); b.closest("li").classList.add("done"); await act("list.done", { match: b.dataset.done, list: b.dataset.list }, "list"); setTimeout(route, 450); }));
    $$("[data-add]", main).forEach((f) => f.addEventListener("submit", async (e) => { e.preventDefault(); const v = $("input", f).value.trim(); if (!v) return; await act("list.add", { list: f.dataset.add, items: v.split(/\s*,\s*/) }, "list"); route(); }));
    $("#newList").addEventListener("submit", (e) => { e.preventDefault(); const n = $("#newList input").value.trim().toLowerCase(); if (n) addListCard(n); });
  }
  /** A new list exists once its first item does; until then it's an empty card with the add box focused. */
  function addListCard(name) {
    const grid = $(".grid.auto"); const tmp = document.createElement("div");
    tmp.innerHTML = `<div class="card k-list"><div class="card-head">${ico("list")}<span>${esc(cap(name))}</span></div>${empty("Empty. Add the first thing below.")}<form class="row" style="padding:12px 16px;border-top:var(--edge-w) solid var(--line);flex-wrap:nowrap"><input placeholder="Add to ${esc(name)}" aria-label="Add to ${esc(name)}"><button class="btn sm" type="submit">${ico("plus", "sm")}Add</button></form></div>`;
    const card = tmp.firstElementChild; grid.insertBefore(card, grid.lastElementChild);
    const f = $("form", card);
    f.addEventListener("submit", async (e) => { e.preventDefault(); const v = $("input", f).value.trim(); if (!v) return; await act("list.add", { list: name, items: v.split(/\s*,\s*/) }, "list"); route(); });
    $("input", f).focus(); $("#newList input").value = "";
  }

  /* ---------- Health: cycle, doses, anything measured ---------- */
  async function renderHealth() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Health</h2><p>Your cycle, your doses, and anything you keep a record of. It stays in your account; say "forget" about any of it and it's gone.</p></div><div id="hl">${empty("Gathering it.")}</div></div>`;
    const h = await api("/api/health");
    const c = (h && h.cycle) || { tracking: false };
    const measures = (h && Array.isArray(h.measures)) ? h.measures : [];
    $("#hl").innerHTML = `<div class="home-grid"><div class="stack">${cycleCard(c)}${measuresCard(measures)}</div><div class="stack">
      <div class="card k-dose">${cardHead("pill", "Doses")}${state.meds.length ? `<ul class="lines">${state.meds.map((m) => `<li><span class="w">${esc(cap(m.name))}<small>${m.times.join(" and ")}${m.days_left != null ? `, about ${m.days_left} days left` : ""}</small></span></li>`).join("")}</ul>` : empty(`None kept. Say ${tryLink("I take vitamin D at 8am and 8pm")}.`)}</div>
      <div class="card k-money">${cardHead("check", "Habits this week")}${state.habits.length ? `<div class="card-body chips" style="margin:0">${state.habits.map((x) => `<button class="chip" data-habit="${esc(x.name)}">${esc(cap(x.name))}, ${x.n} of ${x.target_per_week}</button>`).join("")}</div>` : empty(`Nothing counted yet. Say ${tryLink("did gym")} or ${tryLink("track reading every day")}.`)}</div>
      <div class="card k-event"><div class="card-body" style="display:grid;gap:10px"><h4>Log anything</h4><form class="row" id="logAny" style="flex-wrap:nowrap"><input placeholder="slept 7 hours, weight 72kg, mood 4/5" aria-label="Log something"><button class="btn sm primary" type="submit">Log</button></form><p class="faint small">Sleep, water, weight, mood, steps, blood pressure, lifts, skincare, symptoms. Anything with a number or a yes.</p></div></div>
    </div></div>`;
    wireTries(main); wireButtons(main);
    $$("[data-habit]", main).forEach((b) => b.addEventListener("click", () => act("habit.checkin", { name: b.dataset.habit }, "money").then(renderHealth)));
    $$("[data-say]", main).forEach((b) => b.addEventListener("click", async () => { const r = await api("/api/chat", { text: b.dataset.say }); tell(r, "Done.", "hack"); renderHealth(); }));
    $$("[data-ask]", main).forEach((b) => b.addEventListener("click", () => openSay(b.dataset.ask)));
    $("#logAny").addEventListener("submit", async (e) => { e.preventDefault(); const v = $("#logAny input").value.trim(); if (!v) return; const r = await api("/api/chat", { text: v }); tell(r, "Logged.", "event"); renderHealth(); });
  }
  const dayName = (iso) => iso ? new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  const daysFrom = (iso) => iso ? Math.round((new Date(iso + "T12:00:00") - new Date(new Date().toDateString() + " 12:00")) / 864e5) : null;
  function cycleCard(c) {
    if (!c.tracking) return `<div class="card k-hack">${cardHead("heart", "Periods and cycle")}<div class="card-body" style="display:grid;gap:14px">
      <p>Tell me when your period starts and I'll keep the dates, predict the next one from your own history, and give you a quiet heads-up two days before. Log cramps, flow, mood or anything else as it happens.</p>
      <div class="row"><button class="btn primary" data-say="my period started today">My period started today</button><button class="btn" data-ask="my period started on ">It started on another day</button></div>
      <p class="faint small">Estimates from your own history, not birth control. Only you can see this.</p></div></div>`;
    const len = Math.max(21, Math.min(45, c.length || 28)), pl = c.periodLength || 5, day = c.day || 1;
    const fs = c.fertileStart && c.lastStart ? Math.round((new Date(c.fertileStart) - new Date(c.lastStart)) / 864e5) + 1 : null;
    const fe = c.fertileEnd && c.lastStart ? Math.round((new Date(c.fertileEnd) - new Date(c.lastStart)) / 864e5) + 1 : null;
    const cells = Array.from({ length: len }, (_, i) => { const d = i + 1; const k = d <= pl ? "period" : fs && d >= fs && d <= fe ? "fertile" : ""; return `<i class="cy ${k} ${d === day ? "now" : ""}" title="Day ${d}"></i>`; }).join("");
    const next = daysFrom(c.nextStart);
    const lead = c.inPeriod ? `Day ${day}, on your period.` : c.lateBy > 0 ? `Your period is ${c.lateBy} day${c.lateBy > 1 ? "s" : ""} later than I'd expect.` : `Day ${day} of about ${len}.`;
    return `<div class="card k-hack">${cardHead("heart", "Periods and cycle")}<div class="card-body" style="display:grid;gap:14px">
      <div><h3 style="font-size:var(--t-31)">${lead}</h3>${c.nextStart && !c.lateBy ? `<p class="muted" style="margin-top:4px">Next period likely ${esc(dayName(c.nextStart))}${next != null ? `, ${next <= 0 ? "about now" : `in ${next} day${next > 1 ? "s" : ""}`}` : ""}.${c.fertileStart ? ` Fertile window probably ${esc(dayName(c.fertileStart))} to ${esc(dayName(c.fertileEnd))}.` : ""}</p>` : ""}</div>
      <div class="cycle" role="img" aria-label="Your cycle, day ${day} of ${len}">${cells}</div>
      <div class="row small muted"><span class="row" style="gap:6px"><i class="cy period"></i>period</span><span class="row" style="gap:6px"><i class="cy fertile"></i>likely fertile</span><span class="row" style="gap:6px"><i class="cy now"></i>today</span></div>
      <div class="row">${c.inPeriod ? `<button class="btn sm primary" data-say="my period ended today">It ended today</button>` : `<button class="btn sm primary" data-say="my period started today">Period started today</button>`}<button class="btn sm" data-ask="today I have ">Log how I feel</button></div>
      ${(c.logs || []).length ? `<ul class="lines" style="margin:0 -20px">${c.logs.slice(0, 6).map((l) => `<li><span class="t" style="min-width:5.5em">${esc(dayName(l.day))}</span><span class="w">${esc(cap(l.value || l.kind))}<small>${esc(l.kind)}</small></span></li>`).join("")}</ul>` : ""}
      <p class="faint small">${c.irregular ? "Your cycles vary a fair bit, so these dates are rougher than usual. A doctor or nurse can look properly if that worries you. " : ""}Estimates from your own history, not birth control. <button class="btn ghost sm" data-ask="forget my cycle data" style="padding:0 4px;min-height:0">Forget my cycle data</button></p>
    </div></div>`;
  }
  function spark(points) {
    const v = points.map((p) => Number(p.value)).filter((x) => !isNaN(x)); if (v.length < 2) return "";
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1, w = 140, h = 36;
    const d = v.map((x, i) => `${i ? "L" : "M"}${(i / (v.length - 1) * w).toFixed(1)} ${(h - 3 - ((x - lo) / span) * (h - 6)).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true" style="overflow:visible"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  }
  function measuresCard(ms) {
    return `<div class="card k-event">${cardHead("chart", "What you track")}${ms.length ? `<ul class="lines">${ms.map((m) => `<li><span class="w"><b style="font-weight:600">${esc(cap(m.name))}</b><small>${m.last ? `${m.last.note || `${Number(m.last.value).toLocaleString()}${m.unit ? " " + esc(m.unit) : ""}`}, ${esc(when(m.last.at))}` : ""}${m.avg7 != null ? `. Week's average ${Number(m.avg7).toLocaleString(undefined, { maximumFractionDigits: 1 })}${m.unit ? " " + esc(m.unit) : ""}` : ""}</small></span><span class="spark">${spark(m.points || [])}</span><button class="btn sm ghost a" data-ask="how's my ${esc(m.name)} this month">More</button></li>`).join("")}</ul>` : empty(`Nothing tracked yet. Try ${tryLink("slept 7 hours")}, ${tryLink("weight 72kg")} or ${tryLink("drank 2 litres of water")}.`)}</div>`;
  }

  /* ---------- Trips ---------- */
  async function renderTrips() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Trips</h2><span class="sp"></span><button class="btn primary" id="newTrip">${ico("plus", "sm")}Plan a trip</button><p>Dates, budget, flights and stays as you book them, and a packing list. I nudge you a week before and the day before.</p></div><div class="stack" id="tripList">${empty("Unpacking.")}</div></div>`;
    $("#newTrip").addEventListener("click", () => openSay("plan a trip to "));
    const t = await api("/api/trips");
    const words = { flight: "Flights", stay: "Stays", transport: "Getting around", activity: "Plans", todo: "To do", pack: "Packing" };
    $("#tripList").innerHTML = (Array.isArray(t) && t.length) ? t.map((tr) => {
      const spent = tr.items.reduce((s, i) => s + Number(i.cost || 0), 0); const days = tr.starts_on ? Math.ceil((new Date(tr.starts_on + "T00:00:00") - Date.now()) / 864e5) : null;
      const pack = tr.items.filter((i) => i.kind === "pack"); const packed = pack.filter((i) => i.done).length;
      return `<div class="card k-trip"><div class="stub"><div class="main">
        <div class="dest">${esc(title(tr.destination))}</div>
        <p class="muted" style="margin-top:6px">${tr.starts_on ? `${esc(dateLong(tr.starts_on))}${tr.ends_on ? ` to ${esc(dateLong(tr.ends_on))}` : ""}` : "Dates open. Tell me when and I'll set the nudges."}</p>
        ${tr.budget ? `<div style="margin:16px 0 4px" class="row small"><span>Budget ${Number(tr.budget).toLocaleString()} ${esc(tr.currency)}</span><span class="sp"></span><span class="muted">${spent.toLocaleString()} planned</span></div><div class="meter k-money"><i style="width:${Math.min(100, (spent / tr.budget) * 100).toFixed(0)}%"></i></div>` : ""}
        ${["flight", "stay", "transport", "activity", "todo"].map((k) => { const g = tr.items.filter((i) => i.kind === k); return g.length ? `<h4 style="margin:18px 0 4px;font-size:1rem;font-family:var(--body);font-weight:700">${words[k]}</h4><ul class="lines" style="margin:0 -20px">${g.map((i) => `<li class="${i.done ? "done" : ""}"><span class="w">${esc(cap(i.title))}<small>${i.at ? esc(when(i.at)) : ""}${i.cost ? `${i.at ? ", " : ""}${Number(i.cost).toLocaleString()} ${esc(tr.currency)}` : ""}</small></span></li>`).join("")}</ul>` : ""; }).join("")}
        ${pack.length ? `<h4 style="margin:18px 0 8px;font-size:1rem;font-family:var(--body);font-weight:700">Packing, ${packed} of ${pack.length}</h4><div class="chips">${pack.map((i) => `<button class="chip ${i.done ? "on" : ""} k-trip" data-pack="${esc(i.title)}" aria-pressed="${i.done}">${i.done ? ico("check", "sm") : ""}${esc(i.title)}</button>`).join("")}</div>` : ""}
        <div class="row" style="margin-top:18px"><button class="btn sm" data-add-trip="${esc(tr.destination)}">${ico("plus", "sm")}Add a flight, stay or plan</button></div>
      </div><div class="side">${days == null ? `<span class="small">no date yet</span>` : days > 0 ? `<b>${days}</b><span class="small">day${days === 1 ? "" : "s"} to go</span>` : days === 0 ? `<b>Today</b>` : `<span class="small">underway or past</span>`}</div></div></div>`;
    }).join("") : empty(`No trips on the books. Say ${tryLink("I'm going to Accra on the 20th")} and I'll keep the dates, the list and the budget.`);
    wireTries(main);
    $$("[data-pack]", main).forEach((b) => b.addEventListener("click", async () => { if (b.getAttribute("aria-pressed") === "true") return; b.classList.add("on"); await act("trip.tick", { match: b.dataset.pack }, "trip"); renderTrips(); }));
    $$("[data-add-trip]", main).forEach((b) => b.addEventListener("click", () => openSay(`add to the ${b.dataset.addTrip} trip: `)));
  }

  /* ---------- Hackathons ---------- */
  async function renderHackathons() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Hackathons</h2><span class="sp"></span><button class="btn" id="interests">Your interests</button><button class="btn primary" id="track">${ico("plus", "sm")}Track one</button><p>What's open, ranked against what you're into, and what you've entered, chased to payout.</p></div><div id="hk">${empty("Ranking what's open.")}</div></div>`;
    $("#interests").addEventListener("click", () => openSay("interests: "));
    $("#track").addEventListener("click", () => openSay("I'm entering "));
    const h = await api("/api/hackathons");
    if (h.error) return ($("#hk").innerHTML = empty("I couldn't load these just now."));
    const cols = [["Thinking about it", ["interested", "registered"]], ["Building", ["building"]], ["Submitted", ["submitted"]], ["Decided", ["won", "lost", "withdrawn"]]];
    $("#hk").innerHTML = `
      <div class="section-title"><h3>${h.feed.length ? "Worth your weekend" : "Nothing ranked yet"}</h3><span class="sp"></span><span class="faint small">odds score, 0 to 100</span></div>
      ${h.feed.length ? `<div class="grid two">${h.feed.map((x) => `<div class="card k-hack"><div class="card-body" style="display:grid;grid-template-columns:auto 1fr;gap:16px;align-items:start"><div class="odds">${Math.round(x.score)}</div><div><h4><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a></h4><p class="muted small" style="margin-top:4px">${[x.deadline ? `closes ${when(x.deadline)}` : "", x.prize_usd ? `$${Number(x.prize_usd).toLocaleString()} in prizes` : "", x.registrations ? `${x.registrations} registered` : "", x.online === false ? "in person" : "remote"].filter(Boolean).map(esc).join(", ")}</p>${(x.tags || []).length ? `<div class="chips" style="margin:10px 0 0">${x.tags.slice(0, 4).map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>` : ""}<div class="row" style="margin-top:12px"><button class="btn sm" data-enter="${esc(x.title)}" data-due="${x.deadline ? esc(new Date(x.deadline).toDateString()) : ""}">Track it</button><a class="btn sm ghost" href="${esc(x.url)}" target="_blank" rel="noopener">${ico("out", "sm")}Open</a></div></div></div></div>`).join("")}</div>` : `<div class="card k-hack">${empty(`The feed fills as the sources are polled, every six hours. Tell me what you're into and it ranks itself: ${tryLink("interests: ai, payments, base")}.`)}</div>`}
      <div class="section-title" style="margin-top:44px"><h3>Your entries</h3><span class="sp"></span><span class="faint small">${esc(h.stats)}</span></div>
      ${h.ledger.length ? `<div class="board">${cols.map(([name, st]) => { const es = h.ledger.filter((e) => st.includes(e.status)); return `<div class="col"><h4><span class="dot k-hack"></span>${name}<span class="faint">${es.length || ""}</span></h4>${es.map((e) => `<div class="card k-hack"><div class="card-body" style="padding:14px 16px"><b>${esc(e.title)}</b><p class="small muted" style="margin:4px 0 10px">${e.deadline ? `closes ${esc(when(e.deadline))}` : "no deadline yet"}${e.prize ? `. ${esc(e.prize)}${e.payout_received ? ", paid" : ", unpaid"}` : ""}</p><select aria-label="Status of ${esc(e.title)}" data-status="${esc(e.title)}">${["interested", "registered", "building", "submitted", "won", "lost", "withdrawn"].map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select></div></div>`).join("") || `<p class="faint small">Nothing here.</p>`}</div>`; }).join("")}</div>` : `<div class="card k-hack">${empty(`Nothing entered yet. When you commit to one, say ${tryLink("I'm entering NEAR, due nov 14")} and I'll keep the deadline and chase the prize.`)}</div>`}`;
    wireTries(main);
    $$("[data-enter]", main).forEach((b) => b.addEventListener("click", async () => { b.disabled = true; const r = await api("/api/chat", { text: `I'm entering ${b.dataset.enter}${b.dataset.due ? " due " + b.dataset.due : ""}` }); tell(r, "Done.", "hack"); renderHackathons(); }));
    $$("[data-status]", main).forEach((s) => s.addEventListener("change", async () => { const r = await api("/api/chat", { text: `${s.dataset.status} status ${s.value}` }); tell(r, "Done.", "hack"); renderHackathons(); }));
  }

  /* ---------- Scout ---------- */
  async function renderScout() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Scout</h2><p>New and upcoming projects in a niche, the people behind them, and their public handles. I draft the first message; you send it.</p></div>
      <div class="card k-scout"><form class="card-body scoutform" id="scoutForm">
        <label class="field">The niche<input id="niche" placeholder="fintech in Lagos, design studios in Accra, ai startups"></label>
        <label class="field">And what for<input id="obj" placeholder="a job, clients, partners, to learn"></label>
        <button class="btn primary" type="submit">Scout</button><button class="btn" type="button" id="watchBtn">Keep watching</button></form></div>
      <div id="scoutOut" style="margin-top:30px">${empty("Loading what you've scouted before.")}</div></div>`;
    $("#scoutForm").addEventListener("submit", (e) => { e.preventDefault(); scout(); });
    $("#watchBtn").addEventListener("click", async () => { const n = $("#niche").value.trim(); if (!n) return $("#niche").focus(); const r = await api("/api/chat", { text: `keep scouting ${n}${$("#obj").value ? " for " + $("#obj").value : ""}` }); tell(r, "Done.", "scout"); });
    const r = await api("/api/scout"); $("#scoutOut").innerHTML = scoutCards(r.results || [], r.watches || []); wireScout();
  }
  function scoutCards(results, watches) {
    const people = (p) => { const f = typeof p.founders === "string" ? JSON.parse(p.founders || "[]") : p.founders || []; const seen = new Set(); return f.filter((x) => { const k = x.handle || x.name; if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4); };
    const href = (h) => (h.startsWith("@") ? "https://x.com/" + h.slice(1) : h.startsWith("gh:") ? "https://github.com/" + h.slice(3) : h);
    return `${watches.length ? `<p class="muted" style="margin-bottom:16px">Watching ${watches.map((w) => `<b>${esc(w.niche)}</b>${w.objective ? ` for ${esc(w.objective)}` : ""}`).join(", ")}. New finds land in your morning note.</p>` : ""}
      ${results.length ? `<div class="grid auto">${results.map((p) => `<div class="card k-scout visit"><div class="card-body"><h3>${esc(p.name)}</h3>${p.objective ? `<p class="muted small" style="margin-top:4px">${esc(p.objective)}</p>` : ""}
        <div class="links">${[p.url && `<a class="chip" href="${esc(p.url)}" target="_blank" rel="noopener">site</a>`, p.twitter && `<a class="chip" href="https://x.com/${esc(p.twitter.replace("@", ""))}" target="_blank" rel="noopener">${esc(p.twitter)}</a>`, p.telegram && `<a class="chip" href="https://${esc(p.telegram.replace(/^https?:\/\//, ""))}" target="_blank" rel="noopener">telegram</a>`, p.discord && `<a class="chip" href="${esc(p.discord)}" target="_blank" rel="noopener">discord</a>`, p.github && `<a class="chip" href="${esc(p.github)}" target="_blank" rel="noopener">github</a>`].filter(Boolean).join("")}</div>
        ${people(p).length ? `<div class="people">${people(p).map((x) => `<span>${esc(x.name || "")} ${x.handle ? `<a href="${esc(href(x.handle))}" target="_blank" rel="noopener">${esc(x.handle.replace(/^gh:/, ""))}</a>` : ""}${x.role ? ` <span class="faint">${esc(x.role)}</span>` : ""}</span>`).join("")}</div>` : ""}
        <div class="row" style="margin-top:14px"><span class="faint small">${esc((p.sources || []).filter((s) => !/^http/.test(s)).join(", "))}</span><span class="sp"></span><button class="btn sm" data-outreach="${esc(p.name)}">Draft a message</button></div></div></div>`).join("")}</div>` : `<div class="card k-scout">${empty(`Name a niche above and I'll find who's building in it and who to talk to. Or ask in chat: ${tryLink("who's building payments on base")}.`)}</div>`}`;
  }
  function wireScout() { wireTries($("#scoutOut")); $$("[data-outreach]").forEach((b) => b.addEventListener("click", () => { const ask = window.prompt(`What do you want from ${b.dataset.outreach}?`, "a partnership"); if (!ask) return; sessionStorage.setItem("ll_prefill", `draft outreach to ${b.dataset.outreach}: ${ask}`); location.hash = "chat"; })); }
  async function scout() {
    const niche = $("#niche").value.trim(); if (!niche) return $("#niche").focus();
    $("#scoutOut").innerHTML = `<div class="card k-scout">${empty(`Turning over stones: GitHub, CoinGecko, DefiLlama, Show HN${me.gemini ? " and the open web" : ""}. Half a minute.`)}</div>`;
    const r = await api("/api/scout", { niche, objective: $("#obj").value.trim() || undefined });
    $("#scoutOut").innerHTML = scoutCards(r.results || [], r.watches || []); wireScout();
    toast(r.results ? (r.results.length ? `${r.results.length} projects, with the people behind them.` : "Nothing yet for that one.") : "That search slipped.", "scout");
  }

  /* ---------- Money ---------- */
  async function renderMoney() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Money</h2><span class="sp"></span><button class="btn" id="logSpend">${ico("plus", "sm")}Log a spend</button><button class="btn" id="alertBtn">Price alert</button><p>Where it went this week, the levels you're watching, and the wallets and traders you follow on paper.</p></div><div id="mo">${empty("Adding it up.")}</div></div>`;
    $("#logSpend").addEventListener("click", () => openSay("I spent "));
    $("#alertBtn").addEventListener("click", () => openSay("tell me when "));
    const m = await api("/api/money"); if (m.error) return;
    const byCur = {}; m.spend.forEach((s) => (byCur[s.currency] = [...(byCur[s.currency] || []), s]));
    const sec = (k, icon, t, rows, f, emptyHtml) => `<div class="card k-${k}">${cardHead(icon, t)}${rows.length ? `<ul class="lines">${rows.map(f).join("")}</ul>` : empty(emptyHtml)}</div>`;
    $("#mo").innerHTML = `<div class="home-grid"><div class="stack">
      <div class="card k-money">${cardHead("coin", "This week")}${Object.keys(byCur).length ? Object.entries(byCur).map(([cur, rows]) => { const max = Math.max(...rows.map((r) => Number(r.total))); const total = rows.reduce((s, r) => s + Number(r.total), 0); return `<div class="bars"><div class="row"><b class="serif" style="font-size:1.6rem;font-weight:500">${total.toLocaleString()} ${esc(cur)}</b></div>${rows.map((r) => `<div class="b"><span>${esc(cap(r.category))}</span><div class="meter k-money"><i style="width:${((Number(r.total) / max) * 100).toFixed(0)}%"></i></div><span class="tnum">${Number(r.total).toLocaleString()}</span></div>`).join("")}</div>`; }).join("") : empty(`Nothing logged this week. Say ${tryLink("I spent 20 dollars on lunch")}.`)}</div>
      ${sec("hack", "flag", "Bills paid", m.bills, (b) => `<li><span class="w">${Number(b.amount).toLocaleString()} naira to ${esc(b.biller_code)}<small>${esc(when(b.created_at))}</small></span><span class="status">${esc(b.status)}</span></li>`, "No payments. Every one waits for your yes first.")}
    </div><div class="stack">
      ${sec("rem", "clock", "Price alerts", m.alerts, (a) => `<li><span class="w">${esc(a.coin.toUpperCase())} ${esc(a.op)} ${a.op === "move" ? `${a.target}% in ${a.pct_window}h` : "$" + Number(a.target).toLocaleString()}</span><span class="status k-rem">${a.active ? "armed" : "rang"}</span></li>`, `None set. Say ${tryLink("tell me when btc goes above 100k")}.`)}
      ${sec("event", "coin", "Wallets I watch", m.wallets, (w) => `<li><span class="w">${esc(w.label || w.address.slice(0, 12) + "…")}<small>${esc(w.chain)}</small></span></li>`, "No wallets yet. Public addresses only, never keys.")}
      ${sec("scout", "compass", "Copy-trading, on paper", m.follows, (f) => `<li><span class="w">${esc(f.label || f.address.slice(0, 12) + "…")}<small>${esc(f.venue)}</small></span><span class="status k-scout">${esc(f.mode)}</span></li>`, "Not following anyone. Nothing here ever places a trade; it's a mirror.")}
    </div></div>`;
    wireTries(main);
  }

  /* ---------- What I do ---------- */
  const CAP_KIND = { cycle: "hack", measures: "event", reminders: "rem", calendar: "event", medications: "dose", classes: "class", trips: "trip", lists: "list", dates: "rem", habits: "money", money: "money", notes: "list", hackathons: "hack", scout: "scout", markets: "event", trading: "scout", jobs: "hack", bills: "money", brief: "list", tools: "event", voice: "trip", channels: "class", safety: "dose" };
  async function renderWhat() {
    const main = $("#main");
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>What I do</h2><p>You don't need commands. Say it the way you'd say it to a person. Here is everything I keep, each with a sentence you can try.</p></div><div class="grid auto" id="caps"></div>
      <div class="section-title" style="margin-top:50px"><h3>Why a tortoise</h3></div><div class="card k-trip"><div class="pip-card" style="grid-template-columns:140px 1fr;padding:20px 24px"><div id="pipWhat"></div><div id="pipBio"></div></div></div></div>`;
    capsCache = capsCache || (await api("/api/capabilities"));
    $("#caps").innerHTML = (capsCache.capabilities || []).map((c) => `<div class="card cap k-${CAP_KIND[c.key] || "list"}"><div class="card-body"><h3>${esc(c.name)}</h3><p class="muted">${esc(c.what)}</p><div class="try">${c.say.slice(0, 2).map((s) => `<button data-try="${esc(s)}">${esc(s)}</button>`).join("")}</div>${c.limits ? `<p class="faint small">${esc(c.limits)}</p>` : ""}</div></div>`).join("");
    const bio = capsCache.pip || { why: [] };
    $("#pipBio").innerHTML = `<p class="pip-line" style="font-size:1.4rem;margin-bottom:10px">${esc(bio.what || "")}</p>${(bio.why || []).map((w) => `<p class="muted" style="margin-top:6px">${esc(w)}</p>`).join("")}`;
    mountPip($("#pipWhat"));
    wireTries(main);
  }

  /* ---------- Settings ---------- */
  async function renderSettings() {
    const s = await api("/api/settings");
    const main = $("#main");
    const cur = root.dataset.palette, mode = root.dataset.mode;
    main.innerHTML = `<div class="wrap page"><div class="page-head"><h2>Settings</h2><p>How it looks, how I talk, and when I'm allowed to ring.</p></div>
      <div class="section-title"><h3>Look</h3><span class="sp"></span><div class="seg" role="group" aria-label="Day or night"><button data-mode="day" aria-pressed="${mode === "day"}">${ico("sun", "sm")}Day</button><button data-mode="night" aria-pressed="${mode === "night"}">${ico("moon", "sm")}Night</button></div></div>
      <div class="swatches">${Object.entries(PALETTES).map(([k, [name, note, dp, da, np, na, metal]]) => `<button class="card swatch press" data-palette="${k}" aria-pressed="${cur === k}"><div class="sky"><i style="background:${dp};--sw-a:${da};--sw-m:${metal}"></i><i style="background:${np};--sw-a:${na};--sw-m:${metal}"></i></div><div class="lbl"><b>${name}</b><span class="small muted">${note}</span></div></button>`).join("")}</div>
      <div class="grid two" style="margin-top:40px">
        <div class="card k-trip">${cardHead("chat", "Voice")}<div class="card-body"><div class="chips">${Object.entries(s.personas || {}).map(([k, p]) => `<button class="chip ${s.persona === k ? "on" : ""} k-trip" data-voice="${k}" aria-pressed="${s.persona === k}">${esc(p.label)}</button>`).join("")}</div><form class="row" id="voiceForm" style="margin-top:14px;flex-wrap:nowrap"><input id="customVoice" placeholder="or describe your own: a tired pirate who loves spreadsheets" value="${esc(s.personaCustom || "")}" aria-label="Your own voice"><button class="btn sm" type="submit">Use this</button></form><p class="faint small" style="margin-top:10px">A voice changes how I sound. Dates, amounts and the rules about money never change with it.</p></div></div>
        <div class="card k-event">${cardHead("clock", "Rhythm")}<div class="card-body" style="display:grid;gap:14px">
          <label class="field">Timezone<input data-set="tz" value="${esc(s.tz)}"></label>
          <div class="grid three" style="gap:12px"><label class="field">Morning note at<input type="number" min="0" max="23" data-set="digest_hour" value="${s.digest_hour}"></label><label class="field">Quiet from<input type="number" min="0" max="23" data-set="quiet_start" value="${s.quiet_start}"></label><label class="field">Until<input type="number" min="0" max="23" data-set="quiet_end" value="${s.quiet_end}"></label></div>
          <label class="field">What I call you<input data-set="name" value="${esc(s.name || "")}"></label>
          <label class="field">Interests, for ranking<input id="tags" value="${esc((s.tags || []).join(", "))}" placeholder="ai, payments, base, ethereum"></label>
          <div class="grid two" style="gap:12px"><label class="field">Country, two letters<input data-set="country" maxlength="2" value="${esc(s.country || "")}"></label><label class="field">Email, as a last resort<input data-set="email" type="email" value="${esc(s.email || "")}"></label></div></div></div>
        <div class="card k-class">${cardHead("chat", "Where I reach you")}<div class="card-body"><dl class="kv">${(s.identities || []).map((i) => `<dt>${esc(cap(i.channel))}</dt><dd class="muted">${esc(i.external_id)}</dd>`).join("")}</dl><div class="row" style="margin-top:16px"><button class="btn sm" id="linkCode">Get a link code</button><button id="linkOut" class="link-code" type="button" hidden title="Copy"></button></div><p class="faint small" style="margin-top:8px">${s.smsNumber ? `Text <b>link</b> and the code to <code class="cp" role="button" tabindex="0" title="Copy">${esc(s.smsNumber)}</code>, or send it from iMessage or another browser, within fifteen minutes.` : "Send link and the code from iMessage, or type it in another browser, within fifteen minutes."} Tap the code to copy it.</p></div></div>
        <div class="card k-hack">${cardHead("flag", "Work tools")}<div class="card-body" style="display:grid;gap:12px"><p class="muted">Hackathons, grants and scouting for companies and people. Handy if you build or job-hunt; out of the way if not. They're always under More.</p><div class="seg" role="group" aria-label="Work tools in the bar"><button data-work="true" aria-pressed="${!!workOn()}">In the bar</button><button data-work="false" aria-pressed="${!workOn()}">Under More</button></div></div></div>
        <div class="card k-list">${cardHead("sliders", "Under the hood")}<div class="card-body"><dl class="kv"><dt>Model</dt><dd>${esc(s.provider || "plain language only, no model key")}</dd><dt>Spend today</dt><dd>$${Number(s.spend || 0).toFixed(3)} of $${s.budget}</dd></dl></div></div>
      </div></div>`;
    $$("[data-work]", main).forEach((b) => b.addEventListener("click", async () => { me.work = b.dataset.work === "true"; await api("/api/settings", { work: me.work }, "PATCH"); drawTabs(); $$("[data-work]", main).forEach((x) => x.setAttribute("aria-pressed", x === b)); toast(me.work ? "Work tools are in the bar." : "Work tools moved under More."); }));
    $$("[data-mode]", main).forEach((b) => b.addEventListener("click", (e) => { setMode(b.dataset.mode, e.currentTarget); $$("[data-mode]", main).forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
    $$("[data-palette]", main).forEach((b) => b.addEventListener("click", (e) => { setPalette(b.dataset.palette, e.currentTarget); $$("[data-palette]", main).forEach((x) => x.setAttribute("aria-pressed", x === b)); }));
    $$("[data-voice]", main).forEach((b) => b.addEventListener("click", async () => { const r = await api("/api/chat", { text: `voice ${b.dataset.voice}` }); tell(r, "Done.", "trip"); renderSettings(); }));
    $("#voiceForm").addEventListener("submit", async (e) => { e.preventDefault(); const v = $("#customVoice").value.trim(); if (!v) return; const r = await api("/api/do", { action: "persona.set", args: { custom: v } }); tell(r, "Done.", "trip"); });
    $$("[data-set]", main).forEach((i) => i.addEventListener("change", async () => { const v = i.type === "number" ? Number(i.value) : i.value; const r = await api("/api/settings", { [i.dataset.set]: v }, "PATCH"); tell(r, "Saved.", "event"); me = await api("/api/me"); }));
    $("#tags").addEventListener("change", async (e) => { const r = await api("/api/chat", { text: "interests: " + e.target.value }); tell(r, "Done.", "hack"); });
    $("#linkCode").addEventListener("click", async () => {
      const r = await api("/api/chat", { text: "link" });
      const code = ((r.text || "").match(/\b[A-Z0-9]{6}\b/) || [""])[0];
      if (!code) return toast("I couldn't make a code just now. Try again in a moment.");
      const o = $("#linkOut"); o.textContent = code; o.dataset.copy = `link ${code}`; o.hidden = false;
    });
  }

  /* ---------- More (phone) ---------- */
  function renderMore() {
    $("#main").innerHTML = `<div class="wrap page"><div class="page-head"><h2>More</h2></div><div class="stack">${VIEWS.filter((v) => !PHONE.includes(v[0])).map(([k, l, i]) => `<a class="card press" href="#${k}" style="text-decoration:none"><div class="card-body row">${ico(i, "lg")}<span class="serif" style="font-size:1.4rem">${l}</span><span class="sp"></span></div></a>`).join("")}<button class="btn" id="logout2">${ico("logout", "sm")}Sign out</button></div></div>`;
    $("#logout2").addEventListener("click", async () => { await api("/auth/logout", {}); location.hash = ""; location.reload(); });
  }

  /* ---------- Landing: the whole catalogue, grouped ---------- */
  const GROUP_KIND = { "Your day": "event", "Body and health": "dose", "Money": "money", "Work and growth": "scout", "Me": "list" };
  const GROUP_LINE = {
    "Your day": "Plans, lists and the dates that matter, brought back at the right moment.",
    "Body and health": "Doses, your period and cycle, sleep, weight, mood and habits, kept privately.",
    "Money": "What you spend in any currency, and bills paid only after your yes.",
    "Work and growth": "If you want it: jobs, companies and people in any field, hackathons, and crypto if you hold it.",
    "Me": "Small tools, the voice it talks in, where it reaches you, and what it never does.",
  };
  async function everything() {
    const r = await api("/api/capabilities");
    if (!r.groups || !r.capabilities) return;
    const by = Object.fromEntries(r.capabilities.map((c) => [c.key, c]));
    $("#evGrid").innerHTML = r.groups.map(([title, keys]) => `<div class="card k-${GROUP_KIND[title] || "list"}"><div class="card-body"><h4>${esc(title)}</h4><p class="muted small">${esc(GROUP_LINE[title] || "")}</p><ul class="ev-list">${keys.filter((k) => by[k]).map((k) => `<li><b>${esc(by[k].name)}</b><span>${esc(by[k].say[k === "bills" ? 1 : 0])}</span></li>`).join("")}</ul></div></div>`).join("");
    $("#everything").hidden = false;
  }

  /* ---------- Landing (signed out) ---------- */
  function landing(offline) {
    $("#landing").hidden = false;
    if (offline) { $("#linkForm button").disabled = true; }
    const sets = [
      ["A bit of everything", [["remind me to call mum on sunday at 5", "Call mum, Sunday at 17:00. I'll ping you here.", "rem"], ["my period started today", "Got it, day one. Your next one is likely around the 24th; I'll give you a quiet heads-up two days before.", "dose"], ["spent 4500 naira on data", "₦4,500 on data, logged. That's ₦12,300 this week, most of it on data.", "money"], ["watch jobs at stripe for product design", "Watching Stripe for product design roles. New ones go in your morning note, not as pings.", "scout"]]],
      ["Your day", [["dentist on friday at 3", "Dentist, Friday at 15:00. It's on your calendar.", "event"], ["I need to buy milk, eggs and bread", "Milk, eggs and bread, on your shopping list.", "list"], ["assignment Lab 3 due next monday", "Lab 3, due Monday. I'll warn you the day before.", "class"], ["what's on today", "Gym at 07:30, lunch with Ada at 13:00, and the landlord to call by 17:00.", "event"]]],
      ["Body and health", [["I take vitamin D at 8 and 8pm", "Vitamin D at 08:00 and 20:00. I'll ring you at each; tell me when it's taken.", "dose"], ["cramps and bloating today", "Noted for today, day two. I'll keep it with this cycle so you can see the pattern.", "dose"], ["slept 6 hours", "Sleep 6 hours, logged. That's an hour under your week's average.", "event"], ["did gym", "Gym, done. That's four days in a row.", "rem"]]],
      ["Money", [["paid 20 dollars for lunch", "$20 on lunch, logged.", "money"], ["how much did I spend this week", "₦38,400 this week. Food is the biggest share, then transport.", "money"], ["pay 2000 airtime to 0801 234 5678", "₦2,000 airtime to 0801 234 5678. That spends money, so it waits for you: yes to send, no to drop it.", "money"]]],
      ["Work", [["who's building fintech in Lagos", "Six young fintech companies in Lagos, with who runs each one and where to find them. Want a first message drafted to any of them?", "scout"], ["any hackathons for ai this month", "Three open this month that fit AI, the nearest closing on the 14th. Want them in your brief?", "hack"], ["what's eth right now", "ETH is at $3,412, up 2% today.", "hack"]]],
      ["Trips and dates", [["I'm going to Accra on the 20th", "Accra, nice. When are you back? Dates, or roughly, or say skip and I'll hold the trip without them.", "trip"], ["Ada's birthday is march 14", "Ada, 14 March. I'll remind you the day before.", "rem"], ["packed charger", "Charger, packed. Four things left on the Accra list.", "trip"]]],
    ];
    const showSet = (n) => {
      $$("#letterTabs .chip").forEach((b, i) => { b.classList.toggle("on", i === n); b.setAttribute("aria-selected", String(i === n)); });
      $("#letters").innerHTML = sets[n][1].map(([u, b, k]) => `<div class="letter"><span class="you">${esc(u)}</span><div class="card ll k-${k}">${esc(b)}</div></div>`).join("");
    };
    $("#letterTabs").innerHTML = sets.map(([t], i) => `<button class="chip" type="button" role="tab" data-set="${i}">${esc(t)}</button>`).join("");
    $("#letterTabs").addEventListener("click", (e) => { const b = e.target.closest("[data-set]"); if (b) showSet(Number(b.dataset.set)); });
    showSet(0);
    everything();
    const now = new Date(), m = now.getHours() * 60 + now.getMinutes();
    const demo = [[7 * 60 + 30, "Run", "rem"], [8 * 60, "Vitamin D", "dose"], [10 * 60, "Algorithms", "class"], [13 * 60, "Lunch with Ada", "event"], [15 * 60 + 30, "Dentist", "event"], [17 * 60, "Call the landlord", "rem"], [20 * 60, "Vitamin D", "dose"], [21 * 60 + 30, "Submit the deck", "rem"]].map(([min, label, kind]) => ({ min, label, kind, time: `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}` }));
    const tip = $("#tip");
    scenes.push(Path.mount($("#landPath"), { items: demo, skyRoom: 280, nowMin: m, nowLabel: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, quiet: [22, 7], accent: getComputedStyle(root).getPropertyValue("--accent").trim(), inkHost: $("#landPath"),
      onHover(it, g) { if (!it) { tip.hidden = true; return; } const r = g.getBoundingClientRect(); tip.innerHTML = `<b>${esc(it.label)}</b>${esc(it.time)}`; tip.style.setProperty("--k", `var(--k-${it.kind})`); tip.style.position = "absolute"; tip.style.left = `${r.left + r.width / 2 + scrollX}px`; tip.style.top = `${r.top + scrollY}px`; tip.hidden = false; } }));
    Mascot.mount($("#loginMascot"), { greeting: "" });
    const lm = $("#loginMascot .pip-line"); if (lm) lm.hidden = true;
    api("/api/public").then((p) => {
      if (p.places && p.places.max) {
        const left = Math.max(0, p.places.max - p.places.taken), el = $("#places");
        el.textContent = left ? `${left} of ${p.places.max} places left. Anyone with the link can come in until it's full.` : `Every one of the ${p.places.max} places is taken right now. Ask whoever sent you the link to make room.`;
        el.hidden = false;
      }
      if (!p.botUsername) return;
      const s = document.createElement("script"); s.src = "https://telegram.org/js/telegram-widget.js?22";
      s.setAttribute("data-telegram-login", p.botUsername); s.setAttribute("data-size", "large"); s.setAttribute("data-radius", "7"); s.setAttribute("data-onauth", "App.onTg(user)"); s.setAttribute("data-request-access", "write");
      $("#tgw").appendChild(s);
    });
    $("#tgStart").addEventListener("click", signInWithBot);
    if (!offline) prepareLogin();
    $("#linkForm").addEventListener("submit", async (e) => {
      e.preventDefault(); const code = $("#code").value.trim();
      if (code.length < 6) return ($("#lerr").textContent = "Six characters, from the bot.");
      const r = await api("/auth/link", { code });
      if (r.ok) location.reload(); else $("#lerr").textContent = r.status === 401 || !r.text ? "That code didn't work. Codes last fifteen minutes; say link to the bot for a fresh one." : r.text;
    });
    window.__bootDone && window.__bootDone();
  }
  /**
   * Sign in through the bot: open Telegram, wait for "Yes, sign me in", then this page signs itself in.
   * The request is fetched ahead of the click so Telegram opens straight from the press (no popup blocking).
   */
  let loginReq = null;
  async function prepareLogin() { const r = await api("/auth/telegram/start", {}); loginReq = r.error || !r.url ? null : { ...r, at: Date.now() }; }
  function signInWithBot() {
    const btn = $("#tgStart"), status = $("#tgStatus");
    if (!loginReq || Date.now() - loginReq.at > 4 * 60_000) { status.textContent = "One moment, then press it again."; prepareLogin(); return; }
    const req = loginReq; loginReq = null;
    window.open(req.url, "_blank", "noopener");
    btn.disabled = true; status.textContent = "Waiting for you in Telegram. Tap \"Yes, sign me in\" there.";
    const until = Date.now() + 5 * 60_000;
    const again = (msg) => { btn.disabled = false; status.textContent = msg; prepareLogin(); };
    const tick = async () => {
      if (Date.now() > until) return again("That request ran out. Press the button again.");
      const p = await api("/auth/telegram/poll?id=" + encodeURIComponent(req.id));
      if (p.state === "approved") { status.textContent = "Signed in. Opening your day."; location.hash = "today"; location.reload(); return; }
      if (p.state === "declined") return again("You said no in Telegram, so nobody was signed in.");
      if (p.state === "expired") return again("That request ran out. Press the button again.");
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2500);
  }
  async function onTg(u) { const r = await api("/auth/telegram", u); if (r.ok) location.reload(); else $("#lerr").textContent = r.text || "That sign-in didn't check out. Try again."; }

  boot();
  return { onTg, openSay, setPalette, setMode };
})();
