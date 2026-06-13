# Carter spec — Zernio post_id capture regression (2026-06-12)

## Context

Sage diagnosed the 10:14 PM CDT watchdog "0/4" false positive. Posts ARE shipping today (FB 3, IG 3, LI 2, TW 4) but every row has `zernio_post_id=NULL` so the watchdog's verification check reads zero. Last successfully captured zernio_post_id was **2026-06-06 14:01 UTC** — Zernio's API response shape has regressed since then.

## Root cause

`api/cron-publish-approved.js` lines 365-385 try every documented Zernio response shape (`data.id`, `data.post_id`, `data.data.id`, `data.posts[0].id`, etc.) and none match. So `zernioPostId = null` and the row gets `error_message='Zernio returned 2xx but no post_id — unverified survival'` (though some recent rows have NULL error_message — see Bug 2 below).

This trips the watchdog filter `zernio_post_id=not.is.null` (`api/cron-mission-watchdog.js` line 136), making every actually-posted row invisible to pace tracking.

## What Carter needs to do

### 1. Probe the actual current Zernio response shape

Use the most recent failing rows as evidence. Pull console logs from Vercel for `[zernio-response]` log lines emitted within the last 24 hours — every line includes the literal response body (truncated to 500 chars). That tells us what field Zernio is now returning the ID under.

If Vercel logs don't surface the body (depends on retention), fire a manual test post via `cron-publish-approved` after staging an approved row, and capture the response in a fresh log.

### 2. Update the extraction in `cron-publish-approved.js` (line ~375)

Add the new shape(s) to the fallback chain. Do NOT remove the existing fallbacks — Zernio's prior shapes may still appear for some endpoints. Append, don't replace.

### 3. Backfill recent rows (optional but useful)

If we can extract the post_id from logged response bodies for the last 12 posts, PATCH them so the watchdog sees them as verified. If we can't, skip — not worth it.

### 4. Fix Bug 2 — inconsistent unverified flagging

The 3 most recent posts today (17:45 UTC FB, 17:45 UTC TW, 23:45 UTC IG) have `zernio_post_id=NULL` AND `error_message=NULL`. They should have the "unverified survival" error_message per the code at line 826. Possible cause: result.ok=true and result.unverified is false but result.zernio_post_id is also null — unlikely but worth checking. Trace why the unverified flag didn't fire on these specific rows.

### 5. Validate

- After fix deploys, manually fire `cron-publish-approved` against a test approved row OR wait for the next scheduled cron
- Confirm new row has `zernio_post_id` populated
- Confirm watchdog at next hourly run reports correct ship counts

## Acceptance criteria

- New posts have `zernio_post_id` captured and stored on the row
- Watchdog end-of-day report at 8 PM CDT shows actual ship counts not zeros
- No double-posting (do not re-fire posts that already have status=posted)
- Commit message format: `SV-ENG-ZERNIO-POSTID-REGEN: re-establish post_id capture after 2026-06-06 Zernio shape drift`

## What NOT to do

- Do not change the watchdog's verification logic (that's the right contract — we just need real post_ids)
- Do not re-fire today's posts thinking they failed — they shipped, just unverified
- Do not change cap math or posting_schedule — those are correct
- Do not silently drop the unverified-survival flag — the safety net stays

## Files

- `api/cron-publish-approved.js` (line 365-396) — extraction
- `api/cron-publish-approved.js` (line 810-828) — patch logic / unverified flag
- `api/cron-mission-watchdog.js` (line 129-142) — verification reader (do not touch)

## Sage will

- Take Carter's report and confirm via watchdog's next 8 PM digest that ship counts are accurate
- File a memory entry naming the new Zernio response shape so this doesn't happen again
