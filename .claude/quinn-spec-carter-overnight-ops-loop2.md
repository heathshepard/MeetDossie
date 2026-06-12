# Quinn → Carter, loop 2 on overnight-ops-fix

**Branch:** staging
**Tag in progress:** `GOLD-2026-06-12-v1-overnight-ops-fix` — DO NOT advance the tag until all three items below land.

Quinn ran the pre-merge gate on staging. Three items must be fixed before Heath approves merge to main.

---

## Item 1 — Marketplace classifier still passes the exact post Sage flagged

**File:** `scripts/sage-fb-comment-scanner.js` lines 96-116

**Acid-test text (the literal Bug 5 example from `Engineering/wall-log.md`):**
```
t and a 16 x 4 load bearing porch $26,900 · Belton, TX This is a 16 x 40 barn shed...
```

**Current behavior:** `isMarketplacePost()` returns `false`. Verified with a node repl. The classifier requires the post to contain `$` AND one of `MARKETPLACE_SIGNALS` (`for sale`, `for rent`, `asking price`, ` obo `, `best offer`, `just listed`, `just sold`, `property for`, `real estate for`, `$ per month`, `$ month`, `$ /month`, `$ annually`). The barn post has none of those phrases. Bug 5 says the actual FB Marketplace tell is the pattern `"$X,XXX · City, ST"` — that pattern is not in the signal list.

**Required fix:**

1. Add a regex check for the FB Marketplace price-location pattern. In `isMarketplacePost()`, before the signal loop, add:
   ```js
   // FB Marketplace listings render as "$26,900 · Belton, TX" — price followed by middot, city, state
   if (/\$\s?[\d,]+(?:\.\d+)?\s*·\s*[A-Za-z][A-Za-z .'-]+,\s*[A-Z]{2}\b/.test(text)) return true;
   ```
2. Expand the signal list with the keywords Sage already called out: `'barn'`, `'shed'`, `'porch'`, `'equipment'`, `'tractor'`, `'trailer'`, `'utv'`, `'atv'`, `'rv '`, `'sq ft lot'`, `'acres '`. These should trip the classifier WITH OR WITHOUT a dollar sign — the post can list a barn without a price and still be off-topic. Refactor: split into two categories:
   - `MARKETPLACE_PRICE_SIGNALS` — require `$` (current logic)
   - `OFF_TOPIC_OBJECT_KEYWORDS` — trip on keyword alone (barn, shed, porch, etc.)
3. Re-run the acid test in the file footer or a one-off node command. The Belton barn text MUST return `isMarketplace: true`.

**Verification (don't ship until this prints true):**
```bash
node -e "const f = require('./scripts/sage-fb-comment-scanner.js'); console.log(f.isMarketplacePost('t and a 16 x 4 load bearing porch \$26,900 · Belton, TX This is a 16 x 40 barn shed...'));"
```
(Export `isMarketplacePost` if not already exported. Or inline the function and test.)

---

## Item 2 — cron-mission-watchdog still has overnight cron gaps

**File:** `vercel.json` lines 373-380

**Current schedule:**
```
{ "path": "/api/cron-mission-watchdog", "schedule": "0 13-23 * * *" }
{ "path": "/api/cron-mission-watchdog", "schedule": "0 0,1 * * *" }
```

UTC 13-23 + 0-1 = 14 hours/day. The window from UTC 2-12 (9 PM CDT to 7 AM CDT) is DARK. The brief claimed "24/7" — that's the code gate. The cron itself still doesn't fire.

**Required fix:**

Replace the two entries above with ONE entry that fires hourly, 24/7:
```json
{ "path": "/api/cron-mission-watchdog", "schedule": "0 * * * *" }
```

Vercel Hobby limits hourly crons fine. If there is a Hobby-plan cron count constraint, collapse one of the existing less-critical hourly crons instead — but the watchdog must cover all 24 hours.

**Verification:** count `cron-mission-watchdog` entries in `vercel.json` — should be exactly 1, schedule `0 * * * *`.

---

## Item 3 — Telemetry (wall-log Bug 4) was skipped entirely

**Sage's Bug 4 in `Engineering/wall-log.md` lines 39-43:**
> Every cron wrapper should `INSERT INTO cron_runs (cron_name, last_run, last_status) ... ON CONFLICT (cron_name) DO UPDATE`. Small lib in `api/_lib/cron-telemetry.js`.

The brief Heath received listed 4 files. This 5th bug was dropped. `api/_lib/cron-telemetry.js` does not exist. `cron-mission-watchdog.js` has no `cron_runs` insert.

**Required fix:**

1. Create `api/_lib/cron-telemetry.js`. Export `recordCronRun(cronName, status, meta = {})` that hits the Supabase REST endpoint `/rest/v1/cron_runs?on_conflict=cron_name` with `Prefer: resolution=merge-duplicates,return=minimal`, payload:
   ```js
   {
     cron_name: cronName,
     last_run: new Date().toISOString(),
     last_status: status,          // 'ok' | 'error' | 'skipped'
     last_meta: meta,              // jsonb, free-form
   }
   ```
   Use `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` env vars. Same fetch pattern as the rest of `api/_lib/`. Fail-soft: swallow errors and console.log — telemetry must never break the actual cron.

2. Wire it into `api/cron-mission-watchdog.js` — call `recordCronRun('cron-mission-watchdog', 'ok' | 'error', { actions: actions.length })` at the very end of the handler, in both the success path and the catch. Same for the `outside-business-hours`-style skip paths if any remain.

3. Confirm the `cron_runs` table exists (`cron_name text primary key, last_run timestamptz, last_status text, last_meta jsonb`). If it doesn't, add a SQL migration block in `api/_lib/cron-telemetry.js` as a comment for Cole to run, and DO NOT block on the migration — the fail-soft fetch will simply log warnings until the table exists.

4. Also wire `recordCronRun` into `api/cron-send-to-sage.js`, `api/cron-engagement-veto-mode.js`, and `api/cron-publish-approved.js` — these are the ones that went dark last night. One-line call at end of handler.

**Verification:** After deploy, manually hit `/api/cron-mission-watchdog` with the `CRON_SECRET` bearer and confirm a new row appears in `cron_runs` for `cron-mission-watchdog`.

---

## When all three items land

1. Commit message: `GOLD-2026-06-12-overnight-ops-fix loop2 — marketplace regex, watchdog cron 24/7, cron_runs telemetry`
2. Push to staging.
3. Reply to Cole: "Carter loop 2 done — please re-run Quinn."

Quinn will re-acid-test the barn post, recount the vercel.json schedule, confirm the telemetry lib + watchdog wiring, and clear the merge gate.
