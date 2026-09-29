# Handoff — 2026-09-28, trigger: auto

## Active Task
Permanently fix Gmail OAuth so Claude Code can read and send from Heath's KW mailbox (heath.shepard@kw.com) without weekly breakage.

Root cause found: the `GOOGLE_INTERNAL_*` env vars were never set in Vercel, and the OAuth consent screen on Google Cloud project `134269376279` was left in **Testing** mode — which expires refresh tokens every 7 days. Symptom was `invalid_grant` on every refresh; tokens dated the 19th and the 26th were both dead. Reconnecting in Dossie Settings could never fix it because it just mints another unrefreshable token. The same missing vars break Jarvis sign-in, Gmail read, and Gmail send.

Work completed via a Chrome extension session signed in as heath.shepard@gmail.com (the account that owns the Cloud project):
- heath.shepard@kw.com granted **Owner** on project 134269376279 ("Policy updated"); role shows greyed out — invite pending, Heath must accept it in his KW inbox.
- Consent screen moved from Testing to **In production**. App stays **External** ("Make internal" greyed out — gmail.com-owned project has no Workspace org). Google now shows a verification-required banner; not submitted, so expect an "unverified app" warning and a 100-user cap. Branding page was filled in to allow publishing (home `https://meetdossie.com`, privacy `/privacy`, terms `/terms`).
- Six scopes added and confirmed after reload: `openid`, `email`, `calendar.readonly`, `gmail.readonly`, `gmail.send`, `gmail.compose`. Gmail API and Calendar API were already enabled.
- OAuth client "Dossie Internal (Heath)" created (web app), redirect URI `https://meetdossie.com/api/google-oauth-callback`. Client ID: `134269376279-d8nblf3ge47rjd34fk0c10rvqa06qp6k.apps.googleusercontent.com`
- `GOOGLE_INTERNAL_CLIENT_ID` and `GOOGLE_INTERNAL_OAUTH_REDIRECT_URI` added to the meet-dossie Vercel project (Production + Preview) via CLI from this session.
- `GOOGLE_INTERNAL_CLIENT_SECRET` saved by Heath as a Sensitive var for Production + Preview; Vercel confirmed "Added Environment Variable successfully."

Not yet done: **redeploy** — Vercel won't pick up the new vars until then.

## Decisions Made
- Publishing the consent screen out of Testing is the "forever" fix for the 7-day refresh-token expiry; app stays External, which is acceptable.
- Existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` are a separate customer-facing client and must not be touched.
- Heath types the client secret himself; never read, echoed, logged, or screenshotted.
- Only the KW mailbox needs connecting — all stored Gmail connections are for heath.shepard@kw.com. The personal gmail matters only because it owns the Cloud project. No separate KW-window work needed.
- Subscription cuts identified (from the 2026-09-09 sweep, gmail account only): cancel **HCTI ($168/yr)** — renders static social cards, obsolete since the video-only decision. Also flagged: Xbox Game Pass + PS Plus ($362/yr), Microsoft 365 + Google One duplicate storage ($100/yr), DroneMobile ($128/yr), Prime Video Ultra ($60/yr). ~$818/yr cuttable vs DocuSeal Pro at ~$240/yr + ~$24 in per-doc fees.
- Account sprawl flagged as a real risk, not a tidiness issue: KW owns heath.shepard@kw.com, so Dossie infrastructure authenticated through it is lost if Heath leaves the brokerage. Target end state is Dossie infra on heath@meetdossie.com. Not a today job; agreed to do it before ~50 subscribers.

## What's Next
1. Redeploy meet-dossie so the three new env vars take effect, then verify the OAuth endpoint returns 200 instead of 503.
2. Heath reconnects once in Dossie Settings, consenting with his **KW** Google account (click through Advanced → Continue on the unverified-app warning). Confirm read AND send both work.
3. Heath accepts the pending Owner invite for heath.shepard@kw.com in his KW inbox.
4. Once Gmail is back: run the subscription sweep across all three addresses (gmail, kw.com, meetdossie.com) — Zernio, Submagic, Creatomate, Pexels, fal.ai, Shotstack, Resend, Hiscox and realtor dues have never been reviewed.
5. Cancel HCTI and pick one duplicate to cut; stand up DocuSeal against the savings.
6. Offered but not started: an inventory of every service, which account owns it, and what breaks if that account goes away.
7. Robocall issue (separate thread): register at donotcall.gov, keep a call log (date/time/number). Next call — get company name, callback number, address, and rep name before hanging up; without an identity nothing is enforceable. Then file at fcc.gov/complaints, reportfraud.ftc.gov, and Texas AG. TCPA is $500/call, up to $1,500 if willful; calling after a stop request is willful. Josh Sisam can refer an attorney for a demand letter.
