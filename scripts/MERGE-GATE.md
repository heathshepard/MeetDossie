# Pre-Merge Gate — Staging → Main

**Owner:** Atlas (infra) + Quinn (enforcement) + Cole (orchestration) + Heath (final approval)
**Shipped:** 2026-06-14 (Atlas)
**Status:** Live on `staging` branch
**Trigger:** Every push to `staging` before any merge to `main`

---

## Why this gate exists

On 2026-06-13 a duplicate `const wv` declaration in a React workspace bundle was committed to `main` and shipped to prod. The bundle JS threw at parse time, so `/app` was a white-screen for every customer for ~48 hours. Nothing in the pipeline caught it because:

1. Vercel's build succeeded (the bundle was a valid JS file; the parse error fired at runtime in the browser).
2. The existing Quinn suite (T01-T07) starts with login on `/app` — when login itself can't render, the test was never reaching the "is the bundle broken?" check; it was failing with confusing symptoms further down.
3. Ridge's customer-view digest (runs daily 6 AM CDT, captures `/`, `/app`, `/founding`, `/faq`, `/coordinators`) DID detect the break — but as a notifier, not a blocker. By the time the digest fired, the broken bundle was already live.

**The gate is now a hard block, not a notifier.** Every staging push runs `scripts/smoke-app-pages.js` against the live staging URL. If ANY of the 5 customer-visible pages console-errors or renders blank, the merge to `main` is held until it's fixed.

---

## The flow

```
1. Carter pushes to staging branch (Vercel auto-deploys preview)
2. Cole spawns Quinn
3. Quinn runs T00 — node scripts/smoke-app-pages.js https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app
4a. T00 FAIL → Quinn pastes failure detail to Heath, spawns Carter to fix, loops back to step 1
4b. T00 PASS → Quinn runs T01-T07 (the existing functional suite)
5a. Any T01-T07 FAIL → Carter fixes, loop
5b. All PASS → Quinn reports "All clear" to Heath
6. Heath sends "merge it" → Cole merges staging → main
```

Quinn never auto-merges. Heath is the final gate. (See `feedback_heath_final_approval_required.md`.)

---

## T00 — The smoke check

```bash
node scripts/smoke-app-pages.js <BASE_URL>
```

Loads in headless Chromium:
- `/` (homepage)
- `/app` (workspace — load is the canary for React bundle integrity)
- `/founding` (signup landing)
- `/faq`
- `/coordinators`

For each page it captures:
- HTTP status (nav response)
- `console.error` messages (with 3rd-party noise filtered: GA, gtag, favicon, chrome-extension)
- Uncaught `pageerror` events (React/JS runtime exceptions)
- Visible interactive content count (`main`, `h1`, `h2`, `button`, `a[href]`, `[role=main|banner|heading|button]`)
- A PNG screenshot to `.tmp-smoke/run-<timestamp>/<slug>.png`

**Exit 0** = all 5 pages cleanly rendered. Safe to proceed with functional QA.
**Exit 1** = at least one page is broken. Block merge.

The script writes a `summary.json` per run with the full result detail and console error transcripts so Carter can diagnose without re-running.

---

## Failure example

The 2026-06-13 broken `wv` bundle would have produced output like:

```
[smoke] /app             FAIL (pageerror: 1)

[smoke] FAILURE DETAIL:
  https://meet-dossie-git-staging-...vercel.app/app
    pageerror: SyntaxError: Identifier 'wv' has already been declared
    screenshot: .tmp-smoke/run-2026-06-13T.../app.png
```

That single line would have held the merge. Heath would have seen "Hold merge" on Telegram instead of finding the bug himself 48 hours later in production.

---

## Constraints

- The smoke script uses headless Chromium (Playwright) — no signed-in session. It can't catch bugs that only appear post-login. Those still need T01-T07.
- The smoke script trusts `domcontentloaded` + a 1.5s post-load wait to give SPA hydration enough time to throw uncaught exceptions. If a bundle bug is timer-delayed beyond 1.5s, the gate may pass — but that's exotic. The common case (parse error at script load, throw during hydration) is caught.
- The script does NOT modify Ridge's customer-view digest. Ridge stays as the daily safety net for stuff that slipped past the gate (and as the historical archive for visual regression).
- The script touches NO API routes, NO database, NO secrets. Pure read-side check.

---

## Where it's wired

- `.claude/agents/quinn.md` — T00 added as the FIRST mandatory step before T01-T07. Quinn cannot skip it.
- `scripts/smoke-app-pages.js` — the script itself.
- `scripts/MERGE-GATE.md` — this doc.
- `scripts/FILL-VERIFY-LOOP.md` — cross-reference for contract-fill-specific QA (orthogonal but parallel — both gates must pass for any contract-fill ship).
- `.gitignore` — `.tmp-smoke/` ignored (per-run screenshots + summary are local-only).

---

## Files

- `scripts/smoke-app-pages.js` — the gate (Playwright-based, runs on any BASE_URL arg)
- `scripts/MERGE-GATE.md` — this runbook

## See also

- `.claude/agents/quinn.md` — Quinn's test suite (T00 is the new first step)
- `Shepard-Ventures/Engineering/INDEX.md` — `SV-MERGE-GATE-2026-06-14` work stream
- 2026-06-13 incident: broken `const wv` bundle on prod for ~48h (Ridge digest caught it as notifier, not blocker)

---

**Last updated:** 2026-06-14 (Atlas), shipped on `staging` branch.
