# Engineering Index

## Active

- Reddit OAuth migration (2026-06-08) — `api/_lib/reddit-oauth.js`, `scripts/reddit-poster.js`. Awaiting `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from Heath. Once set in Vercel env + .env.local, run `node scripts/reddit-poster.js --test-mode` to verify.
- ~~Cookie health monitor (2026-06-08)~~ REMOVED 2026-06-11 by SV-ENG-COOKIE-MIGRATION. Reddit / IG / LinkedIn / FB now run on persistent DossieBot Chrome profile + Windows Task Scheduler keepalives every 3 days. `cron-account-session-monitor.js` (every 6h) covers the Zernio publishing-side check.
- Stealth on FB/IG/LinkedIn (2026-06-08) — `playwright-extra` + `puppeteer-extra-plugin-stealth` wrapped into `fb-group-poster.js`, `fb-group-commenter.js`, `instagram-engager.js`, `linkedin-engager.js`.

## Phase D (queue when stealth + Chrome profile hit ceiling)

- Residential proxy subscription — Smartproxy or Bright Data, $10-30/mo. Set per-script via `HTTP_PROXY` env var.
- 2Captcha integration — $5 seed; solves hCaptcha + reCAPTCHA when triggered. Add `TWOCAPTCHA_API_KEY` to env, wire into a `_lib/captcha-solver.js` helper.

Trigger Phase D when: scripts get a captcha challenge OR Facebook bot-detection rate exceeds ~10% even with stealth.
