@echo off
rem Windows Task Scheduler wrapper for the TC discovery comment loop.
rem Step 1: harvest new comments (self-gates cadence: every 45 min in the
rem first 48h after a post, every 3 days after — no-due-posts runs exit in
rem ~2s without launching Chrome).
rem Step 2: post any Heath-APPROVED replies threaded under their comments
rem (exits without launching Chrome when nothing is approved; respects the
rem FB 5/day cap and 45-min min-gap from scripts\_lib\comment-caps.js).
cd /d "C:\Users\Heath\Projects\MeetDossie"
node scripts\harvest-tc-discovery-responses.js >> scripts\tc-discovery-harvest.log 2>&1
node scripts\fb-group-commenter.js --tc-reply-queue >> scripts\tc-reply-queue.log 2>&1
