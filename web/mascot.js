/**
 * Pip. A tortoise with spectacles. Original design, SVG only.
 *
 * He is slow on purpose: reads everything before he moves, never puts down
 * what he carries, still there in the morning. Every state maps to a real
 * state of the person's day; nothing here is decorative.
 *
 *   idle       nothing needs you. breathing, the odd blink, eyes follow the cursor
 *   thinking   a message is with the brain. head tilts, one brow up, pupils drift up
 *   pending    something waits on your yes. he sits up, watch in hand
 *   done       you ticked something. a nod
 *   reminder   he is carrying one back to you. shell lifts a touch
 *   quiet      quiet hours. lids down, slow breathing
 *   empty      nothing kept yet. he looks straight at you
 *   error      the thread slipped. a small shake
 */
window.Mascot = (function () {
  const SVG = `
<svg class="pip" viewBox="0 0 160 160" data-state="idle" role="img" aria-label="Pip, the tortoise who keeps your day">
  <defs>
    <radialGradient id="pipShell" cx="42%" cy="30%" r="75%"><stop offset="0" stop-color="var(--brass-light)"/><stop offset=".65" stop-color="var(--brass)"/><stop offset="1" stop-color="var(--brass-dark)"/></radialGradient>
    <radialGradient id="pipSkin" cx="40%" cy="30%" r="80%"><stop offset="0" stop-color="var(--skin-light)"/><stop offset="1" stop-color="var(--skin)"/></radialGradient>
    <linearGradient id="pipGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/></linearGradient>
  </defs>
  <ellipse class="shadow" cx="80" cy="140" rx="48" ry="6" fill="var(--ink)" opacity=".12"/>
  <g class="body">
    <g class="legs">
      <ellipse cx="42" cy="124" rx="14" ry="9" fill="url(#pipSkin)"/>
      <ellipse cx="118" cy="124" rx="14" ry="9" fill="url(#pipSkin)"/>
      <path d="M34 126 l-3 4 M40 128 l0 4 M46 127 l2 4 M112 127 l-2 4 M118 128 l0 4 M124 126 l3 4" stroke="var(--skin-dark)" stroke-width="1.4" stroke-linecap="round"/>
    </g>
    <g class="shell">
      <path d="M28 112 C 26 66, 52 38, 80 38 C 110 38, 134 68, 132 112 Z" fill="url(#pipShell)"/>
      <path d="M28 112 C 26 66, 52 38, 80 38 C 110 38, 134 68, 132 112 Z" fill="none" stroke="var(--brass-dark)" stroke-opacity=".55" stroke-width="2"/>
      <g fill="none" stroke="var(--brass-dark)" stroke-opacity=".5" stroke-width="1.8" stroke-linejoin="round">
        <path d="M46 108 l12 -34 h26 l12 34"/>
        <path d="M58 74 l10 -24 h14 l10 24"/>
        <path d="M36 108 l10 -24 M124 108 l-10 -24 M46 84 l12 -10 M114 84 l-12 -10"/>
      </g>
      <path d="M30 115 Q 80 128 130 115" fill="none" stroke="var(--brass-dark)" stroke-opacity=".6" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M60 50 q 8 -7 18 -5" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="2.5" stroke-linecap="round"/>
    </g>
    <g class="watch">
      <path d="M108 102 q 12 -8 20 0" fill="none" stroke="var(--brass-light)" stroke-width="1.8" stroke-dasharray="2.5 2.5"/>
      <circle cx="129" cy="104" r="7" fill="var(--paper)" stroke="var(--brass-dark)" stroke-width="1.6"/>
      <path class="hand" d="M129 104 v-4.5 M129 104 h3" stroke="var(--ink)" stroke-width="1.3" stroke-linecap="round" fill="none"/>
    </g>
    <g class="head">
      <path d="M54 104 C 52 80, 64 72, 80 72 C 96 72, 108 80, 106 104 C 105 120, 94 128, 80 128 C 66 128, 55 120, 54 104 Z" fill="url(#pipSkin)"/>
      <path d="M54 104 C 52 80, 64 72, 80 72 C 96 72, 108 80, 106 104 C 105 120, 94 128, 80 128 C 66 128, 55 120, 54 104 Z" fill="none" stroke="var(--skin-dark)" stroke-opacity=".35" stroke-width="1.2"/>
      <circle cx="63" cy="112" r="4.2" fill="var(--oxblood)" opacity=".14"/><circle cx="97" cy="112" r="4.2" fill="var(--oxblood)" opacity=".14"/>
      <g class="eye eye-l"><circle cx="69" cy="98" r="6.5" fill="var(--paper)"/><circle class="pupil" cx="69" cy="98" r="3.2" fill="var(--ink)"/><circle cx="67.5" cy="96.5" r="1" fill="#fff"/><rect class="lid" x="61" y="90" width="16" height="16" rx="6" fill="var(--skin)"/></g>
      <g class="eye eye-r"><circle cx="91" cy="98" r="6.5" fill="var(--paper)"/><circle class="pupil" cx="91" cy="98" r="3.2" fill="var(--ink)"/><circle cx="89.5" cy="96.5" r="1" fill="#fff"/><rect class="lid" x="83" y="90" width="16" height="16" rx="6" fill="var(--skin)"/></g>
      <g class="specs" fill="url(#pipGlass)" stroke="var(--brass-dark)" stroke-width="2">
        <circle cx="69" cy="98" r="11"/><circle cx="91" cy="98" r="11"/>
        <path d="M80 98 h0.5 M58 96 l-6 -3 M102 96 l6 -3" fill="none" stroke-linecap="round"/>
      </g>
      <path class="brow brow-l" d="M60 84 q 9 -5 17 -1" fill="none" stroke="var(--skin-dark)" stroke-width="2.6" stroke-linecap="round"/>
      <path class="brow brow-r" d="M83 83 q 8 -4 17 1" fill="none" stroke="var(--skin-dark)" stroke-width="2.6" stroke-linecap="round"/>
      <path class="mouth" d="M73 118 q 7 4 14 0" fill="none" stroke="var(--skin-dark)" stroke-width="2.2" stroke-linecap="round"/>
      <path d="M78 109 q 2 2 4 0" fill="none" stroke="var(--skin-dark)" stroke-width="1.4" stroke-linecap="round" opacity=".6"/>
    </g>
  </g>
</svg>`;

  let el, pupils, bubble, state = "idle", blinkTimer, api, revert;

  function mount(container, opts = {}) {
    api = opts.api;
    container.innerHTML = `<div class="pip-wrap ${opts.size || ""}">${SVG}<div class="pip-line" aria-live="polite">${opts.greeting || "I'm Pip. I keep your day so it doesn't have to live in your head."}</div></div>`;
    el = container.querySelector(".pip");
    pupils = [...el.querySelectorAll(".pupil")];
    bubble = container.querySelector(".pip-line");
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) document.addEventListener("mousemove", track);
    el.addEventListener("click", () => speak(true));
    el.style.cursor = "pointer";
    scheduleBlink();
    return { set, say, speak, state: () => state };
  }
  function track(e) {
    if (!el || state === "quiet" || state === "thinking") return;
    const r = el.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height * 0.5);
    const d = Math.min(1, Math.hypot(dx, dy) / 420);
    const a = Math.atan2(dy, dx);
    pupils.forEach((p) => (p.style.transform = `translate(${Math.cos(a) * 2.8 * d}px,${Math.sin(a) * 2.4 * d}px)`));
  }
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(() => {
      if (el && state !== "quiet") { el.classList.add("blink"); setTimeout(() => el.classList.remove("blink"), 180); }
      scheduleBlink();
    }, 2800 + Math.random() * 3600);
  }
  /** set(state, line?). Transient states (done, error, reminder) return to idle on their own. */
  function set(s, text) {
    clearTimeout(revert);
    state = s;
    if (el) el.dataset.state = s;
    if (text) say(text);
    if (s === "thinking") pupils.forEach((p) => (p.style.transform = "translate(1.5px,-2.5px)"));
    if (s === "done" || s === "error" || s === "reminder") revert = setTimeout(() => set("idle"), 2400);
  }
  function say(text) { if (bubble && text) bubble.textContent = text; }
  async function speak(fromClick) {
    if (api) { try { const r = await api(state); if (r && r.text) return say(r.text); } catch {} }
    if (fromClick) say("Still here.");
  }
  return { mount };
})();
