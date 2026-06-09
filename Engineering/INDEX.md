# Engineering Index

## Active

- Reddit OAuth migration (2026-06-08) — `api/_lib/reddit-oauth.js`, `scripts/reddit-poster.js`. Awaiting `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from Heath. Once set in Vercel env + .env.local, run `node scripts/reddit-poster.js --test-mode` to verify.
- Cookie health monitor (2026-06-08) — `api/cron-cookie-health-check.js` runs 04:00 UTC daily. Table `public.session_health` (service_role RLS). Renew via `node scripts/renew-session.js --site=<name>`.
- Stealth on FB/IG/LinkedIn (2026-06-08) — `playwright-extra` + `puppeteer-extra-plugin-stealth` wrapped into `fb-group-poster.js`, `fb-group-commenter.js`, `instagram-engager.js`, `linkedin-engager.js`.

## Phase D (queue when stealth + Chrome profile hit ceiling)

- Residential proxy subscription — Smartproxy or Bright Data, $10-30/mo. Set per-script via `HTTP_PROXY` env var.
- 2Captcha integration — $5 seed; solves hCaptcha + reCAPTCHA when triggered. Add `TWOCAPTCHA_API_KEY` to env, wire into a `_lib/captcha-solver.js` helper.

Trigger Phase D when: scripts get a captcha challenge OR Facebook bot-detection rate exceeds ~10% even with stealth.
