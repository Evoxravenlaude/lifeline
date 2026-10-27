/* lifeline web. One small app, no build step. Every view is a function returning HTML; every action goes through the same gate as Telegram. */
window.App = (function () {
  const $ = (s) => document.querySelector(s);
  const api = (p, b, m) => fetch(p, { method: m || (b ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined, credentials: "same-origin" }).then((r) => r.json()).catch(() => ({ error: "offline" }));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const tz = () => (me && me.tz) || undefined;
  const fmt = (d) => new Date(d).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() }).replace(",", "");
  const fmtT = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() });
  const fmtD = (d) => new Date(d + (d.length === 10 ? "T12:00:00" : "")).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const toast = (t) => { const e = $("#toast"); e.textContent = t; e.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("show"), 2200); };
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

  const THEMES = { manor: ["Manor", "#ECE4D2", "#26201A", "#2E4A3B"], library: ["Library", "#1C1612", "#EADFCB", "#C3A15E"], riviera: ["Riviera", "#F1EADC", "#1E2B3F", "#2F6B7A"], tobacco: ["Tobacco", "#241B15", "#EFE3CF", "#D39B4A"] };
  const VIEWS = [["chat", "Chat"], ["today", "Today"], ["hackathons", "Hackathons"], ["scout", "Scout"], ["lists", "Lists"], ["money", "Money"], ["trips", "Trips"], ["what", "What I do"], ["settings", "Settings"]];
  const SUB = { chat: "say it plainly", today: "", hackathons: "ranked to your interests", scout: "projects and the people behind them", lists: "", money: "", trips: "", what: "ask me about any of it", settings: "" };
  let me = null, view = "chat", pip = null, lastId = 0, state = null;

  /* ---------- boot ---------- */
  async function boot() {
    me = await api("/api/me");
    if (me.error) {
      $("#login").hidden = false;
      Mascot.mount($("#loginMascot"), { greeting: "" });
      tgWidget();
      $("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") link(); });
      return;
    }
    $("#app").hidden = false;
    $("#who").textContent = me.name || "";
    if (me.theme && !localStorage.getItem("ll_theme")) setTheme(me.theme, false);
    pip = Mascot.mount($("#mascot"), { api: (s) => api("/api/pip?state=" + s), greeting: me.pip || "I'm Pip. I keep your day." });
    $("#nav").innerHTML = VIEWS.map(([k, l]) => `<button data-v="${k}" onclick="App.go('${k}')">${l}</button>`).join("");
    const h = location.hash.replace("#", "");
    go(VIEWS.some(([k]) => k === h) ? h : "chat");
    await refreshShell();
    setInterval(refreshShell, 30000);
  }
  function tgWidget() {
    api("/api/public").then((p) => {
      if (!p.botUsername) return;
      const s = document.createElement("script");
      s.src = "https://telegram.org/js/telegram-widget.js?22";
      s.setAttribute("data-telegram-login", p.botUsername); s.setAttribute("data-size", "large"); s.setAttribute("data-onauth", "App.onTg(user)"); s.setAttribute("data-request-access", "write");
      $("#tgw").appendChild(s);
    });
  }
  async function onTg(u) { const r = await api("/auth/telegram", u); if (r.ok) location.reload(); else $("#lerr").textContent = r.error === "not in the circle" ? "That Telegram account isn't in this circle." : "That sign-in didn't check out. Try again."; }
  async function link() { const code = $("#code").value.trim(); if (code.length < 6) return ($("#lerr").textContent = "Six characters, from the bot."); const r = await api("/auth/link", { code }); if (r.ok) location.reload(); else $("#lerr").textContent = "That code didn't work. Codes last fifteen minutes; say link to the bot for a fresh one."; }
  async function logout() { await api("/auth/logout", {}); location.reload(); }
  function setTheme(t, save = true) { document.documentElement.dataset.theme = t; try { localStorage.setItem("ll_theme", t); } catch {} if (save) api("/api/settings", { theme: t }, "PATCH"); }
  function toggleShell() { $("#side").classList.toggle("open"); }

  /* ---------- the shell (right column): what Pip is holding right now ---------- */
  async function refreshShell() {
    const s = await api("/api/state");
    if (s.error) return;
    state = s;
    $("#usage").textContent = me.budget ? `$${(s.spend || 0).toFixed(2)} of $${me.budget} model spend today` : "";
    const kept = s.reminders.length + s.events.length + s.meds.length + s.lists.length + s.ledger.length;
    if (pip && !["thinking", "done", "error", "reminder"].includes(pip.state())) {
      if (s.pending.length) pip.set("pending", s.pending.length === 1 ? "One thing is waiting on your yes." : `${s.pending.length} things are waiting on your yes.`);
      else if (s.quiet) pip.set("quiet", "Quiet hours. I'll hold anything new until morning.");
      else if (!kept) pip.set("empty", "Nothing kept yet. Tell me one thing you'd hate to forget.");
      else pip.set("idle", nextLine(s));
    }
    $("#pending").innerHTML = s.pending.map((p) => `<div class="waiting"><p>${esc(p.echo)}</p><div class="row"><button class="btn sm brass" onclick="App.btn('confirm:${p.id}')">Yes, go ahead</button><button class="btn sm" onclick="App.btn('cancel:${p.id}')">No</button></div></div>`).join("");
    const up = [...s.events.map((e) => ({ t: e.starts_at, l: e.title, s: e.location })), ...s.reminders.map((r) => ({ t: r.due_at, l: r.text }))].filter((x) => new Date(x.t) > Date.now() - 3600e3).sort((a, b) => new Date(a.t) - new Date(b.t)).slice(0, 6);
    $("#upnext").innerHTML = li(up, (x) => `<li><span>${esc(x.l)}<small>${fmt(x.t)}${x.s ? ", " + esc(x.s) : ""}</small></span></li>`, "Nothing coming up.");
    $("#meds").innerHTML = li(s.meds, (m) => `<li><span>${esc(m.name)}<small>${m.times.join(", ")}${m.days_left != null ? `, about ${m.days_left} days left` : ""}</small></span></li>`, "None kept.");
    $("#deadlines").innerHTML = li(s.ledger.filter((h) => h.deadline && !["won", "lost", "withdrawn"].includes(h.status)).slice(0, 5), (h) => `<li><span>${esc(h.title)}<small>${fmt(h.deadline)}</small></span><span class="status ${h.status}">${h.status}</span></li>`, "No hackathon deadlines in play.");
    $("#mem").innerHTML = li(s.memory.filter((m) => m.confirmed).slice(0, 6), (m) => `<li><span>${esc(m.fact)}</span></li>`, "Nothing confirmed yet. Say \"remember that ...\".");
    if (view !== "chat") render();
  }
  function nextLine(s) {
    const next = [...s.events.map((e) => ({ t: e.starts_at, l: e.title })), ...s.reminders.map((r) => ({ t: r.due_at, l: r.text }))].filter((x) => new Date(x.t) > Date.now()).sort((a, b) => new Date(a.t) - new Date(b.t))[0];
    if (!next) return "Nothing's on fire. Good moment to plan something.";
    const mins = Math.round((new Date(next.t) - Date.now()) / 60000);
    const when = mins < 60 ? `in ${mins} minutes` : mins < 1440 ? `at ${fmtT(next.t)}` : fmt(next.t);
    return `Next up: ${next.l}, ${when}.`;
  }
  const li = (a, f, empty) => (a.length ? a.map(f).join("") : `<li class="empty">${empty || "Nothing here."}</li>`);

  /* ---------- navigation ---------- */
  function go(v) {
    view = v; location.hash = v;
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    $("#viewTitle").textContent = VIEWS.find(([k]) => k === v)[1];
    $("#viewSub").textContent = SUB[v] || "";
    $("#side").classList.remove("open");
    render();
  }
  async function render() {
    const V = $("#view"); $("#headActions").innerHTML = ""; V.classList.toggle("chatview", view === "chat"); V.classList.toggle("wide", view === "scout" || view === "hackathons");
    if (!state) state = await api("/api/state");
    switch (view) {
      case "chat": return renderChat(V);
      case "today": return renderToday(V);
      case "hackathons": return renderHackathons(V);
      case "scout": return renderScout(V);
      case "lists": return renderLists(V);
      case "money": return renderMoney(V);
      case "trips": return renderTrips(V);
      case "what": return renderWhat(V);
      case "settings": return renderSettings(V);
    }
  }

  /* ---------- chat ---------- */
  const SUGGEST = ["what's on today", "remind me to call Ada tomorrow at 9", "who's building payments on base", "any hackathons for ai this month", "I spent 4500 naira on data", "can you track my meds?", "I'm going to Accra on the 20th"];
  async function renderChat(V) {
    V.innerHTML = `<div class="thread" id="log"></div>
      <div class="composer"><div class="chips" id="chips">${SUGGEST.map((s) => `<button onclick="App.fill('${q(s)}')">${esc(s)}</button>`).join("")}</div>
      <form onsubmit="App.send();return false"><textarea id="t" rows="1" placeholder="Say it the way you'd say it to a person."></textarea><button class="btn primary" type="submit">Send</button></form></div>`;
    const t = $("#t");
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    t.addEventListener("input", () => { t.style.height = "auto"; t.style.height = Math.min(160, t.scrollHeight) + "px"; });
    lastId = 0; await loadMessages();
    t.focus();
  }
  function fill(s) { $("#t").value = s; $("#t").focus(); $("#t").dispatchEvent(new Event("input")); }
  function add(role, text, buttons, at) {
    const d = document.createElement("div"); d.className = "msg " + role;
    d.innerHTML = linkify(text) + (buttons && buttons.length ? `<div class="btns">${buttons.map((b) => `<button class="btn sm ${/go ahead|confirm/i.test(b.label) ? "brass" : ""}" onclick="App.btn('${q(b.data)}',this)">${esc(b.label)}</button>`).join("")}</div>` : "") + (at ? `<span class="t">${fmt(at)}</span>` : "");
    $("#log").appendChild(d); window.scrollTo(0, document.body.scrollHeight); return d;
  }
  async function loadMessages() {
    const ms = await api("/api/messages"); if (!Array.isArray(ms)) return;
    const fresh = ms.filter((m) => m.id > lastId); if (!fresh.length) { if (!lastId) $("#log").innerHTML = `<div class="empty-state">Nothing here yet. Try <b>remind me to call Ada tomorrow at 9</b>, or ask <b>can you plan a trip?</b></div>`; return; }
    fresh.forEach((m, i) => add(m.role, m.content, null, i === fresh.length - 1 ? m.created_at : null)); lastId = ms[ms.length - 1].id;
  }
  async function send(text) {
    const t = (text || $("#t").value).trim(); if (!t) return;
    if (!text) { $("#t").value = ""; $("#t").style.height = "auto"; }
    add("user", t);
    const thinking = document.createElement("div"); thinking.className = "msg thinking"; thinking.textContent = "Reading that properly."; $("#log").appendChild(thinking); window.scrollTo(0, document.body.scrollHeight);
    pip && pip.set("thinking", "Reading that properly.");
    const r = await api("/api/chat", { text: t });
    thinking.remove();
    if (r.error) { add("assistant", "I couldn't reach the brain just now. Once more in a moment?"); pip && pip.set("error", "That one slipped."); return; }
    add("assistant", r.text, r.buttons); lastId = 1e9;
    const waits = r.buttons && r.buttons.some((b) => /go ahead|confirm/i.test(b.label));
    pip && pip.set(waits ? "pending" : "idle", waits ? "I won't move on that until you say." : r.text.length < 70 ? r.text : nextLine(state || { events: [], reminders: [] }));
    refreshShell();
  }
  async function btn(data, el) {
    if (el && el.parentElement) el.parentElement.remove();
    const r = await api("/api/button", { data });
    if (view === "chat") add("assistant", r.text, r.buttons); else toast(r.text);
    pip && pip.set(/undo|cancel/i.test(data) ? "idle" : "done", r.text.length < 70 ? r.text : "Done.");
    refreshShell();
  }
  async function say(text) { const r = await api("/api/chat", { text }); toast(r.text.slice(0, 120)); pip && pip.set(r.buttons ? "pending" : "done", r.text.length < 70 ? r.text : undefined); await refreshShell(); return r; }
  function ask(label, prefix, placeholder) { const v = window.prompt(label, placeholder); if (v) say(prefix + v); }

  /* ---------- today ---------- */
  function renderToday(V) {
    const items = [
      ...state.events.filter((e) => sameDay(e.starts_at)).map((e) => ({ k: fmtT(e.starts_at), l: e.title, s: e.location })),
      ...state.reminders.filter((r) => sameDay(r.due_at)).map((r) => ({ k: fmtT(r.due_at), l: r.text, b: [["Done", `rem:done:${r.id}`], ["Snooze", `rem:snooze:${r.id}`]] })),
      ...state.classes_today.map((c) => ({ k: c.start_time.slice(0, 5), l: c.name, s: c.location, meta: "class" })),
      ...state.meds.flatMap((m) => m.times.map((tt) => ({ k: tt, l: m.name, s: m.dose, meta: "dose" }))),
    ].sort((a, b) => a.k.localeCompare(b.k));
    const day = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: tz() });
    $("#viewSub").textContent = day;
    V.innerHTML = `<div class="section"><h3>${items.length ? (items.length === 1 ? "One thing on the clock." : `${items.length} things on the clock.`) : "Nothing on the clock."}</h3>
      ${items.length ? `<ul class="lines">${items.map((i) => `<li><span class="when">${i.k}</span><span class="what">${esc(i.l)}${i.s ? ` <span class="meta">${esc(i.s)}</span>` : ""}</span>${i.meta ? `<span class="meta">${i.meta}</span>` : ""}<span class="act row">${(i.b || []).map(([l, d]) => `<button class="btn sm" onclick="App.btn('${d}')">${l}</button>`).join("")}</span></li>`).join("")}</ul>` : `<div class="empty-state">A clear day. If that's wrong, tell me what's on: <b>dentist at 3</b>, <b>class Algorithms 10 to 12</b>.</div>`}</div>
      <div class="section"><h3>The brief</h3><div id="brief" class="brief faint">Fetching the morning note.</div></div>
      ${state.habits.length ? `<div class="section"><h3>Habits this week</h3><div class="chips">${state.habits.map((h) => `<button onclick="App.say('did ${q(h.name)}')">${esc(h.name)}, ${h.n} of ${h.target_per_week}</button>`).join("")}</div></div>` : ""}
      ${state.quiet ? `<p class="faint small">Quiet hours. Reminders you asked for still ring; everything else waits for morning.</p>` : ""}`;
    api("/api/digest").then((d) => { const b = $("#brief"); if (b) { b.textContent = d.text; b.classList.remove("faint"); } });
  }
  const sameDay = (d) => new Date(d).toLocaleDateString(undefined, { timeZone: tz() }) === new Date().toLocaleDateString(undefined, { timeZone: tz() });

  /* ---------- hackathons ---------- */
  async function renderHackathons(V) {
    V.innerHTML = '<div class="empty-state">Ranking what\'s open against your interests.</div>';
    const h = await api("/api/hackathons");
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.ask('Which hackathon, and when is it due?', 'I\\'m entering ', 'NEAR hackathon due nov 14')">Track one</button> <button class="btn sm" onclick="App.ask('What are you into? Any chains, any themes.', 'interests: ', 'ai, payments, base, ethereum')">Interests</button>`;
    V.innerHTML = `<div class="section"><h3>${h.feed.length ? "Worth your weekend" : "Nothing ranked yet"}</h3>
      ${h.feed.length ? `<ul class="lines">${h.feed.map((x) => `<li><span class="odds" title="plain odds score">${x.score}</span><span class="what"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><br><span class="meta">${[x.deadline ? `closes ${fmt(x.deadline)}` : "", x.prize_usd ? `$${Number(x.prize_usd).toLocaleString()} in prizes` : "", x.registrations ? `${x.registrations} registered` : "", x.online === false ? "in person" : "remote", (x.tags || []).slice(0, 3).join(", ")].filter(Boolean).join(". ")}</span></span><span class="act"><button class="btn sm" onclick="App.say('I\\'m entering ${q(x.title)}${x.deadline ? " due " + q(new Date(x.deadline).toDateString()) : ""}')">Track</button></span></li>`).join("")}</ul>` : `<div class="empty-state">The feed fills as the sources are polled, every six hours. Tell me what you're into and it ranks itself: <b>interests: ai, payments, base</b>.</div>`}</div>
      <div class="section"><h3>Your entries</h3>${h.ledger.length ? `<ul class="lines">${h.ledger.map((e) => `<li><span class="what">${esc(e.title)}<br><span class="meta">${e.deadline ? "due " + fmt(e.deadline) : "no deadline"}${e.prize ? `. ${esc(e.prize)}${e.payout_received ? ", paid" : ", unpaid"}` : ""}</span></span><select onchange="App.say('${q(e.title)} status ' + this.value)">${["interested", "registered", "building", "submitted", "won", "lost", "withdrawn"].map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select>${e.url ? `<a class="btn sm" href="${esc(e.url)}" target="_blank" rel="noopener">Open</a>` : ""}</li>`).join("")}</ul><p class="faint small" style="margin-top:10px">${esc(h.stats)}</p>` : `<div class="empty-state">Nothing entered yet. When you commit to one, say <b>I'm entering NEAR, due nov 14</b> and I'll keep the deadline and chase the prize.</div>`}</div>`;
  }

  /* ---------- scout ---------- */
  async function renderScout(V) {
    V.innerHTML = `<div class="section"><form class="row" onsubmit="App.scout();return false"><input id="niche" placeholder="a niche: payments on base, ai agents, perps on hyperliquid, fintech in africa" style="flex:2;min-width:220px"><input id="obj" placeholder="and what for: partner, hire, invest, apply" style="flex:1;min-width:160px"><button class="btn primary" type="submit">Scout</button><button class="btn" type="button" onclick="App.scoutWatch()">Keep watching</button></form><p class="faint small" style="margin-top:8px">Site, X, Telegram, Discord, GitHub, and the founders' public handles. I draft the first message; you send it.</p></div><div id="scoutOut"></div>`;
    const r = await api("/api/scout");
    $("#scoutOut").innerHTML = scoutCards(r.results, r.watches);
  }
  function scoutCards(results, watches) {
    const people = (p) => { const f = typeof p.founders === "string" ? JSON.parse(p.founders) : p.founders || []; const seen = new Set(); return f.filter((x) => { const k = x.handle || x.name; if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4); };
    const href = (h) => (h.startsWith("@") ? "https://x.com/" + h.slice(1) : h.startsWith("gh:") ? "https://github.com/" + h.slice(3) : h);
    return `${watches && watches.length ? `<p class="small muted" style="margin-bottom:14px">Watching: ${watches.map((w) => esc(w.niche) + (w.objective ? " for " + esc(w.objective) : "")).join("; ")}.</p>` : ""}
      ${results.length ? `<div class="cards">${results.map((p) => `<div class="card"><h3>${esc(p.name)}</h3>${p.objective ? `<p class="small muted">${esc(p.objective)}</p>` : ""}<p class="small" style="margin-top:8px">${[p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">site</a>` : "", p.twitter ? `<a href="https://x.com/${esc(p.twitter.replace("@", ""))}" target="_blank" rel="noopener">${esc(p.twitter)}</a>` : "", p.telegram ? `<a href="https://${esc(p.telegram.replace(/^https?:\/\//, ""))}" target="_blank" rel="noopener">telegram</a>` : "", p.discord ? `<a href="${esc(p.discord)}" target="_blank" rel="noopener">discord</a>` : "", p.github ? `<a href="${esc(p.github)}" target="_blank" rel="noopener">github</a>` : ""].filter(Boolean).join(" ")}</p>${people(p).length ? `<p class="small" style="margin-top:8px">People: ${people(p).map((x) => `${esc(x.name || "")} ${x.handle ? `<a href="${esc(href(x.handle))}" target="_blank" rel="noopener">${esc(x.handle.replace(/^gh:/, ""))}</a>` : ""}${x.role ? ` <span class="faint">(${esc(x.role)})</span>` : ""}`).join(", ")}</p>` : ""}<div class="row" style="margin-top:12px"><span class="faint small">${(p.sources || []).filter((s) => !/^http/.test(s)).join(", ")}</span><span class="sp"></span><button class="btn sm" onclick="App.outreach('${q(p.name)}')">Draft a message</button></div></div>`).join("")}</div>` : `<div class="empty-state">Name a niche and I'll find who's building in it and who to talk to. Or just ask in chat: <b>who's building payments on base</b>.</div>`}`;
  }
  async function scout() {
    const niche = $("#niche").value.trim(); if (!niche) return $("#niche").focus();
    $("#scoutOut").innerHTML = `<div class="empty-state">Turning over stones: GitHub, CoinGecko, DefiLlama, Show HN${me.gemini ? " and the open web" : ""}. Half a minute.</div>`;
    pip && pip.set("thinking", "Turning over stones.");
    const r = await api("/api/scout", { niche, objective: $("#obj").value.trim() || undefined });
    $("#scoutOut").innerHTML = scoutCards(r.results || [], r.watches || []);
    pip && pip.set("done", r.results ? (r.results.length ? `${r.results.length} projects, with the people behind them.` : "Nothing yet for that one.") : "That search slipped.");
  }
  async function scoutWatch() { const niche = $("#niche").value.trim(); if (!niche) return $("#niche").focus(); await say(`keep scouting ${niche}${$("#obj").value ? " for " + $("#obj").value : ""}`); renderScout($("#view")); }
  async function outreach(project) { const ask = window.prompt(`What do you want from ${project}?`, "a partnership"); if (!ask) return; go("chat"); setTimeout(() => send(`draft outreach to ${project}: ${ask}`), 60); }

  /* ---------- lists ---------- */
  function renderLists(V) {
    const by = {}; state.lists.forEach((l) => (by[l.list] = [...(by[l.list] || []), l]));
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.ask('Add to your to-do list', 'todo: ', 'ship the deck')">Add a to-do</button> <button class="btn sm" onclick="App.ask('Add to shopping', 'I need to buy ', 'milk and eggs')">Add shopping</button>`;
    V.innerHTML = Object.keys(by).length ? Object.entries(by).map(([name, items]) => `<div class="section"><h3>${esc(cap(name))}</h3><ul class="lines">${items.map((i) => `<li><span class="what">${esc(i.text)}</span><span class="act"><button class="btn sm" onclick="App.say('done with ${q(i.text)}')">Done</button></span></li>`).join("")}</ul></div>`).join("") : `<div class="empty-state">No lists yet. Say <b>I need to buy milk and eggs</b> or <b>todo: taxes</b> and a list appears.</div>`;
    if (state.dates.length) V.innerHTML += `<div class="section"><h3>Dates that matter</h3><ul class="lines">${state.dates.map((d) => `<li><span class="when">${fmtD(d.on_date)}</span><span class="what">${esc(d.label)}</span><span class="meta">${d.yearly ? "every year" : ""}</span></li>`).join("")}</ul></div>`;
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /* ---------- money ---------- */
  async function renderMoney(V) {
    V.innerHTML = '<div class="empty-state faint">Adding it up.</div>';
    const m = await api("/api/money");
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.ask('What did you spend?', '', 'I spent 4500 naira on data')">Log a spend</button> <button class="btn sm" onclick="App.ask('Which coin, and which level?', '', 'tell me when sol goes above 250')">Price alert</button> <button class="btn sm" onclick="App.ask('A public address, and the chain', 'watch wallet ', '0x... on base as main')">Watch a wallet</button>`;
    const sec = (title, rows, f, empty) => `<div class="section"><h3>${title}</h3>${rows.length ? `<ul class="lines">${rows.map(f).join("")}</ul>` : `<p class="muted">${empty}</p>`}</div>`;
    V.innerHTML = sec("This week's spend", m.spend, (s) => `<li><span class="what">${esc(cap(s.category))}</span><span>${Number(s.total).toLocaleString()} ${s.currency}</span></li>`, "Nothing logged this week. Say \"I spent 20 dollars on lunch\".")
      + sec("Price alerts", m.alerts, (a) => `<li><span class="what">${esc(a.coin.toUpperCase())} ${a.op} ${a.op === "move" ? `${a.target}% in ${a.pct_window}h` : "$" + Number(a.target).toLocaleString()}</span><span class="status">${a.active ? "armed" : "fired"}</span></li>`, "None set. Say \"tell me when btc goes above 100k\".")
      + sec("Wallets I watch", m.wallets, (w) => `<li><span class="what">${esc(w.label || w.address.slice(0, 12))}</span><span class="meta">${esc(w.chain)}</span></li>`, "No wallets yet. Public addresses only.")
      + sec("Copy-trading, on paper", m.follows, (f) => `<li><span class="what">${esc(f.label || f.address.slice(0, 12))}</span><span class="meta">${esc(f.venue)}, ${esc(f.mode)}</span></li>`, "Not following anyone. Nothing here ever executes; it's a mirror.")
      + sec("Bills paid", m.bills, (b) => `<li><span class="when">${fmtD(String(b.created_at).slice(0, 10))}</span><span class="what">${Number(b.amount).toLocaleString()} naira to ${esc(b.biller_code)}</span><span class="status">${esc(b.status)}</span></li>`, "No payments. Every one asks for your yes first.");
  }

  /* ---------- trips ---------- */
  async function renderTrips(V) {
    const t = await api("/api/trips");
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.ask('Where to, and when?', 'plan a trip to ', 'Accra from dec 20 to dec 27, budget 600 dollars')">Plan a trip</button>`;
    const words = { flight: "Flights", stay: "Stays", transport: "Getting around", activity: "Plans", todo: "To do", pack: "Packing" };
    V.innerHTML = t.length ? t.map((tr) => { const spent = tr.items.reduce((s, i) => s + Number(i.cost || 0), 0); return `<div class="section"><h3>${esc(tr.destination.replace(/\b[a-z]/g, (c) => c.toUpperCase()))}</h3><p class="muted small">${tr.starts_on ? fmtD(tr.starts_on) + (tr.ends_on ? " to " + fmtD(tr.ends_on) : "") : "dates open"}${tr.budget ? `. Budget ${Number(tr.budget).toLocaleString()} ${tr.currency}, ${spent.toLocaleString()} planned` : ""}</p>
      ${["flight", "stay", "transport", "activity", "todo", "pack"].map((k) => { const g = tr.items.filter((i) => i.kind === k); return g.length ? `<p class="small faint" style="margin:12px 0 2px">${words[k]}</p><ul class="lines">${g.map((i) => `<li><span class="what" style="${i.done ? "text-decoration:line-through;color:var(--ink-3)" : ""}">${esc(i.title)}${i.at ? ` <span class="meta">${fmt(i.at)}</span>` : ""}${i.cost ? ` <span class="meta">${Number(i.cost).toLocaleString()} ${tr.currency}</span>` : ""}</span>${i.done ? "" : `<span class="act"><button class="btn sm" onclick="App.say('packed ${q(i.title)}')">Tick</button></span>`}</li>`).join("")}</ul>` : ""; }).join("")}
      <div class="row" style="margin-top:12px"><button class="btn sm" onclick="App.ask('Add to ${q(esc(tr.destination))}', 'add ', 'flight LOS to ACC on dec 20 at 7am to the trip')">Add something</button></div></div>`; }).join("") : `<div class="empty-state">No trips on the books. Say <b>I'm going to Accra on the 20th</b> and I'll keep the dates, the list and the budget.</div>`;
  }

  /* ---------- what I do ---------- */
  async function renderWhat(V) {
    const caps = await api("/api/capabilities");
    V.innerHTML = `<p class="lede" style="margin-bottom:28px">You don't need commands. Say it the way you'd say it to a person. Below is everything I keep, with a sentence you can click to try it.</p>
      <div class="capgrid">${(caps.capabilities || []).map((c) => `<div class="cap"><h3>${esc(c.name)}</h3><p>${esc(c.what)}</p><div class="say">${c.say.slice(0, 2).map((s) => `<button onclick="App.try('${q(s)}')">${esc(s)}</button>`).join("")}</div>${c.limits ? `<p class="faint small">${esc(c.limits)}</p>` : ""}</div>`).join("")}</div>`;
  }
  function tryIt(s) { go("chat"); setTimeout(() => fill(s), 50); }

  /* ---------- settings ---------- */
  async function renderSettings(V) {
    const s = await api("/api/settings");
    const cur = document.documentElement.dataset.theme;
    V.innerHTML = `<div class="section"><h3>Room</h3><div class="themes">${Object.entries(THEMES).map(([k, [l, bg, fg, a]]) => `<button class="${cur === k ? "on" : ""}" style="--sw-bg:${bg};--sw-fg:${fg};--sw-a:${a}" onclick="App.setTheme('${k}');App.render()"><i></i>${l}</button>`).join("")}</div><p class="faint small" style="margin-top:8px">Manor and Riviera are light; Library and Tobacco are dark. Kept on this device and on your account.</p></div>
      <div class="section"><h3>Voice</h3><div class="chips">${Object.entries(s.personas).map(([k, p]) => `<button class="${s.persona === k ? "on" : ""}" style="${s.persona === k ? "border-color:var(--brass);color:var(--ink)" : ""}" onclick="App.say('voice ${k}').then(App.render)">${esc(p.label)}</button>`).join("")}</div><form class="row" style="margin-top:10px" onsubmit="App.say('voice ' + document.getElementById('customVoice').value).then(App.render);return false"><input id="customVoice" placeholder="or describe your own: a tired pirate who loves spreadsheets" style="flex:1" value="${esc(s.personaCustom || "")}"><button class="btn sm" type="submit">Use this</button></form></div>
      <div class="section"><h3>Rhythm</h3>
        <label class="field"><span>Timezone</span><input value="${esc(s.tz)}" onchange="App.patch({tz:this.value})" style="max-width:260px"></label>
        <label class="field"><span>Morning brief, hour (0 to 23)</span><input type="number" min="0" max="23" value="${s.digest_hour}" onchange="App.patch({digest_hour:+this.value})" style="max-width:100px"></label>
        <div class="row"><label class="field"><span>Quiet from</span><input type="number" min="0" max="23" value="${s.quiet_start}" onchange="App.patch({quiet_start:+this.value})" style="width:90px"></label><label class="field"><span>until</span><input type="number" min="0" max="23" value="${s.quiet_end}" onchange="App.patch({quiet_end:+this.value})" style="width:90px"></label></div>
        <label class="field"><span>What I call you</span><input value="${esc(s.name || "")}" onchange="App.patch({name:this.value})" style="max-width:260px"></label>
        <label class="field"><span>Country, two letters (for venue checks)</span><input value="${esc(s.country || "")}" maxlength="2" onchange="App.patch({country:this.value})" style="max-width:100px"></label>
        <label class="field"><span>Email, as a last-resort channel</span><input value="${esc(s.email || "")}" onchange="App.patch({email:this.value})" style="max-width:300px"></label>
        <label class="field"><span>Interests, for ranking</span><input value="${esc((s.tags || []).join(", "))}" onchange="App.say('interests: ' + this.value)" style="max-width:400px" placeholder="ai, payments, base, ethereum"></label></div>
      <div class="section"><h3>Where I reach you</h3><dl class="kv">${s.identities.map((i) => `<dt>${esc(i.channel)}</dt><dd class="muted">${esc(i.external_id)}</dd>`).join("")}</dl><div class="row" style="margin-top:12px"><button class="btn sm" onclick="App.linkCode()">Get a link code</button><b id="linkOut" style="font-family:var(--serif);font-size:22px;letter-spacing:.08em"></b></div><p class="faint small" style="margin-top:6px">Send <b>link</b> and the code from SMS or iMessage, or paste it in another browser. Fifteen minutes.</p></div>
      <div class="section"><h3>Under the hood</h3><dl class="kv"><dt>Model</dt><dd>${esc(s.provider || "rules and plain language only, no model key")}</dd><dt>Spend today</dt><dd>$${s.spend.toFixed(3)} of $${s.budget}</dd></dl></div>`;
  }
  async function patch(p) { const r = await api("/api/settings", p, "PATCH"); toast(r.text || "Saved"); }
  async function linkCode() { const r = await api("/api/chat", { text: "link" }); $("#linkOut").textContent = (r.text.match(/\b[A-Z0-9]{6}\b/) || [""])[0]; }

  window.addEventListener("hashchange", () => { const h = location.hash.replace("#", ""); if (h && h !== view && VIEWS.some(([k]) => k === h)) go(h); });
  boot();
  return { go, send, btn, fill, link, onTg, logout, setTheme, toggleShell, say, ask, scout, scoutWatch, outreach, patch, linkCode, render, try: tryIt };
})();
