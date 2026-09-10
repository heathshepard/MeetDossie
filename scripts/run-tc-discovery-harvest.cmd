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
rem scripts\_lib\comment-caps.js).
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
cd /d "C:\Users\Heath\Projects\MeetDossie"
node scripts\harvest-tc-discovery-responses.js >> scripts\tc-discovery-harvest.log 2>&1
node scripts\watch-guest-thread-replies.js >> scripts\guest-thread-watch.log 2>&1
node scripts\fb-group-commenter.js --tc-reply-queue >> scripts\tc-reply-queue.log 2>&1
node scripts\fb-comment-hunt-daily.js >> scripts\comment-hunt.log 2>&1
node scripts\fb-comment-opp-poster.js >> scripts\comment-opp-poster.log 2>&1
node scripts\fb-group5-post-queue.js >> scripts\group5-post-queue.log 2>&1
node scripts\linkedin-engager.js --post-approved --warm-touch-only >> scripts\linkedin-post-approved.log 2>&1
