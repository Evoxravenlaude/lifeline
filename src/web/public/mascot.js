/**
 * Pip — lifeline's mascot. A tortoise with spectacles and a pocket watch:
 * steady, keeps time, never rushes you. Original design, SVG only.
 *
 * States: idle · thinking · happy · alert · sleep. Pupils follow the cursor,
 * eyes blink on their own, a click asks for a quip in the user's persona.
 */
window.Mascot = (function () {
  const SVG = `
<svg class="mascot" viewBox="0 0 150 150" data-state="idle" aria-label="Pip the tortoise">
  <defs>
    <radialGradient id="shellG" cx="45%" cy="35%" r="70%"><stop offset="0" stop-color="var(--gold)"/><stop offset="1" stop-color="var(--accent)"/></radialGradient>
    <radialGradient id="skinG" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="#C9B48A"/><stop offset="1" stop-color="#8F7A4F"/></radialGradient>
  </defs>
  <ellipse cx="75" cy="128" rx="46" ry="7" fill="rgba(0,0,0,.14)"/>
  <g class="body">
    <!-- legs -->
    <ellipse cx="44" cy="117" rx="13" ry="9" fill="url(#skinG)"/><ellipse cx="106" cy="117" rx="13" ry="9" fill="url(#skinG)"/>
    <!-- shell -->
    <path d="M28 108 C 26 70, 52 46, 80 46 C 110 46, 128 72, 124 108 Z" fill="url(#shellG)" stroke="var(--accent2)" stroke-opacity=".45" stroke-width="2"/>
    <path d="M44 104 l12 -30 l22 0 l12 30 Z M58 74 l10 -20 l16 0 l10 20 Z M36 104 l8 -18 M114 104 l-8 -18" fill="none" stroke="var(--accent2)" stroke-opacity=".45" stroke-width="2" stroke-linejoin="round"/>
    <path d="M30 110 Q 75 122 122 110" fill="none" stroke="var(--accent2)" stroke-opacity=".5" stroke-width="3" stroke-linecap="round"/>
    <!-- pocket watch chain -->
    <path d="M100 100 q 10 -6 16 2" fill="none" stroke="var(--gold)" stroke-width="2" stroke-dasharray="2 2"/>
    <circle cx="117" cy="103" r="6" fill="var(--gold)" stroke="var(--accent2)" stroke-opacity=".5"/><path d="M117 100 v3 l2 1" stroke="var(--accent2)" stroke-width="1.2" fill="none"/>
    <!-- head -->
    <g class="head" style="transform-origin:75px 90px">
      <path d="M48 92 C 46 66, 60 54, 76 54 C 94 54, 106 66, 104 92 C 102 106, 90 112, 76 112 C 62 112, 50 106, 48 92 Z" fill="url(#skinG)"/>
      <!-- cheeks -->
      <circle cx="58" cy="94" r="4" fill="var(--accent2)" opacity=".18"/><circle cx="94" cy="94" r="4" fill="var(--accent2)" opacity=".18"/>
      <!-- spectacles -->
      <circle cx="64" cy="78" r="11" fill="rgba(255,255,255,.12)" stroke="var(--accent2)" stroke-width="2"/>
      <circle cx="88" cy="78" r="11" fill="rgba(255,255,255,.12)" stroke="var(--accent2)" stroke-width="2"/>
      <path d="M75 78 h2 M53 76 l-6 -3 M99 76 l6 -3" stroke="var(--accent2)" stroke-width="2" stroke-linecap="round"/>
      <!-- brows -->
      <path class="brow" d="M56 64 q 8 -4 15 0" fill="none" stroke="#5B4A2E" stroke-width="2.4" stroke-linecap="round" style="transition:transform .15s"/>
      <path class="brow" d="M81 64 q 7 -4 15 0" fill="none" stroke="#5B4A2E" stroke-width="2.4" stroke-linecap="round" style="transition:transform .15s"/>
      <!-- eyes -->
      <g class="eye"><circle cx="64" cy="78" r="6.5" fill="#FBF7EF"/><circle class="pupil" cx="64" cy="78" r="3.2" fill="#2A2521" style="transition:transform .08s"/><circle cx="62.5" cy="76.5" r="1" fill="#fff"/><rect class="lid" x="56" y="70" width="16" height="16" rx="6" fill="#B29F72"/></g>
      <g class="eye"><circle cx="88" cy="78" r="6.5" fill="#FBF7EF"/><circle class="pupil" cx="88" cy="78" r="3.2" fill="#2A2521" style="transition:transform .08s"/><circle cx="86.5" cy="76.5" r="1" fill="#fff"/><rect class="lid" x="80" y="70" width="16" height="16" rx="6" fill="#B29F72"/></g>
      <!-- mouth -->
      <path class="mouth" d="M64 92 Q 75 98 86 92" fill="none" stroke="#5B4A2E" stroke-width="2.2" stroke-linecap="round" style="transition:d .2s"/>
    </g>
  </g>
  <g class="zz"><text x="112" y="56" font-size="14">z</text><text x="120" y="44" font-size="11">z</text></g>
</svg>`;

  const QUIPS = {
    idle: ["Steady on. What's next?", "I keep the time so you don't have to.", "Nothing's on fire. Good day to plan something.", "Say the thing. I'll hold it.", "Slow is smooth. Smooth is fast."],
    thinking: ["Give me a tick…", "Consulting the ledger…", "Turning it over…"],
    happy: ["Noted. Properly.", "That's one less thing in your head.", "Good. Ticked."],
    alert: ["That one needs a yes from you.", "I won't move money on a guess.", "Confirm it and I'll go."],
    sleep: ["Quiet hours. I'll keep the list warm.", "Resting. Reminders still ring.", "zzz… wake me with a word."],
  };

  let el, pupils, bubble, state = "idle", lastQuip = 0, blinkTimer, api;

  function mount(container, opts = {}) {
    api = opts.api;
    container.innerHTML = `<div class="mascot-wrap">${SVG}<div class="bubble" id="mascotBubble">${opts.greeting || "I'm Pip. I keep your day."}</div></div>`;
    el = container.querySelector(".mascot");
    pupils = [...el.querySelectorAll(".pupil")];
    bubble = container.querySelector("#mascotBubble");
    document.addEventListener("mousemove", track);
    el.addEventListener("click", () => quip(true));
    scheduleBlink();
    return { set, say, quip };
  }
  function track(e) {
    if (!el || state === "sleep") return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * 0.5);
    const d = Math.min(1, Math.hypot(dx, dy) / 400);
    const a = Math.atan2(dy, dx);
    const x = Math.cos(a) * 2.6 * d, y = Math.sin(a) * 2.2 * d;
    if (state !== "thinking") pupils.forEach((p) => (p.style.transform = `translate(${x}px,${y}px)`));
  }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      if (el && state !== "sleep") { el.classList.add("blink"); setTimeout(() => el.classList.remove("blink"), 220); }
      scheduleBlink();
    }, 2600 + Math.random() * 3200);
  }
  function set(s, text) {
    state = s;
    if (el) el.dataset.state = s;
    if (text) say(text);
    else if (s !== "idle" && Date.now() - lastQuip > 1500) say(pick(QUIPS[s] || QUIPS.idle));
    if (s === "happy" || s === "alert") setTimeout(() => { if (state === s) set("idle"); }, 2200);
  }
  function say(text) { if (bubble) { bubble.textContent = text; lastQuip = Date.now(); } }
  async function quip(fromClick) {
    if (api && fromClick) {
      try { const r = await api(); if (r && r.text) return say(r.text); } catch {}
    }
    say(pick(QUIPS[state] || QUIPS.idle));
  }
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return { mount };
})();
