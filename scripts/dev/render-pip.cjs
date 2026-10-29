/**
 * Renders Pip's sticker set from web/mascot.js: each pose is Pip with a small letterpress caption card
 * (the same ink edge and offset plate as the website's cards), in EB Garamond italic.
 * Output: assets/pip/<name>.png, 512x512, transparent. Run: node scripts/dev/render-pip.cjs
 */
const { chromium } = require("playwright");
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "../..");
const font = (f) => `url(data:font/woff2;base64,${fs.readFileSync(path.join(root, "web/fonts", f)).toString("base64")})`;

/* name: [mascot state, caption, plate colour token, extra CSS for the pose, extra SVG drawn over him] */
const POSES = {
  hello: ["idle", "Hello.", "--k-trip", ".pip .head{transform:rotate(-6deg)} .pip .brow{transform:translateY(-3px)}", ""],
  noted: ["done", "Noted.", "--k-list", ".pip .head{transform:translateY(-2px)} .pip .eye{transform:scaleY(.18);transform-origin:center} .pip .specs{opacity:.9}", ""],
  thinking: ["thinking", "Hmm.", "--k-event", ".pip .head{transform:rotate(-9deg) translateY(-2px)} .pip .brow-r{transform:translateY(-6px) rotate(-8deg)}", ""],
  waiting: ["pending", "Your call.", "--k-rem", ".pip .watch{transform:translate(-12px,-18px) scale(1.55)}", ""],
  carrying: ["reminder", "Don't forget.", "--k-dose", ".pip .shell{transform:translateY(-6px) scale(1.04)}", `<g transform="translate(70 22) rotate(-8)"><rect width="22" height="16" rx="2" fill="var(--paper)" stroke="var(--ink)" stroke-width="1.6"/><path d="M4 5h14M4 9h10" stroke="var(--ink)" stroke-width="1.2"/></g>`],
  asleep: ["quiet", "Quiet hours.", "--k-class", ".pip .head{transform:translateY(7px) rotate(5deg)}", `<g fill="var(--ink)" font-family="EB Garamond" font-style="italic" font-size="15"><text x="104" y="70">z</text><text x="114" y="56" font-size="19">z</text></g>`],
  oops: ["error", "Oops.", "--k-hack", ".pip .head{transform:rotate(8deg)} .pip .brow-l{transform:translateY(-4px) rotate(10deg)} .pip .brow-r{transform:translateY(-4px) rotate(-10deg)} .pip .mouth{d:path('M74 120 q 6 -4 12 0')}", ""],
  cheers: ["done", "Well done.", "--k-money", ".pip .head{transform:translateY(-4px)} .pip .mouth{d:path('M70 116 q 10 10 20 0')}", `<g stroke="var(--ink)" stroke-width="1.2"><rect x="30" y="40" width="7" height="7" fill="var(--k-rem)" transform="rotate(20 33 43)"/><rect x="124" y="34" width="7" height="7" fill="var(--k-hack)" transform="rotate(-15 127 37)"/><rect x="46" y="20" width="6" height="6" fill="var(--k-event)" transform="rotate(35 49 23)"/><rect x="108" y="16" width="6" height="6" fill="var(--k-dose)" transform="rotate(-30 111 19)"/><circle cx="140" cy="62" r="3" fill="var(--k-class)"/><circle cx="22" cy="66" r="3" fill="var(--k-money)"/></g>`],
  later: ["idle", "Later, then.", "--k-scout", ".pip .head{transform:rotate(4deg)} .pip .eye{transform:scaleY(.55);transform-origin:center}", ""],
  ontoit: ["thinking", "On it.", "--k-trip", ".pip .head{transform:translateY(-3px)} .pip .brow{transform:translateY(2px)}", ""],
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  const css = fs.readFileSync(path.join(root, "web/styles.css"), "utf8").replace(/@font-face[^}]+}/g, "");
  const js = fs.readFileSync(path.join(root, "web/mascot.js"), "utf8");
  await p.setContent(`<!doctype html><html data-palette="manor" data-mode="day"><head><style>
    @font-face{font-family:"EB Garamond";font-style:italic;font-weight:400 800;src:${font("eb-garamond-latin-wght-italic.woff2")} format("woff2")}
    ${css}
    html,body{background:transparent!important;margin:0}
    #s{position:relative;width:512px;height:512px}
    #m{position:absolute;left:46px;top:6px;width:420px;height:420px}
    .pip-line{display:none!important} .pip .body,.pip .watch .hand,.pip .head{animation:none!important} .pip .shadow{opacity:.16}
    .cap{position:absolute;left:50%;bottom:22px;transform:translateX(-50%) rotate(-2deg);font-family:"EB Garamond",serif;font-style:italic;font-weight:500;font-size:46px;line-height:1;
      color:var(--ink);background:var(--paper);border:3px solid var(--ink);border-radius:14px;padding:12px 26px 14px;white-space:nowrap;box-shadow:8px 8px 0 0 var(--plate),8px 8px 0 3px var(--ink)}
  </style><style id="pose"></style></head><body><div id="s"><div id="m"></div><div class="cap" id="c"></div></div><script>${js}</script></body></html>`);
  await p.evaluate(() => document.fonts.ready);
  for (const [name, [state, caption, plate, poseCss, extra]] of Object.entries(POSES)) {
    await p.evaluate(({ state, caption, plate, poseCss, extra }) => {
      const m = document.getElementById("m"); m.innerHTML = "";
      window.Mascot.mount(m, {}).set(state);
      document.getElementById("pose").textContent = poseCss;
      const svg = m.querySelector("svg");
      if (extra) svg.insertAdjacentHTML("beforeend", extra);
      const c = document.getElementById("c"); c.textContent = caption; c.style.setProperty("--plate", `var(${plate})`);
    }, { state, caption, plate, poseCss, extra });
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(root, `assets/pip/${name}.png`), omitBackground: true, clip: { x: 0, y: 0, width: 512, height: 512 } });
  }
  await b.close();
  console.log("rendered", Object.keys(POSES).join(", "));
})();
