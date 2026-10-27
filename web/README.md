# lifeline web

The same files Railway serves at `/` are a Vercel project, so the web app can live on its own domain while the brain stays on Railway.

## Deploy on Vercel

1. Edit `vercel.json`: replace `YOUR-RAILWAY-DOMAIN.up.railway.app` with the public domain of the Railway service (Railway → service → Settings → Networking → Generate Domain).
2. In Vercel: New Project → import the `lifeline` repo → **Root Directory: `web`** → Framework: Other → Deploy. No build step.
3. Add your domain in Vercel → Project → Domains (e.g. `lifeline.yourdomain.xyz`) and point DNS as it tells you.
4. In Doppler, set `PUBLIC_URL` on the brain to that domain (`https://lifeline.yourdomain.xyz`). Leave `WEB_ORIGINS` empty: the rewrites above proxy `/api` and `/auth` through the Vercel domain, so cookies stay first-party and no CORS is needed.
5. In BotFather: `/setdomain` → pick the bot → send the same domain. That makes the Telegram sign-in button work on the web app.

Pushing to the repo redeploys both Railway (the brain) and Vercel (the front).

## If you'd rather call Railway directly (no proxy)

Delete the `rewrites` from `vercel.json`, set `WEB_ORIGINS=https://lifeline.yourdomain.xyz` on the brain, and change `api()` in `app.js` to prefix requests with the Railway URL and use `credentials: "include"`. The proxy route is simpler; use this only if you need websockets later.
