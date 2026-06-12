# Engineering Wall Log

Append-only log of structural bugs / walls hit by the autonomous pipeline.
Each entry: date, finding, evidence, recommended fix, who owns it.

---

## 2026-06-12 — Overnight social pipeline went dark; 3 structural bugs found

**Filed by:** Sage (morning audit, 07:00 CDT)

### Bug 1: cron-mission-watchdog refuses to run outside 8 AM-8 PM CDT

- **File:** `api/cron-mission-watchdog.js` lines 61-62, 312-314
- **Code:** `BUSINESS_START_HOUR_CDT = 8`, watchdog `return` early if `hour < 8` or `hour > 20`.
- **Symptom:** Overnight gaps (midnight-8 AM CDT) go completely unmonitored. No route-around. The mission-completion rule explicitly says "watchdog routes around every wall" — this bug means it routes around nothing for ~12 hours/day.
- **Evidence:** Manual hit at 07:10 CDT returned `{"ok":true,"skipped":"outside-business-hours","hour":7}`. This is BEFORE the 8-9 AM CDT Texas RE morning window — the highest-engagement slot of the day.
- **Fix:** Expand window to `5 AM-11 PM CDT` so the morning content window (7-9 AM) is covered. Or, better: remove the gate entirely and let watchdog run every hour; let internal heuristics decide whether to alert.
- **Owner:** Carter

### Bug 2: cron-send-to-sage hard cap of 12, runs once/day, oldest-first ordering strands new posts behind backlog

- **File:** `api/cron-send-to-sage.js` line 18 (`MAX_PER_RUN = 12`), line 50 (`order=created_at.asc&limit=12`)
- **Schedule:** `30 11 * * *` — runs once daily at 11:30 UTC (6:30 AM CDT)
- **Symptom:** At 11:30 UTC, the older overnight tutorial-reel video drafts (created 02:00-02:06 UTC, video_required=true) consumed the 12-slot cap. The fresh 11:01 UTC batch of TEXT posts (the morning-window content) was stranded with telegram_sent_at=null. They never reached the approval queue. cron-publish-approved had nothing fresh to ship.
- **Evidence:** 21 social_posts created since 2026-06-12 00:00 UTC. 11 had telegram_sent_at set (all video_required=true tutorial-reel posts from 02:00 UTC). The 6 text-only morning posts (created 11:01 UTC, video_required=false, content-verifier verdict='approve') had telegram_sent_at=null at 12:00 UTC.
- **Fix:** (a) raise MAX_PER_RUN to 25, (b) reorder by created_at DESC (newest first) so morning batch ships even if backlog exists, or (c) split into two queries: text posts (priority, no cap on video) and video posts (capped). Option (c) is cleanest.
- **Owner:** Carter

### Bug 3: cron-engagement-veto-mode skips overnight by design (`*/30 13-23 * * *`)

- **File:** `vercel.json` line 370-371
- **Schedule:** Every 30 min, 13-23 UTC = 8 AM-6 PM CDT only.
- **Symptom:** No FB/IG/LinkedIn comment auto-drafting between 11 PM CDT and 8 AM CDT. Overnight veto-mode quota = 0 by design.
- **Evidence:** Heath saw only 1 veto comment in DossieMarketingBot overnight (id=52, the off-target Dallas barn post drafted at 10:02 UTC = 5:02 AM CDT). Veto mode didn't fire again until manual trigger.
- **Fix:** Extend to `*/30 11-2 * * *` so it covers 6 AM-9 PM CDT. The 9 PM-6 AM gap is intentional (real humans don't comment at 3 AM), but morning needs coverage from 6 AM forward.
- **Owner:** Carter

### Bug 4 (collateral): cron-mission-watchdog never inserts rows into `cron_runs` for telemetry

- **Symptom:** `SELECT * FROM cron_runs` returns 0 rows. We have no centralized job-execution telemetry. Forced this audit to use heuristics (telegram_sent_at timestamps) instead of canonical run history.
- **Fix:** Every cron wrapper should `INSERT INTO cron_runs (cron_name, last_run, last_status) ... ON CONFLICT (cron_name) DO UPDATE`. Small lib in `api/_lib/cron-telemetry.js`.
- **Owner:** Carter

### Bug 5: cron-engagement-veto-mode drafted a comment on a Facebook MARKETPLACE listing (barn shed in Belton TX) targeting "groups/dallasrealtors"

- **Symptom:** Engagement candidate id=52 surfaced a marketplace listing as a TC pain conversation. Comment draft started with "Man, this is the real struggle. I was doing spreadsheets..." — completely off-topic to a barn listing. Would have looked like bot spam. Killed by Sage at 12:06 UTC.
- **Evidence:** `engagement_candidates.id=52`, post_text begins "16 x 40 load bearing porch $26,900 · Belton, TX This is a 16 x 40 barn shape roof..."
- **Root cause hypothesis:** The relevance scorer is matching on "deals/transaction/pipeline" keywords inside marketplace post bodies that happen to contain those words generically. Need a post-classifier that rejects FB Marketplace and FB Sale-type posts BEFORE drafting a comment.
- **Fix:** Add a classifier step in the scanner: reject candidates where post_text contains marketplace signals ("$X,XXX · City, ST", "for sale", "asking", barn/shed/equipment keywords) regardless of relevance score. Or check FB post type metadata if exposed.
- **Owner:** Carter (filter logic) + Sage (keyword blocklist curation)

---

### Bug 6 (CRITICAL — entire engagement_candidates→posted flow has been architecturally broken): scanner produces non-navigable post_url for ~96% of FB candidates

**Filed by:** Sage (day-of mission audit, 08:35 CDT 2026-06-12)

- **File:** `scripts/sage-fb-comment-scanner.js` lines 263-273
- **Root cause:** `PERMALINK_RX` matches `/groups/<slug>/permalink/<digits>` or `/groups/<slug>/posts/<digits>` or `story.php?...` — none of which appear in the chunked text the scanner extracts from m.facebook.com group feeds. When no permalink is extracted, the scanner synthesizes `groupURL#post-<hash>`. The fragment is a dedup key only; FB does NOT render the specific post at that fragment.
- **Evidence:** 50 of 52 FB engagement_candidates have synthetic `#post-<hash>` URLs. ZERO have real permalinks. Two are status='approved' (id=29 from 2026-06-11 21:34 UTC, id=44 from 2026-06-12 10:02 UTC) — never posted because no shipper can locate the target post from the URL.
- **Symptom:** **The entire FB engagement-comment shipping flow has never worked.** Every approved candidate has been unshippable since the scanner shipped. The mission's "25 FB comments today" target is unreachable through this flow until the scanner extracts real permalinks.
- **Today's mitigation built:** `scripts/sage-engagement-poster.js` (Sage, 2026-06-12) — Playwright + DossieBot-Sage profile + per-platform comment-box locator. Validated via dry-run on id=44 (browser launches, navigates, types). Will ship once scanner produces real permalinks (or via the platform pivots below).
- **Fix paths:**
  - **A (preferred):** Update `sage-fb-comment-scanner.js` to follow each chunk's "View full post" / timestamp anchor link inside the rendered page and capture the canonical permalink. m.facebook.com renders each story with a `<a href="/groups/.../permalink/...">` wrapping the timestamp.
  - **B (interim):** Write `null` to post_url when no permalink. Phase-2 enrichment job revisits pending candidates, finds matching post by content-hash, captures the canonical permalink.
  - **C (today's pivot, in flight):** Skip FB engagement-candidate auto-shipping. Pivot today's "25 FB comments" target to two working paths:
      - Reddit comments via `scripts/reddit-comment-playwright.js` (takes direct post URL, works today)
      - LinkedIn comments via `linkedin-engager.js` (manual or scripted; URLs are real)
      - FB replies to comments on Dossie's own posts via `fb-reply-poster.js` (URLs are real; we own the parent post)
- **Owner:** Carter (Path A scanner fix — high priority for tomorrow) + Sage (today's Path C pivot)

---

### Bug 7: cron-publish-approved blocks TikTok posts even when media_url is already attached

**Filed by:** Sage (day-of mission audit, 09:30 CDT 2026-06-12)

- **File:** `api/cron-publish-approved.js` lines 708-730
- **Code:**
  ```javascript
  if (post.platform === 'tiktok') {
    // ... patches status='pending_video' UNCONDITIONALLY
    continue;
  }
  ```
- **Symptom:** Three TikTok social_posts (id=55ef1523, id=8c4fa6ce, id=c2218ade) sit at status='approved' with `media_url` pointing to a valid Supabase storage URL for a real reel video. Publisher checks `platform === 'tiktok'` BEFORE checking `media_url` and parks them as `pending_video` regardless. They never publish via cron-publish-approved; they're only eligible for the separate cron-post-videos pipeline (which is heath_approved-gated through video_library).
- **Fix:** Change to `if (post.platform === 'tiktok' && !post.media_url)`. When TikTok rows already have a video attached (the Sage reel-build path), let the normal Zernio publish flow handle them. Removes the dependency on Heath manually re-approving each one through the video_library gate.
- **Workaround for today:** None without a code change + deploy. The 19:00 CDT TikTok mandatory slot will require cron-post-videos to ship a heath_approved video from video_library — but no video_library rows have `tiktok` in their platforms array. So today's TikTok slot is effectively un-shippable through the autonomous pipeline.
- **Owner:** Carter (gate fix) + Sage (interim: schedule a heath_approved video for TikTok via video_library tomorrow)

---
