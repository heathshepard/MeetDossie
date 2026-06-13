# Sage spec for Carter — FB first-comments V2 blitz: missing driver + phantom targets

**Owner:** Sage (Social) | **Implementer:** Carter | **Branch:** staging
**Date:** 2026-06-12
**Severity:** medium-high — every V2 blitz run since deploy has silently failed all 6 targets. Wall-log Bug 8 has full root cause.

---

## Two-bug compound failure

### Bug A — Driver script does not exist

`scripts/atlas-fb-first-comments-blitz-v2.js` line 65:

```javascript
const PY_DRIVER = path.join(__dirname, 'atlas-fb-first-comment-v2.py');
```

This file is not on disk. Confirmed via `Get-ChildItem scripts -Filter "atlas-fb-*"`:

```
atlas-fb-blitz-pyautogui.js
atlas-fb-comment-pyautogui.py        ← author-search comment driver, NOT first-comment-on-our-own-post
atlas-fb-first-comments-blitz-v2.js  ← the broken caller
atlas-fb-post-pyautogui.py           ← top-level post driver
```

Every `spawn('python', [PY_DRIVER, ...])` exits non-zero immediately, stdout is empty, no `ATLAS_RESULT_JSON:` line is emitted, the JS parses `result = null`, outcome falls through to literal string `'unknown'`. The summary.json from 2026-06-12 10:01 UTC run confirms: 4 of 6 targets report `outcome: "unknown"` with no `runDir` field. There is no driver. There never was. The 2/6 "live" targets in the same run are `already_posted` rows from a prior fb-group-poster pass — the V2 blitz didn't post them either.

### Bug B — Blitz blindly queues phantom targets

The 6 hardcoded `POSTS` in the V2 blitz include 4 rows whose parent main posts never went live on Facebook:

| post_id | group | main post status |
|---|---|---|
| fc1762df | Texas Real Estate Agents | `pending_admin_approval` |
| 37faa0aa | Texas Real Estate Network | `blocked_group_rules` |
| b9add267 | All about Real Estate Houston | `failed` |
| b4aa1c2f | Realtors San Antonio Boerne | `failed` |
| d078e368 | Dallas Texas Realtors | `posted` (FC already shipped) |
| d68ce2f6 | Texas Hill Country Real Estate | `posted` (FC already shipped) |

Even if the python driver existed, the 4 failing rows could never succeed — there is no Facebook post to comment under. The blitz has no preflight DB check on `status` or `posted_at`. It tries to comment on rows that exist only in the database, not on Facebook.

## Required fixes — `scripts/atlas-fb-first-comments-blitz-v2.js` + new driver

### Fix 1 — Preflight DB check before driver spawn

In the loop body (around line 187), AFTER the `already_posted` short-circuit and BEFORE `runDriver`, add:

```javascript
// Sage rule (2026-06-12 wall-log Bug 8): never spawn a comment driver on a
// row whose parent main post never went live. Skip-and-log structurally.
if (row.status !== 'posted' || !row.posted_at) {
  console.log(`[atlas-comments-v2] parent not live (status=${row.status}, posted_at=${row.posted_at}) - skipping`);
  results.push({
    ...item,
    groupName: row.group_name,
    outcome: 'skip_parent_not_live',
    parent_status: row.status,
  });
  continue;
}
```

The summary should then count `skip_parent_not_live` as a structural skip, not a failure. Telegram message should report `Live: X/N, Skipped (parent not live): Y, Failed: Z`.

### Fix 2 — Logging: replace `'unknown'` with diagnostic outcome codes

When the python driver returns no `ATLAS_RESULT_JSON:` line, change line 233 from:

```javascript
results.push({ ...item, groupName: row.group_name, outcome: outcome || 'unknown', runDir });
```

to:

```javascript
const finalOutcome = outcome
  || (driverRes.exitCode === null ? 'driver_no_result'
    : driverRes.exitCode === 0 ? 'driver_silent_success'
    : `driver_exit_${driverRes.exitCode}`);
results.push({
  ...item,
  groupName: row.group_name,
  outcome: finalOutcome,
  runDir,
  exitCode: driverRes.exitCode,
  stderr_tail: (driverRes.stderr || '').slice(-500),
});
```

Per Heath's mandate, `unknown` is itself a bug — every failure must self-explain. With this change, a missing driver would show `outcome: "driver_exit_2"` and the stderr tail "can't open file …atlas-fb-first-comment-v2.py" so the next person knows immediately.

### Fix 3 — Build the real `atlas-fb-first-comment-v2.py` driver

The right architecture: comment on **Dossie's own most recent post in the group**, not on someone else's post by needle/author search. `atlas-fb-comment-pyautogui.py` is the wrong template (it searches by needle + `--author`).

Required arg signature:

```
python scripts/atlas-fb-first-comment-v2.py \
  --group-url https://www.facebook.com/groups/<slug>/ \
  --post-permalink https://www.facebook.com/groups/<slug>/posts/<id> \
  --comment-file <abs path to comment body> \
  --label <slug-for-run-dir> \
  --post-id <uuid> [optional, for run-dir naming]
```

Logic:

1. Activate Heath's main Chrome window.
2. If `--post-permalink` is provided, navigate directly to it (this opens the post in a focused view where the comment composer is the only contenteditable). Prefer this path — it sidesteps the "first contenteditable is the new-post composer" trap that breaks `scripts/post-first-comments.js`.
3. If only `--group-url` is given (fallback), navigate to the group, scroll to find Dossie's most recent post (look for our profile name on the most recent article), click the post's timestamp/header to open it in focused view, then comment.
4. Reuse the UIA helpers, clipboard-paste pattern, popup dismissal, and outcome-code vocabulary from `atlas-fb-comment-pyautogui.py`. Emit `ATLAS_RESULT_JSON:{"outcome":"posted","run_dir":"..."}` on the final stdout line so the blitz JS parser matches.
5. Outcome codes: `posted`, `composer_unclickable`, `paste_failed`, `submit_failed`, `comment_button_missing`, `permalink_404`, `dossie_post_not_found`, `chrome_missing`.
6. Take screenshots at every step into `scripts/atlas-runs/fb-first-comment-<label>-<ts>/` matching the existing pattern.

### Fix 4 — Wire blitz JS to pass `--post-permalink`

The `group_posts` table has `post_url` (the permalink captured by `fb-group-poster.js` after it ships the main body). The blitz already fetches the row at line 185. Add to the `runDriver` call:

```javascript
let driverRes = await runDriver({
  groupUrl: row.group_url,
  postPermalink: row.post_url, // ← new
  needle: item.needle,         // keep as fallback
  commentBody,
  postId: item.id,
  label: item.label,
});
```

And in `runDriver`, pass `--post-permalink row.post_url` to the python args when present. If `post_url === row.group_url` (the `fb-group-poster.js` fallback case at lines 505-507), warn and fall back to needle-based search.

## Backfill — recover the genuine missing first-comment

After deploy:

- `e0c0b233-6faa-426b-930b-332d9417b113` (Dallas Texas Realtors) has `status='posted'`, `posted_at=2026-06-11 15:01 UTC`, `first_comment_body` populated, `first_comment_posted_at=null`. This is a real recoverable case the V2 blitz never targeted (it's not in the hardcoded POSTS array). Run the new driver once against this row to ship the missed first-comment.

- The 4 phantom rows (fc1762df, 37faa0aa, b9add267, b4aa1c2f) have been sealed by Sage on 2026-06-12 15:09 UTC: `failure_reason` annotated, `first_comment_posted_at = NOW()` to lock them out of future blitz retries. Do not re-attempt.

## QA gate — Sage will verify

After Carter pushes to staging:
1. Sage runs the V2 blitz with the 6-row hardcoded array. Expected: 2 `already_posted` + 4 `skip_parent_not_live`. ZERO `unknown`. ZERO `driver_no_result`.
2. Sage runs the new driver standalone against `e0c0b233`. Expected: `posted` outcome, screenshots saved, `first_comment_posted_at` updated in DB.
3. Sage signs off; Quinn runs her gate; Heath merges to main.

Report SHA + summary.json from both runs to Cole.
