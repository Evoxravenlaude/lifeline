/**
 * The path. Today as a landscape, drawn from real data.
 *
 * The sky follows the real hour where the person is: dawn, day, golden hour,
 * dusk, night with stars, and the sun or moon sits where it actually is.
 * A lane runs across the hills from 06:00 (home, on the left) to midnight.
 * Every reminder, event, class and dose today is a lantern beside the lane:
 * behind Pip they are dim and ticked, ahead of him they are lit. Pip walks
 * on the lane at the position of now; if something waits on a yes he stops
 * and holds his watch up. Quiet hours are the stretch where the lamps are off.
 *
 * The layout comes from a fixed seed, so the hills are the same on every
 * visit; only the light, the lanterns and Pip move. The viewBox is sized to
 * the container so nothing is cropped on a phone.
 */
window.Path = (function () {
  const NS = "http://www.w3.org/2000/svg";
  const H = 400;
  const START = 6 * 60, END = 24 * 60;

  /* ---------- colour ---------- */
  const hex = (h) => { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
  const lum = (h) => { const [r, g, b] = hex(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  /* Sky by hour: [hour, top, horizon, light 0..1]. Interpolated between stops. */
  const SKY = [
    [0, "#0B1222", "#1A2440", 0], [4.5, "#0D1527", "#1E2846", 0], [5.6, "#2A3358", "#C98A78", 0.25], [6.6, "#6C86AE", "#F0C69A", 0.6],
    [8, "#8FB4D2", "#EDE2C8", 0.92], [12, "#93BAD6", "#EAE4D2", 1], [16, "#8DB0CE", "#EBDCBF", 0.95], [17.6, "#7A8FB6", "#EFBE8A", 0.75],
    [18.6, "#4C557F", "#D9886F", 0.45], [19.6, "#252C4C", "#6E5672", 0.18], [20.6, "#121A31", "#28304D", 0.04], [24, "#0B1222", "#1A2440", 0],
  ];
  function skyAt(h) {
    for (let i = 0; i < SKY.length - 1; i++) {
      const [h0, t0, b0, l0] = SKY[i], [h1, t1, b1, l1] = SKY[i + 1];
      if (h >= h0 && h <= h1) { const t = (h - h0) / (h1 - h0 || 1); return { top: mix(t0, t1, t), hz: mix(b0, b1, t), light: l0 + (l1 - l0) * t }; }
    }
    return { top: SKY[0][1], hz: SKY[0][2], light: 0 };
  }

  /* Land by light: day greens and sand, night blue-greys. */
  const DAY = { far: "#C3C9AB", mid: "#A3B087", near: "#839566", lane: "#EADFC3", edge: "#B9A57C", tree: "#5D7350", trunk: "#6B5638", roof: "#8C4A3A", wall: "#EFE5CF" };
  const NIGHT = { far: "#283246", mid: "#1F2838", near: "#18202D", lane: "#3B3E4A", edge: "#262833", tree: "#121926", trunk: "#1A1A22", roof: "#2A2230", wall: "#3A3A46" };
  const land = (light, accent) => {
    const o = {}; for (const k in DAY) o[k] = mix(NIGHT[k], DAY[k], light);
    if (accent) { o.near = mix(o.near, accent, 0.14); o.mid = mix(o.mid, accent, 0.08); }
    return o;
  };

  function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  const el = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };

  /** Rolling hill as a path across width W at base y, amplitude a, seeded. */
  function hill(W, base, amp, seed, waves = 3) {
    const r = rng(seed); const ph = [r() * 6, r() * 6, r() * 6]; const fr = [1 + r(), 2.2 + r() * 1.5, 4 + r() * 2];
    let d = `M0 ${H} L0 ${base}`;
    for (let x = 0; x <= W; x += 16) {
      let y = base; for (let i = 0; i < waves; i++) y -= Math.sin((x / W) * Math.PI * fr[i] + ph[i]) * amp / (i + 1);
      d += ` L${x} ${y.toFixed(1)}`;
    }
    return d + ` L${W} ${H} Z`;
  }
  const hillY = (W, base, amp, seed, x, waves = 3) => { const r = rng(seed); const ph = [r() * 6, r() * 6, r() * 6]; const fr = [1 + r(), 2.2 + r() * 1.5, 4 + r() * 2]; let y = base; for (let i = 0; i < waves; i++) y -= Math.sin((x / W) * Math.PI * fr[i] + ph[i]) * amp / (i + 1); return y; };

  /* ---------- Pip, side view, small ---------- */
  function pipSide(g, waiting) {
    const p = el("g", { class: "pip-walk" + (waiting ? " waiting" : "") }, g);
    const legs = el("g", { class: "legs" }, p);
    el("path", { d: "M-15 -6 q -2 7 -5 9 h 7 q 1 -4 2 -9 Z", fill: "var(--skin)", stroke: "var(--skin-dark)", "stroke-width": 1 }, legs);
    el("path", { d: "M10 -6 q 1 7 -1 9 h 7 q 0 -4 -1 -9 Z", fill: "var(--skin)", stroke: "var(--skin-dark)", "stroke-width": 1 }, legs);
    const bob = el("g", { class: "shellbob" }, p);
    el("path", { d: "M-24 -4 q -2 -2 -6 -1", fill: "none", stroke: "var(--skin-dark)", "stroke-width": 2, "stroke-linecap": "round" }, bob);
    el("path", { d: "M-24 -3 C -24 -26, -8 -34, 2 -34 C 14 -34, 24 -24, 22 -3 Z", fill: "var(--brass)", stroke: "var(--brass-dark)", "stroke-width": 1.4 }, bob);
    el("path", { d: "M-16 -4 l 5 -17 h 12 l 5 17 M-11 -21 l 4 -9 M7 -21 l -2 -9", fill: "none", stroke: "var(--brass-dark)", "stroke-opacity": .55, "stroke-width": 1.2, "stroke-linejoin": "round" }, bob);
    el("path", { d: "M-25 -2 Q -1 4 23 -2", fill: "none", stroke: "var(--brass-dark)", "stroke-width": 2.2, "stroke-linecap": "round" }, bob);
    el("path", { d: "M-10 -29 q 6 -4 12 -3", fill: "none", stroke: "#fff", "stroke-opacity": .4, "stroke-width": 1.8, "stroke-linecap": "round" }, bob);
    const head = el("g", { transform: waiting ? "translate(0 -4)" : "" }, bob);
    el("path", { d: "M18 -12 C 20 -24, 40 -24, 40 -13 C 40 -6, 32 -3, 25 -4 C 21 -4, 18 -7, 18 -12 Z", fill: "var(--skin)", stroke: "var(--skin-dark)", "stroke-width": 1.2 }, head);
    el("circle", { cx: 31, cy: -15, r: 2.4, fill: "var(--ink)" }, head);
    el("circle", { cx: 31, cy: -15, r: 5.2, fill: "rgba(255,255,255,.18)", stroke: "var(--brass-dark)", "stroke-width": 1.5 }, head);
    el("path", { d: "M26 -16 l -5 -2", stroke: "var(--brass-dark)", "stroke-width": 1.4, "stroke-linecap": "round" }, head);
    el("path", { d: "M34 -8 q 3 1 5 -1", fill: "none", stroke: "var(--skin-dark)", "stroke-width": 1.3, "stroke-linecap": "round" }, head);
    if (waiting) {
      const w = el("g", { transform: "translate(44 -26)" }, p);
      el("path", { d: "M-8 18 q 4 -8 8 -12", fill: "none", stroke: "var(--brass-light)", "stroke-width": 1.4, "stroke-dasharray": "2 2" }, w);
      el("circle", { r: 7, fill: "var(--paper)", stroke: "var(--brass-dark)", "stroke-width": 1.6 }, w);
      el("path", { d: "M0 0 v-4.5 M0 0 h3", stroke: "var(--ink)", "stroke-width": 1.3, "stroke-linecap": "round" }, w);
    }
    return p;
  }

  /* ---------- the scene ---------- */
  function render(svg, o) { // `svg` is reassigned to the land group below; the root stays in sky0
    const box = svg.getBoundingClientRect();
    const room = o.skyRoom || 0, HT = H + room; // extra sky above the land, for pages that set words on it
    const W = Math.max(520, Math.round((box.width / Math.max(1, box.height)) * HT)) || 1600;
    svg.setAttribute("viewBox", `0 0 ${W} ${HT}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMax slice");
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const hour = o.nowMin / 60;
    const sky = skyAt(hour);
    const L = land(sky.light, o.accent);
    const id = (s) => `${s}-${o.uid}`;

    const defs = el("defs", {}, svg);
    const sg = el("linearGradient", { id: id("sky"), x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    el("stop", { offset: "0", "stop-color": sky.top }, sg); el("stop", { offset: ".72", "stop-color": sky.hz }, sg);
    const glow = el("radialGradient", { id: id("glow") }, defs);
    el("stop", { offset: "0", "stop-color": "#FFE9B0", "stop-opacity": ".9" }, glow); el("stop", { offset: "1", "stop-color": "#FFE9B0", "stop-opacity": "0" }, glow);
    const orbG = el("radialGradient", { id: id("orb") }, defs);
    el("stop", { offset: "0", "stop-color": sky.light > 0.3 ? "#FFF4D6" : "#F4F1E6" }, orbG); el("stop", { offset: ".5", "stop-color": sky.light > 0.3 ? "#FFE3A0" : "#E8E4D6", "stop-opacity": ".6" }, orbG); el("stop", { offset: "1", "stop-color": "#FFE3A0", "stop-opacity": "0" }, orbG);

    el("rect", { x: 0, y: 0, width: W, height: HT, fill: `url(#${id("sky")})` }, svg);

    // stars
    if (sky.light < 0.35) {
      const r = rng(7); const g = el("g", { opacity: (1 - sky.light / 0.35).toFixed(2) }, svg);
      for (let i = 0; i < Math.round(W / 14); i++) el("circle", { cx: (r() * W).toFixed(1), cy: (r() * (room + H * 0.5)).toFixed(1), r: (r() * 1.1 + 0.3).toFixed(2), fill: "#F6F1E2", opacity: (r() * 0.6 + 0.3).toFixed(2), class: r() < 0.2 ? "twinkle" : "" }, g);
    }
    // sun by day, moon by night, on a real arc
    const isDay = hour >= 5.5 && hour <= 19.5;
    const f = isDay ? (hour - 5.5) / 14 : ((hour < 12 ? hour + 24 : hour) - 19.5) / 10;
    // The sun crosses the whole sky; the moon keeps to the right half so it never sits behind words.
    const ox = isDay ? 40 + f * (W - 80) : W * (0.6 + 0.32 * f), oy = room + H * 0.62 - Math.sin(f * Math.PI) * (H * 0.48 + room * 0.6);
    el("circle", { cx: ox, cy: oy, r: 54, fill: `url(#${id("orb")})`, opacity: isDay ? 1 : 0.55 }, svg);
    if (isDay) el("circle", { cx: ox, cy: oy, r: 15, fill: "#FFF1CC" }, svg);
    else el("path", { d: `M${ox + 5} ${oy - 16} A16 16 0 1 0 ${ox + 5} ${oy + 16} A19 19 0 0 1 ${ox + 5} ${oy - 16} Z`, fill: "#F2EEDF" }, svg);

    // far hills, a village, mid hills with trees
    const sky0 = svg; svg = el("g", { transform: `translate(0 ${room})` }, sky0);
    el("path", { d: hill(W, H * 0.6, 26, 3), fill: L.far }, svg);
    const vill = el("g", {}, svg);
    const vr = rng(21);
    for (let i = 0; i < 4; i++) {
      const vx = W * (0.55 + i * 0.07 + vr() * 0.03), vy = hillY(W, H * 0.6, 26, 3, vx) + 2;
      el("rect", { x: vx - 9, y: vy - 12, width: 18, height: 12, fill: L.wall, opacity: .9 }, vill);
      el("path", { d: `M${vx - 11} ${vy - 12} L${vx} ${vy - 21} L${vx + 11} ${vy - 12} Z`, fill: L.roof }, vill);
      el("rect", { x: vx - 3, y: vy - 9, width: 5, height: 5, fill: sky.light < 0.4 ? "#F4C66B" : L.trunk, opacity: sky.light < 0.4 ? 1 : 0.5 }, vill);
    }
    el("path", { d: hill(W, H * 0.7, 22, 9), fill: L.mid }, svg);
    const tr = rng(5); const trees = el("g", {}, svg);
    for (let x = 30; x < W; x += 60 + tr() * 120) {
      const y = hillY(W, H * 0.7, 22, 9, x) + 4; const s = 0.7 + tr() * 0.6;
      if (tr() < 0.4) el("path", { d: `M${x} ${y} q ${-5 * s} ${-18 * s} 0 ${-36 * s} q ${5 * s} ${18 * s} 0 ${36 * s} Z`, fill: L.tree }, trees);
      else { el("rect", { x: x - 1.2, y: y - 9 * s, width: 2.4, height: 9 * s, fill: L.trunk }, trees); el("circle", { cx: x, cy: y - 14 * s, r: 9 * s, fill: L.tree }, trees); }
    }

    // near hill and the lane
    el("path", { d: hill(W, H * 0.8, 14, 13, 2), fill: L.near }, svg);
    const y0 = H * 0.86, y1 = H * 0.78;
    const laneD = `M -10 ${y0} C ${W * 0.2} ${y0 + 16}, ${W * 0.32} ${y1 - 14}, ${W * 0.5} ${y1 + 2} S ${W * 0.8} ${y0 + 10}, ${W + 10} ${y1}`;
    el("path", { d: laneD, fill: "none", stroke: L.edge, "stroke-width": 22, "stroke-linecap": "round" }, svg);
    const lane = el("path", { d: laneD, fill: "none", stroke: L.lane, "stroke-width": 17, "stroke-linecap": "round" }, svg);
    const len = lane.getTotalLength();
    const at = (min) => { const t = Math.max(0, Math.min(1, (min - START) / (END - START))); return lane.getPointAtLength(0.04 * len + t * 0.92 * len); };

    // quiet hours: lamps off
    if (o.quiet && o.quiet[0] != null) {
      const qs = o.quiet[0] * 60, qe = o.quiet[1] * 60;
      const from = qs > qe ? qs : qs, to = qs > qe ? END : qe;
      if (to > from && from < END) {
        const a = 0.04 * len + Math.max(0, (from - START) / (END - START)) * 0.92 * len, b = 0.04 * len + Math.min(1, (to - START) / (END - START)) * 0.92 * len;
        el("path", { d: laneD, fill: "none", stroke: "#1b1f2a", "stroke-opacity": .1 + (1 - sky.light) * .1, "stroke-width": 17, "stroke-dasharray": `0 ${a} ${b - a} ${len}` }, svg);
      }
    }

    // home at the start of the lane
    const hp = at(START - 20); const home = el("g", { transform: `translate(${Math.max(26, hp.x + 8)} ${hp.y - 9})` }, svg);
    el("rect", { x: -16, y: -22, width: 32, height: 22, fill: L.wall, stroke: L.trunk, "stroke-width": 1 }, home);
    el("path", { d: "M-20 -22 L0 -38 L20 -22 Z", fill: L.roof }, home);
    el("rect", { x: -4, y: -12, width: 8, height: 12, fill: L.trunk }, home);
    el("rect", { x: 7, y: -17, width: 6, height: 6, fill: sky.light < 0.5 ? "#F4C66B" : L.lane }, home);

    // lanterns
    const items = (o.items || []).filter((i) => i.min >= START - 30 && i.min <= END).sort((a, b) => a.min - b.min);
    let lastX = -999, lift = 0;
    const lamps = el("g", {}, svg);
    items.forEach((it, idx) => {
      const pt = at(it.min); const past = it.min < o.nowMin || it.done;
      lift = pt.x - lastX < 34 ? (lift + 1) % 3 : 0; lastX = pt.x;
      const side = idx % 2 ? 1 : -1;
      const postH = 30 + lift * 16;
      const g = el("g", { class: "lantern", transform: `translate(${pt.x.toFixed(1)} ${(pt.y + side * 3 - 6).toFixed(1)})`, tabindex: 0, role: "button", "aria-label": `${it.time} ${it.label}` }, lamps);
      el("line", { x1: 0, y1: 0, x2: 0, y2: -postH, stroke: L.trunk, "stroke-width": 2.2, "stroke-linecap": "round" }, g);
      el("line", { x1: 0, y1: -postH, x2: 5, y2: -postH, stroke: L.trunk, "stroke-width": 2 }, g);
      if (!past) el("circle", { class: "lamp-glow", cx: 5, cy: -postH + 9, r: 22, fill: `url(#${id("glow")})`, opacity: sky.light < 0.5 ? 1 : 0.55 }, g);
      el("rect", { class: "lamp-ring", x: -1, y: -postH + 2, width: 12, height: 15, rx: 3, fill: past ? "#9B9586" : `var(--k-${it.kind}-lit, #F6D98E)`, stroke: L.trunk, "stroke-width": 1.6, opacity: past ? 0.75 : 1 }, g);
      el("rect", { x: 1.5, y: -postH + 0, width: 7, height: 2.5, rx: 1, fill: L.trunk }, g);
      if (past) el("path", { d: `M1.5 ${-postH + 9.5} l2.5 2.5 l4.5 -5`, fill: "none", stroke: "#2B2A26", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }, g);
      g.addEventListener("mouseenter", () => o.onHover && o.onHover(it, g));
      g.addEventListener("focus", () => o.onHover && o.onHover(it, g));
      g.addEventListener("mouseleave", () => o.onHover && o.onHover(null));
      g.addEventListener("blur", () => o.onHover && o.onHover(null));
      g.addEventListener("click", () => o.onPick && o.onPick(it));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); o.onPick && o.onPick(it); } });
    });

    // Pip at now, with the time on a small sign
    const nowMin = Math.max(START - 20, Math.min(END, o.nowMin));
    const pp = at(nowMin);
    const pg = el("g", { transform: `translate(${pp.x.toFixed(1)} ${(pp.y + 3).toFixed(1)}) scale(${W < 900 ? 1.05 : 1.25})` }, svg);
    pipSide(pg, o.waiting);
    if (o.showNow !== false) {
      const sign = el("g", { transform: `translate(${pp.x.toFixed(1)} ${(pp.y - 64).toFixed(1)})` }, svg);
      const label = o.nowLabel || "";
      const w = 14 + label.length * 7.4;
      el("rect", { x: -w / 2, y: -12, width: w, height: 22, rx: 5, fill: "var(--panel)", stroke: "var(--ink)", "stroke-width": 1.4 }, sign);
      el("path", { d: "M-4 10 L0 15 L4 10 Z", fill: "var(--panel)", stroke: "var(--ink)", "stroke-width": 1.4, "stroke-linejoin": "round" }, sign);
      el("rect", { x: -3.5, y: 8.5, width: 7, height: 2.5, fill: "var(--panel)" }, sign);
      const t = el("text", { x: 0, y: 4, "text-anchor": "middle", "font-family": "Hanken Grotesk, system-ui, sans-serif", "font-size": 12.5, "font-weight": 700, fill: "var(--ink)" }, sign);
      t.textContent = label;
    }

    // text on the sky: light ink at night, dark ink by day
    const dark = lum(sky.top) < 0.18;
    const host = o.inkHost || sky0.parentElement;
    host.style.setProperty("--sky-ink", dark ? "#F4EEE1" : "#1F1B16");
    host.style.setProperty("--sky-ink-2", dark ? "rgba(244,238,225,.82)" : "rgba(31,27,22,.78)");
    return { W, sky };
  }

  /** Mount a living scene: re-renders on resize and every minute. */
  function mount(container, opts) {
    const svg = el("svg", { class: "path-svg", role: "img", "aria-label": opts.aria || "Today as a path across the hills" });
    container.prepend(svg);
    let o = Object.assign({ uid: Math.random().toString(36).slice(2, 7) }, opts);
    const draw = () => render(svg, o);
    let raf = 0; const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); }); ro.observe(svg);
    draw();
    return { update(next) { o = Object.assign(o, next); draw(); }, destroy() { ro.disconnect(); svg.remove(); } };
  }

  return { mount, skyAt };
})();
