@echo off
rem scripts/run-linkedin-social.cmd
rem
rem LinkedIn posting, on a HUMAN cadence. Split out of
rem scripts\run-tc-discovery-harvest.cmd on 2026-09-25 (Atlas).
rem
rem OLD: ran as Step 7 of the harvest chain, every 15 minutes = 96 runs/day.
rem      linkedin-engager.js launches Chrome BEFORE checking for work, so with
rem      one permanently-stuck approved post it loaded linkedin.com/feed/ on
rem      every one of those ticks and bounced to /login every time.
rem NEW: 3 runs/day, driven by "Dossie LinkedIn Social" in Task Scheduler with
rem      a PT90M RandomDelay on each trigger, so the actual fire times move by
rem      up to 90 minutes and never repeat a pattern.
rem
rem Throughput is UNCHANGED: linkedinDailyCapReached() has always capped this
rem channel at ONE post per calendar day. 3 opportunities/day still clears a
rem cap of 1. The other 93 daily runs were pure waste even when healthy.
rem
rem --warm-touch-only keeps the search/like/comment engagement loop off; this
rem invocation only publishes already-approved posts. Session keep-alive is a
rem separate concern and lives in scripts\session-keepalive-gentle.js.
rem
rem Self-locates via %~dp0 so the same tracked file works from the dev tree or
rem the separate MeetDossie-scheduler checkout.
cd /d "%~dp0.."
node scripts\linkedin-engager.js --post-approved --warm-touch-only >> scripts\linkedin-post-approved.log 2>&1
