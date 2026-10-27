/* lifeline web — one small SPA, no build step. Every view is a function returning HTML; actions go through the same gate as Telegram. */
window.App = (function () {
  const $ = (s) => document.querySelector(s);
  const api = (p, b, m) => fetch(p, { method: m || (b ? "POST" : "GET"), headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
  const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  const tz = () => (me && me.tz) || undefined;
  const fmt = (d) => new Date(d).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() });
  const fmtT = (d) => new Date(d).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz() });
  const toast = (t) => { const e = $("#toast"); e.textContent = t; e.classList.add("show"); setTimeout(() => e.classList.remove("show"), 1800); };

  const THEMES = { manor: "Manor", library: "Library", riviera: "Riviera", tobacco: "Tobacco" };
  const VIEWS = [
    ["chat", "Chat", "✎"], ["today", "Today", "☼"], ["hackathons", "Hackathons", "⚑"], ["scout", "Scout", "◎"],
    ["lists", "Lists", "☐"], ["money", "Money", "¤"], ["trips", "Trips", "✈"], ["settings", "Settings", "⚙"],
  ];
  let me = null, view = "chat", mascot = null, lastId = 0, state = null, quietNow = false;

  /* ---------- boot ---------- */
  async function boot() {
    me = await api("/api/me");
    if (me.error) { $("#login").hidden = false; Mascot.mount($("#loginMascot"), { greeting: "I'm Pip. Sign in and I'll keep your day." }); tgWidget(); return; }
    $("#app").hidden = false;
    $("#who").textContent = me.name || "";
    if (me.theme && !localStorage.getItem("ll_theme")) setTheme(me.theme, false);
    mascot = Mascot.mount($("#mascot"), { api: () => api("/api/quip?state=" + (quietNow ? "sleep" : "idle")), greeting: `Hello ${me.name ? me.name.split(" ")[0] : "there"}. I'm Pip.` });
    $("#nav").innerHTML = VIEWS.map(([k, l, i]) => `<button data-v="${k}" onclick="App.go('${k}')"><span class="ico">${i}</span><span class="label">${l}</span></button>`).join("");
    const h = location.hash.replace("#", "");
    go(VIEWS.some(([k]) => k === h) ? h : "chat");
    await refreshSide();
    setInterval(refreshSide, 30000);
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
  async function onTg(u) { const r = await api("/auth/telegram", u); if (r.ok) location.reload(); else $("#lerr").textContent = r.error; }
  async function link() { const r = await api("/auth/link", { code: $("#code").value.trim() }); if (r.ok) location.reload(); else $("#lerr").textContent = r.error; }
  async function logout() { await api("/auth/logout", {}); location.reload(); }
  function setTheme(t, save = true) { document.documentElement.dataset.theme = t; try { localStorage.setItem("ll_theme", t); } catch {} if (save) api("/api/settings", { theme: t }, "PATCH"); }
  function toggleSide() { $("#side").classList.toggle("open"); $("#side").style.display = $("#side").style.display === "block" ? "" : "block"; }

  /* ---------- side panel (always live) ---------- */
  async function refreshSide() {
    state = await api("/api/state");
    if (state.error) return;
    quietNow = state.quiet;
    if (mascot && state.pending.length) mascot.set("alert", `${state.pending.length} thing${state.pending.length > 1 ? "s" : ""} waiting for your yes.`);
    else if (mascot && quietNow) mascot.set("sleep");
    $("#pending").innerHTML = state.pending.map((p) => `<div class="panel" style="padding:12px;margin:8px 0;border-color:var(--gold)"><div class="small">${esc(p.echo)}</div><div class="row" style="margin-top:8px"><button class="btn sm primary" onclick="App.btn('confirm:${p.id}')">Confirm</button><button class="btn sm" onclick="App.btn('cancel:${p.id}')">Cancel</button></div></div>`).join("");
    const up = [...state.events.map((e) => ({ t: e.starts_at, l: e.title, s: e.location })), ...state.reminders.map((r) => ({ t: r.due_at, l: "⏰ " + r.text }))].sort((a, b) => new Date(a.t) - new Date(b.t)).slice(0, 6);
    $("#upnext").innerHTML = li(up, (x) => `<li><span>${esc(x.l)}<small>${fmt(x.t)}${x.s ? " · " + esc(x.s) : ""}</small></span></li>`);
    $("#meds").innerHTML = li(state.meds, (m) => `<li><span>${esc(m.name)}<small>${m.times.join(", ")}${m.days_left != null ? " · ~" + m.days_left + "d" : ""}</small></span></li>`);
    $("#deadlines").innerHTML = li(state.ledger.filter((h) => h.deadline && !["won", "lost", "withdrawn"].includes(h.status)).slice(0, 5), (h) => `<li><span>${esc(h.title)}<small>${fmt(h.deadline)}</small></span><span class="status ${h.status}">${h.status}</span></li>`);
    $("#mem").innerHTML = li(state.memory.slice(0, 6), (m) => `<li><span>${m.confirmed ? "•" : "○"} ${esc(m.fact)}</span></li>`);
    $("#usage").textContent = `$${(state.spend || 0).toFixed(2)} / $${me.budget} today`;
    if (view !== "chat") render();
  }
  const li = (a, f) => (a.length ? a.map(f).join("") : '<li class="faint">—</li>');

  /* ---------- navigation ---------- */
  function go(v) {
    view = v; location.hash = v;
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("active", b.dataset.v === v));
    $("#viewTitle").textContent = VIEWS.find(([k]) => k === v)[1];
    render();
  }
  async function render() {
    const V = $("#view"); $("#headActions").innerHTML = ""; V.classList.toggle("chatview", view === "chat");
    if (!state) state = await api("/api/state");
    switch (view) {
      case "chat": return renderChat(V);
      case "today": return renderToday(V);
      case "hackathons": return renderHackathons(V);
      case "scout": return renderScout(V);
      case "lists": return renderLists(V);
      case "money": return renderMoney(V);
      case "trips": return renderTrips(V);
      case "settings": return renderSettings(V);
    }
  }

  /* ---------- chat ---------- */
  const SUGGEST = ["what's my day looking like", "remind me to call Ada tomorrow 9am", "who's building payments on base", "any hackathons for ethereum this month", "I spent 4500 naira on data", "weather in Lagos tomorrow", "100 usd to ngn", "I need to buy milk and eggs"];
  async function renderChat(V) {
    V.innerHTML = `<div class="chat"><div class="log" id="log"></div><div class="chips" id="chips">${SUGGEST.map((s) => `<button class="chip" onclick="App.fill('${s.replace(/'/g, "\\'")}')">${esc(s)}</button>`).join("")}</div>
      <div class="composer"><textarea id="t" placeholder="Say it plainly. Pip understands ordinary sentences."></textarea><button class="btn primary" onclick="App.send()">Send</button></div></div>`;
    $("#t").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
    lastId = 0; await loadMessages();
    $("#t").focus();
  }
  function fill(s) { $("#t").value = s; $("#t").focus(); }
  function add(role, text, buttons) {
    const d = document.createElement("div"); d.className = "m " + role;
    d.innerHTML = linkify(text) + (buttons && buttons.length ? `<div class="btns">${buttons.map((b) => `<button class="${/confirm/i.test(b.label) ? "confirm" : ""}" onclick="App.btn('${b.data}',this)">${esc(b.label)}</button>`).join("")}</div>` : "");
    $("#log").appendChild(d); $("#log").scrollTop = 1e9; return d;
  }
  async function loadMessages() {
    const ms = await api("/api/messages"); if (!Array.isArray(ms)) return;
    const fresh = ms.filter((m) => m.id > lastId); if (!fresh.length) return;
    fresh.forEach((m) => add(m.role, m.content)); lastId = ms[ms.length - 1].id;
  }
  async function send() {
    const t = $("#t").value.trim(); if (!t) return;
    $("#t").value = ""; add("user", t);
    const typing = document.createElement("div"); typing.className = "m assistant typing"; typing.innerHTML = "<i></i><i></i><i></i>"; $("#log").appendChild(typing); $("#log").scrollTop = 1e9;
    mascot && mascot.set("thinking");
    const r = await api("/api/chat", { text: t });
    typing.remove(); add("assistant", r.text, r.buttons); lastId = 1e9;
    mascot && mascot.set(r.buttons && r.buttons.some((b) => /confirm/i.test(b.label)) ? "alert" : "happy");
    refreshSide();
  }
  async function btn(data, el) {
    if (el && el.parentElement) el.parentElement.remove();
    const r = await api("/api/button", { data });
    if (view === "chat") add("assistant", r.text, r.buttons); else toast(r.text);
    mascot && mascot.set("happy", r.text.length < 60 ? r.text : undefined);
    refreshSide();
  }

  /* ---------- today ---------- */
  function renderToday(V) {
    const items = [
      ...state.events.filter((e) => sameDay(e.starts_at)).map((e) => ({ t: e.starts_at, lbl: "event", l: e.title, s: e.location })),
      ...state.reminders.filter((r) => sameDay(r.due_at)).map((r) => ({ t: r.due_at, lbl: "reminder", l: r.text, b: [["Done", `rem:done:${r.id}`], ["Snooze", `rem:snooze:${r.id}`]] })),
      ...state.classes_today.map((c) => ({ t: null, tt: c.start_time, lbl: "class", l: c.name, s: c.location })),
      ...state.meds.flatMap((m) => m.times.map((tt) => ({ t: null, tt, lbl: "medication", l: `${m.name}${m.dose ? " · " + m.dose : ""}` }))),
    ].sort((a, b) => (a.tt || fmtT(a.t)).localeCompare(b.tt || fmtT(b.t)));
    V.innerHTML = `<div class="grid" style="margin-bottom:16px">
      <div class="panel stat"><span class="muted small">Today</span><b>${items.length}</b><span class="muted small">things on the clock</span></div>
      <div class="panel stat"><span class="muted small">Open tasks</span><b>${state.lists.length}</b><span class="muted small">across your lists</span></div>
      <div class="panel stat"><span class="muted small">Deadlines</span><b>${state.ledger.filter((h) => h.deadline && !["won", "lost", "withdrawn"].includes(h.status)).length}</b><span class="muted small">hackathons in play</span></div>
      <div class="panel stat"><span class="muted small">Streak</span><b>${state.habits.reduce((m, h) => Math.max(m, Number(h.n)), 0)}</b><span class="muted small">best this week</span></div></div>
      <div class="row" style="margin-bottom:12px"><button class="btn" onclick="App.digest()">Read the digest</button><span class="muted small">${state.quiet ? "Quiet hours — proactive pushes are held." : ""}</span></div>
      <div class="timeline">${items.length ? items.map((i) => `<div class="tl"><div class="t">${i.tt || fmtT(i.t)}</div><div><div class="lbl">${i.lbl}</div><div>${esc(i.l)}${i.s ? ` <span class="muted">· ${esc(i.s)}</span>` : ""}</div></div><div class="row">${(i.b || []).map(([l, d]) => `<button class="btn sm" onclick="App.btn('${d}')">${l}</button>`).join("")}</div></div>`).join("") : '<div class="empty">Nothing on the clock today. Pip approves.</div>'}</div>
      ${state.habits.length ? `<h3 class="serif" style="margin:22px 0 8px;font-size:22px">Habits this week</h3><div class="row">${state.habits.map((h) => `<button class="chip" onclick="App.say('did ${h.name}')">${esc(h.name)} · ${h.n}/${h.target_per_week}</button>`).join("")}</div>` : ""}`;
  }
  const sameDay = (d) => new Date(d).toLocaleDateString(undefined, { timeZone: tz() }) === new Date().toLocaleDateString(undefined, { timeZone: tz() });
  async function digest() { const d = await api("/api/digest"); toast("Digest in chat"); go("chat"); setTimeout(() => add("assistant", d.text), 100); }
  async function say(text) { const r = await api("/api/chat", { text }); toast(r.text.slice(0, 80)); refreshSide(); }

  /* ---------- hackathons ---------- */
  async function renderHackathons(V) {
    V.innerHTML = '<div class="empty">Ranking…</div>';
    const h = await api("/api/hackathons");
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.prompt('Track a hackathon', 'track ', 'NEAR hackathon due nov 14')">+ Track</button> <button class="btn sm" onclick="App.prompt('Interests (comma separated)', 'interests: ', 'ai, payments, base, ethereum')">Interests</button>`;
    V.innerHTML = `<h3 class="serif" style="font-size:22px;margin:0 0 10px">Ranked for you</h3>
      <div class="grid">${h.feed.length ? h.feed.map((x) => `<div class="card-h"><div class="row" style="justify-content:space-between"><span class="score">${x.score}</span><span class="row">${(x.tags || []).slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</span></div><div class="title">${esc(x.title)}</div><div class="meta">${x.prize_usd ? `<span>$${Number(x.prize_usd).toLocaleString()}</span>` : ""}${x.registrations ? `<span>${x.registrations} reg</span>` : ""}${x.deadline ? `<span>due ${fmt(x.deadline)}</span>` : ""}<span>${x.online === false ? "in person" : "online"}</span><span class="faint">${x.source}</span></div><div class="row"><a class="btn sm" href="${x.url}" target="_blank" rel="noopener">Open</a><button class="btn sm" onclick="App.say('track ${esc(x.title).replace(/'/g, "")}${x.deadline ? "" : ""}')">Track</button></div></div>`).join("") : '<div class="empty">Feed is empty — pollers run every 6h, or set HACKATHONRADAR_API_KEY.</div>'}</div>
      <h3 class="serif" style="font-size:22px;margin:24px 0 10px">Your ledger</h3>
      <div class="panel">${h.ledger.length ? h.ledger.map((e) => `<div class="k"><div><div>${esc(e.title)}</div><small class="muted">${e.deadline ? "due " + fmt(e.deadline) : "no deadline"}${e.prize ? " · " + esc(e.prize) + (e.payout_received ? " (paid)" : " (unpaid)") : ""}</small></div><div class="row"><select class="sm" onchange="App.say('${e.title.replace(/'/g, "")} status ' + this.value)">${["interested", "registered", "building", "submitted", "won", "lost", "withdrawn"].map((s) => `<option ${s === e.status ? "selected" : ""}>${s}</option>`).join("")}</select>${e.url ? `<a class="btn sm" href="${e.url}" target="_blank">↗</a>` : ""}</div></div>`).join("") + `<div class="muted small" style="padding-top:10px">${h.stats}</div>` : '<div class="empty">Nothing tracked yet.</div>'}</div>`;
  }
  function prompt(label, prefix, placeholder) { const v = window.prompt(label, placeholder); if (v) say(prefix + v); }

  /* ---------- scout ---------- */
  async function renderScout(V) {
    V.innerHTML = `<div class="panel" style="margin-bottom:14px"><div class="row"><input id="niche" placeholder="niche — ai agents, payments on base, perps on hyperliquid, fintech africa, devtools…" style="flex:2;min-width:200px"><input id="obj" placeholder="objective — partner, hire, invest, apply, learn" style="flex:1;min-width:160px"><button class="btn primary" onclick="App.scout()">Scout</button><button class="btn" onclick="App.scoutWatch()">Keep watching</button></div><div class="muted small" style="margin-top:8px">Official site, X, Telegram, Discord, GitHub, and founders' public handles. Outreach is drafted; you send it.</div></div><div id="scoutOut"></div>`;
    const r = await api("/api/scout");
    $("#scoutOut").innerHTML = scoutCards(r.results, r.watches);
  }
  function scoutCards(results, watches) {
    return `${watches && watches.length ? `<div class="row" style="margin-bottom:10px">${watches.map((w) => `<span class="chip">◎ ${esc(w.niche)}${w.objective ? " · " + esc(w.objective) : ""}</span>`).join("")}</div>` : ""}
      <div class="grid">${results.length ? results.map((p) => { const f = (typeof p.founders === "string" ? JSON.parse(p.founders) : p.founders || []); const seen = new Set(); const ff = f.filter((x) => { const k = x.handle || x.name; if (!k || seen.has(k)) return false; seen.add(k); return true; });
        return `<div class="card-h"><div class="title">${esc(p.name)}</div>${p.objective ? `<div class="muted small">${esc(p.objective)}</div>` : ""}<div class="meta">${p.url ? `<a href="${p.url}" target="_blank">site</a>` : ""}${p.twitter ? `<a href="https://x.com/${p.twitter.replace("@", "")}" target="_blank">${esc(p.twitter)}</a>` : ""}${p.telegram ? `<a href="https://${p.telegram.replace(/^https?:\/\//, "")}" target="_blank">telegram</a>` : ""}${p.discord ? `<a href="${p.discord}" target="_blank">discord</a>` : ""}${p.github ? `<a href="${p.github}" target="_blank">github</a>` : ""}</div>${ff.length ? `<div class="small"><span class="muted">people:</span> ${ff.slice(0, 4).map((x) => `${esc(x.name || "")} ${x.handle ? `<a href="${x.handle.startsWith("@") ? "https://x.com/" + x.handle.slice(1) : x.handle.startsWith("gh:") ? "https://github.com/" + x.handle.slice(3) : "#"}" target="_blank">${esc(x.handle)}</a>` : ""}${x.role ? ` <span class="faint">(${esc(x.role)})</span>` : ""}`).join(", ")}</div>` : ""}<div class="row"><span class="faint small">${(p.sources || []).filter((s) => !/^http/.test(s)).join(" · ")}</span><span style="flex:1"></span><button class="btn sm" onclick="App.outreach('${esc(p.name).replace(/'/g, "")}')">Draft outreach</button></div></div>`; }).join("") : '<div class="empty">Scout a niche to fill this.</div>'}</div>`;
  }
  async function scout() {
    const niche = $("#niche").value.trim(); if (!niche) return;
    $("#scoutOut").innerHTML = '<div class="empty">Scouting… GitHub, CoinGecko, DefiLlama, Show HN' + (me.gemini ? ' and the open web' : '') + '.</div>';
    mascot && mascot.set("thinking", "Turning over stones…");
    const r = await api("/api/scout", { niche, objective: $("#obj").value.trim() || undefined });
    $("#scoutOut").innerHTML = scoutCards(r.results, r.watches); mascot && mascot.set("happy", `${r.results.length} projects.`);
  }
  async function scoutWatch() { const niche = $("#niche").value.trim(); if (!niche) return; await say(`keep scouting ${niche}${$("#obj").value ? " for " + $("#obj").value : ""}`); renderScout($("#view")); }
  async function outreach(project) { const ask = window.prompt(`What do you want from ${project}?`, "a partnership / an intro / to integrate"); if (!ask) return; go("chat"); setTimeout(async () => { add("user", `draft outreach to ${project}: ${ask}`); const r = await api("/api/chat", { text: `draft outreach to ${project}: ${ask}` }); add("assistant", r.text, r.buttons); }, 100); }

  /* ---------- lists ---------- */
  function renderLists(V) {
    const by = {}; state.lists.forEach((l) => (by[l.list] = [...(by[l.list] || []), l]));
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.prompt('Add to todo', 'todo: ', 'ship the deck, call the bank')">+ Todo</button> <button class="btn sm" onclick="App.prompt('Add to shopping', 'shopping: ', 'milk, eggs')">+ Shopping</button>`;
    V.innerHTML = Object.keys(by).length ? `<div class="grid">${Object.entries(by).map(([name, items]) => `<div class="panel"><h3>${esc(name)}</h3>${items.map((i) => `<label class="check" style="margin:6px 0"><input type="checkbox" onchange="App.say('finished ${esc(i.text).replace(/'/g, "")}')"> ${esc(i.text)}</label>`).join("")}</div>`).join("")}</div>` : '<div class="empty">No open items. Say "I need to buy milk" or "todo: taxes".</div>';
    if (state.dates.length) V.innerHTML += `<h3 class="serif" style="font-size:22px;margin:22px 0 8px">Dates</h3><div class="panel">${state.dates.map((d) => `<div class="k"><span>${esc(d.label)}</span><span class="muted">${d.on_date}${d.yearly ? " · yearly" : ""}</span></div>`).join("")}</div>`;
  }

  /* ---------- money ---------- */
  async function renderMoney(V) {
    V.innerHTML = '<div class="empty">Loading…</div>';
    const m = await api("/api/money");
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.prompt('Log a spend', '', 'spent 4500 naira on data')">+ Spend</button> <button class="btn sm" onclick="App.prompt('Price alert', '', 'alert when sol above 250')">+ Alert</button> <button class="btn sm" onclick="App.prompt('Watch a wallet (public address)', 'watch wallet ', '<address> on solana as main')">+ Wallet</button>`;
    V.innerHTML = `<div class="grid">
      <div class="panel"><h3>Spend · 7 days</h3>${m.spend.length ? m.spend.map((s) => `<div class="k"><span>${esc(s.category)}</span><b>${Number(s.total).toLocaleString()} ${s.currency}</b></div>`).join("") : '<div class="muted">Nothing logged.</div>'}</div>
      <div class="panel"><h3>Price alerts</h3>${m.alerts.length ? m.alerts.map((a) => `<div class="k"><span>${esc(a.coin)} ${a.op} ${a.op === "move" ? a.target + "% / " + a.pct_window + "h" : "$" + Number(a.target).toLocaleString()}</span><span class="status">${a.active ? "armed" : "fired"}</span></div>`).join("") : '<div class="muted">None armed.</div>'}</div>
      <div class="panel"><h3>Wallets</h3>${m.wallets.length ? m.wallets.map((w) => `<div class="k"><span>${esc(w.label || w.address.slice(0, 10))}</span><span class="muted">${w.chain}</span></div>`).join("") + `<div class="row" style="margin-top:8px"><button class="btn sm" onclick="App.say('portfolio')">Refresh balances in chat</button></div>` : '<div class="muted">No wallets watched. Public addresses only.</div>'}</div>
      <div class="panel"><h3>Copy-trading · shadow</h3>${m.follows.length ? m.follows.map((f) => `<div class="k"><span>${esc(f.label || f.address.slice(0, 10))} · ${f.venue}</span><span class="status">${f.mode}</span></div>`).join("") : '<div class="muted">Not following anyone. Execution is not built; shadow data only.</div>'}</div>
      <div class="panel"><h3>Bills</h3>${m.bills.length ? m.bills.map((b) => `<div class="k"><span>₦${Number(b.amount).toLocaleString()} · ${esc(b.biller_code)}</span><span class="status">${b.status}</span></div>`).join("") : '<div class="muted">No payments yet. Every payment asks for your yes first.</div>'}</div>
    </div>`;
  }

  /* ---------- trips ---------- */
  async function renderTrips(V) {
    const t = await api("/api/trips");
    $("#headActions").innerHTML = `<button class="btn sm" onclick="App.prompt('Plan a trip', 'plan a trip to ', 'Accra from dec 20 to dec 27 budget 600 usd')">+ Trip</button>`;
    V.innerHTML = t.length ? `<div class="grid">${t.map((tr) => { const spent = tr.items.reduce((s, i) => s + Number(i.cost || 0), 0); return `<div class="panel"><h3>${esc(tr.destination)}</h3><div class="muted small">${tr.starts_on || ""}${tr.ends_on ? " → " + tr.ends_on : ""}${tr.budget ? ` · budget ${tr.budget} ${tr.currency}, planned ${spent}` : ""}</div><div class="rule"></div>${["flight", "stay", "transport", "activity", "todo", "pack"].map((k) => { const g = tr.items.filter((i) => i.kind === k); return g.length ? `<div class="lbl" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:8px 0 4px">${k}</div>` + g.map((i) => `<label class="check" style="margin:4px 0"><input type="checkbox" ${i.done ? "checked disabled" : ""} onchange="App.say('packed ${esc(i.title).replace(/'/g, "")}')"> ${esc(i.title)}${i.at ? ` <span class="muted small">${fmt(i.at)}</span>` : ""}${i.cost ? ` <span class="muted small">(${i.cost})</span>` : ""}</label>`).join("") : ""; }).join("")}<div class="row" style="margin-top:10px"><button class="btn sm" onclick="App.prompt('Add to ${esc(tr.destination)}', 'add ', 'flight LOS→ACC to trip on dec 20 7am')">+ Item</button></div></div>`; }).join("")}</div>` : '<div class="empty">No trips. Say "I\'m going to Accra on dec 20".</div>';
  }

  /* ---------- settings ---------- */
  async function renderSettings(V) {
    const s = await api("/api/settings");
    V.innerHTML = `<div class="grid">
      <div class="panel"><h3>Theme</h3><div class="themes">${Object.entries(THEMES).map(([k, l]) => `<div class="theme ${document.documentElement.dataset.theme === k ? "active" : ""}" onclick="App.setTheme('${k}');App.render()"><div class="sw" style="background:linear-gradient(135deg,${swatch(k)})"></div>${l}</div>`).join("")}</div><div class="muted small" style="margin-top:8px">Manor and Riviera are light; Library and Tobacco are dark. Saved to your account and this device.</div></div>
      <div class="panel"><h3>Voice</h3><div class="personas">${Object.entries(s.personas).map(([k, p]) => `<div class="persona ${s.persona === k ? "active" : ""}" onclick="App.say('voice ${k}').then(()=>App.render())"><b>${p.label}</b><small>${esc(p.prompt.slice(0, 60))}…</small></div>`).join("")}</div><div class="row" style="margin-top:10px"><input id="customVoice" placeholder="or describe your own: 'a tired pirate who loves spreadsheets'" style="flex:1" value="${esc(s.personaCustom || "")}"><button class="btn sm" onclick="App.say('voice ' + document.getElementById('customVoice').value)">Set</button></div></div>
      <div class="panel"><h3>Rhythm</h3><div class="k"><span>Timezone</span><input value="${esc(s.tz)}" onchange="App.patch({tz:this.value})" style="width:180px"></div><div class="k"><span>Digest hour</span><input type="number" min="0" max="23" value="${s.digest_hour}" onchange="App.patch({digest_hour:+this.value})" style="width:80px"></div><div class="k"><span>Quiet hours</span><span class="row"><input type="number" min="0" max="23" value="${s.quiet_start}" onchange="App.patch({quiet_start:+this.value})" style="width:70px"> – <input type="number" min="0" max="23" value="${s.quiet_end}" onchange="App.patch({quiet_end:+this.value})" style="width:70px"></span></div><div class="k"><span>Name</span><input value="${esc(s.name || "")}" onchange="App.patch({name:this.value})" style="width:180px"></div><div class="k"><span>Country (venue checks)</span><input value="${esc(s.country || "")}" maxlength="2" onchange="App.patch({country:this.value})" style="width:70px"></div><div class="k"><span>Email fallback</span><input value="${esc(s.email || "")}" onchange="App.patch({email:this.value})" style="width:220px"></div></div>
      <div class="panel"><h3>Channels</h3>${s.identities.map((i) => `<div class="k"><span>${i.channel}</span><span class="muted mono">${esc(i.external_id)}</span></div>`).join("")}<div class="row" style="margin-top:10px"><button class="btn sm" onclick="App.linkCode()">Get a link code</button><span id="linkOut" class="mono"></span></div><div class="muted small" style="margin-top:6px">Text <b>link &lt;code&gt;</b> to the SMS or iMessage number, or paste it on another device.</div></div>
      <div class="panel"><h3>Model</h3><div class="k"><span>Provider</span><span>${s.provider || "rules + loose NL only"}</span></div><div class="k"><span>Spend today</span><span>$${s.spend.toFixed(3)} / $${s.budget}</span></div><div class="k"><span>Interests</span><span class="muted">${(s.tags || []).join(", ") || "—"}</span></div><div class="row" style="margin-top:10px"><button class="btn sm danger" onclick="App.logout()">Sign out</button></div></div>
    </div>`;
  }
  const swatch = (k) => ({ manor: "#F3ECDF,#8C5A2B 60%,#6B2E2E", library: "#17120F,#C9A24D 60%,#7FA08B", riviera: "#F5F2EA,#1F3A5F 60%,#B23A48", tobacco: "#201712,#B9823F 60%,#A3433A" }[k]);
  async function patch(p) { const r = await api("/api/settings", p, "PATCH"); toast(r.text || "Saved"); }
  async function linkCode() { const r = await api("/api/chat", { text: "link" }); $("#linkOut").textContent = (r.text.match(/[A-Z0-9]{6}/) || [""])[0]; }

  window.addEventListener("hashchange", () => { const h = location.hash.replace("#", ""); if (h && h !== view && VIEWS.some(([k]) => k === h)) go(h); });
  boot();
  return { go, send, btn, fill, link, onTg, logout, setTheme, toggleSide, digest, say, prompt, scout, scoutWatch, outreach, patch, linkCode, render };
})();
