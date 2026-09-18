@echo off
rem Windows Task Scheduler wrapper for the TC discovery comment loop.
rem Step 1: harvest new comments on Heath's OWN campaign posts (self-gates
rem cadence: every 45 min in the first 48h after a post, every 3 days after —
rem no-due-posts runs exit in ~2s without launching Chrome).
rem Step 2: watch threads where Heath commented on OTHER people's posts
rem (comment_watchlist) for replies to him — same cadence self-gating, same
rem Chrome-free fast exit when nothing is due.
rem Step 3: post any Heath-APPROVED replies threaded under their comments
rem (exits without launching Chrome when nothing is approved; respects the
rem facebook_reply 10/day budget and 30-min min-gap from
rem scripts\_lib\comment-caps.js). A locked DossieBot-Sage Chrome profile
rem is skipped quietly this tick and retried next tick -- never force-killed.
rem Added 2026-09-16 (Carter): every run also checks, via a pure DB read
rem before anything else, whether any approved reply has sat unposted >60
rem min (the 1-hour reply SLA) and alerts Heath on Telegram if so, deduped
rem to roughly once per hour while the condition persists
rem (checkApprovedReplyStale in fb-group-commenter.js).
rem Step 4: DAILY comment-opportunity hunt (self-gates to once/day; re-verifies
rem recent posted comments first — a removed comment halts the whole pipeline).
rem Step 5: post Heath-APPROVED comment opportunities — at most ONE per tick,
rem 'facebook_auto' 8/day budget, 45-60 min varied spacing, verify-by-re-render,
rem comment_watchlist registration. Exits in ~2s without Chrome when nothing is
rem approved, the spacing gap hasn't elapsed, or the pipeline is halted.
rem Step 6 (added 2026-09-09, Carter): post Heath-APPROVED daily 5-group
rem posts (group_posts pipeline='daily5') — at most ONE per tick,
rem 'facebook_group_post' 5/day budget (1 per target group), 18-24 min
rem varied spacing, shares Step 5's circuit breaker (one FB profile). Exits
rem in ~2s without Chrome when nothing is approved, the spacing gap hasn't
rem elapsed, or the pipeline is halted.
rem Step 7 (added 2026-09-09, Carter — Bug 3, docs/POSTING-ENGINE-PLAN-2026-09-09.md):
rem post Heath-APPROVED linkedin_personal posts (his own voice) — at most
rem ONE per calendar day (linkedinDailyCapReached() in linkedin-engager.js),
rem cooperative DossieBot profile unlock shared with Steps 1-6 above (waits
rem for FB steps to release the profile rather than colliding with them).
rem 18 posts were sitting approved with zero scheduled trigger anywhere
rem before this. Verified live 2026-09-09 (--dry-run): the DossieBot profile
rem (C:\Users\Heath\DossieBot, env PLAYWRIGHT_PROFILE_DIR) IS logged into
rem LinkedIn — logged_in:true, landed on /feed/, not /login. Exits in ~2s
rem without Chrome when the daily cap is already met or nothing is approved.
rem 2026-09-16 (Atlas): self-locates via %~dp0 instead of a hardcoded
rem C:\Users\Heath\Projects\MeetDossie literal, so this exact tracked file
rem works unmodified whether launched from the dev tree or the separate
rem MeetDossie-scheduler checkout (see docs/SCHEDULER-CHECKOUT.md).
cd /d "%~dp0.."
node scripts\harvest-tc-discovery-responses.js >> scripts\tc-discovery-harvest.log 2>&1
node scripts\watch-guest-thread-replies.js >> scripts\guest-thread-watch.log 2>&1
node scripts\fb-group-commenter.js --tc-reply-queue >> scripts\tc-reply-queue.log 2>&1
node scripts\fb-comment-hunt-daily.js >> scripts\comment-hunt.log 2>&1
node scripts\fb-comment-opp-poster.js >> scripts\comment-opp-poster.log 2>&1
node scripts\fb-group5-post-queue.js >> scripts\group5-post-queue.log 2>&1
node scripts\linkedin-engager.js --post-approved --warm-touch-only >> scripts\linkedin-post-approved.log 2>&1
rem Step 8 (added 2026-09-14, Sage): post Heath-APPROVED listing-group posts
rem (group_posts pipeline='listing-groups') -- at most ONE per tick,
rem 'facebook_group_post_listing' 3/day budget, 30-40 min varied spacing,
rem shares Steps 5-6's circuit breaker (one FB profile). First-cycle
rem approval from Heath received 2026-09-14 (Nopalito/Fawndale/Wild Cherry
rem group rows) -- see scripts/fb-listing-group-post-queue.js header.
rem Exits in ~2s without Chrome when nothing is approved, the spacing gap
rem hasn't elapsed, or the pipeline is halted.
node scripts\fb-listing-group-post-queue.js >> scripts\listing-group-post-queue.log 2>&1
rem Step 9 (added 2026-09-16, Carter): once/day live-MLS-read listing
rem marketing generation (scripts\listing-marketing-generate-live.js).
rem This is the ONLY safe generator for Heath's own listing posts --
rem api\cron-daily-listing-posts.js was disabled 2026-09-11 after it
rem advertised 23 Nopalito at a stale $1,195,000 while the live MLS price
rem was $999,000 (Vercel serverless can't hold a connectMLS session).
rem This script does a live connectMLS read AND generation in the same
rem process; self-gates to once/day via
rem scripts\.listing-marketing-live-state.json (a 15-30 min tick that
rem finds it already ran today exits in a couple seconds without
rem launching Chrome). If the live read fails or the connectMLS session
rem is dead, it generates ZERO posts and alerts Heath on Telegram --
rem it never falls back to a cached/stale DB snapshot.
node scripts\listing-marketing-generate-live.js >> scripts\listing-marketing-generate-live.log 2>&1
rem Step 10 (added 2026-09-16, Atlas): stale-scheduled-script drift check
rem (scripts\detect-scheduled-script-drift.js). Twice in one day a merged
rem fix did NOTHING because THIS machine's working tree was stale -- Task
rem Scheduler runs local files and nothing pulls `main` into them. This
rem step follows every scheduled task's real invocation graph (including
rem require()'d _lib files no .cmd/.ps1 ever names directly), compares the
rem local working-tree copy of each file against origin/main, and alerts
rem Heath on Telegram ONLY when a locally-CLEAN tracked file has diverged --
rem a file Heath is actively editing is reported differently (never
rem alerted, never touched). Cost per tick: one `git fetch origin main` +
rem two `git diff --name-only` calls (the schtasks enumeration itself is
rem cached 24h) -- no Chrome, no meaningful slowdown. Detect and report
rem only -- never checks out/stashes/resets anything. Dedupes like
rem api/_lib/silence-alarm.js (same alert_state table, 12h cooldown per
rem unresolved file set) and its latest result is also surfaced in the
rem daily heartbeat (api/cron-dossie-full-diagnostic.js) so a quiet drift
rem still shows up even if this Telegram alert is missed.
node scripts\detect-scheduled-script-drift.js >> scripts\stale-script-detector.log 2>&1
rem Step 11 (added 2026-09-17): the DAILY VIDEO SUPPLY LOOP
rem (scripts\daily-video-supply.js, via scripts\run-daily-video-supply.cmd).
rem On 2026-09-17 zero videos had posted in 24h with three working generators
rem on disk and a working publish path -- nothing was broken, nothing was
rem scheduled. This is the thing that fires them. It picks ONE format for the
rem day by starvation score against each format's remaining runway
rem (docs/CONTENT-FORMAT-LIBRARY.md §8.2), so no single format is drawn until
rem it starts repeating itself, renders it, runs the quality gate INCLUDING
rem the CTA-URL resolve check, and queues the result into video_library at
rem status='approved' for the normal Telegram approval flow. It publishes
rem NOTHING. Self-gates to once per calendar day via
rem scripts\.daily-video-supply-state.json, so 47 of every 48 ticks exit in
rem about a second without launching Chrome, ffmpeg or ElevenLabs. A day that
rem produces nothing alerts Heath on Telegram (deduped ~20h through the same
rem alert_state table as api\_lib\silence-alarm.js) rather than failing quietly
rem -- a silent zero is exactly what went unnoticed for 24 hours.
rem Runs through WSL: the composite half is python3 + ffmpeg/libass, which is
rem the proven toolchain there, not on Windows. See that .cmd's header.
call "%~dp0run-daily-video-supply.cmd" >> "%~dp0daily-video-supply.log" 2>&1
