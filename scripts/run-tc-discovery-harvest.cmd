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
cd /d "C:\Users\Heath\Projects\MeetDossie"
node scripts\harvest-tc-discovery-responses.js >> scripts\tc-discovery-harvest.log 2>&1
node scripts\watch-guest-thread-replies.js >> scripts\guest-thread-watch.log 2>&1
node scripts\fb-group-commenter.js --tc-reply-queue >> scripts\tc-reply-queue.log 2>&1
