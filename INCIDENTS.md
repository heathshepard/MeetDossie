# Dossie Incident Log

Read this file at the start of every video render or pipeline session.

---

## 2026-05-27 -- Social pipeline flood + bad video day

### What broke
1. Two test runs of cron-generate-posts at 04:02 and 04:03 UTC created duplicate post batches. Both batches were sent for approval and approved, resulting in triple posts on Twitter and triple Facebook posts.
2. Creatomate template renders static image, not video. Screen recordings appear frozen.
3. Black frames (14s) at start of lifestyle video due to Pexels b-roll loading silently failing.
4. v2 trim fix cut audio opening -- voiceover started mid-sentence.
5. Internal note "PULLED - frozen screen recording" written into caption field -> posted publicly on Facebook.
6. Video approval messages never reached Heath because cron-post-videos used TELEGRAM_BOT_TOKEN (blank in Vercel) instead of TELEGRAM_MARKETING_BOT_TOKEN.
7. Desktop recording routed to TikTok and Instagram (wrong format -- portrait required).
8. DB caps (facebook=3, twitter=3) didn't match Sage's plan (2 each).

### Root causes
- No pre-post video QA: videos posted without anyone watching them first.
- Two separate posting pipelines (video_library + social_posts) had no coordination.
- Internal state written into public-facing fields (caption).
- Wrong Telegram bot token in video cron.
- No format enforcement: desktop files could be assigned to portrait-only platforms.

### Rules added
- NEVER use Creatomate for video -- ffmpeg pipeline only.
- NEVER trim to fix -- re-render from source.
- NEVER write notes in the caption field -- caption = what goes on social media.
- NEVER route desktop recordings to TikTok/Instagram.
- Before approving any video: watch it.
- Test runs must be flagged is_test=true and never enter the approval queue.

### Fixes applied
- TELEGRAM_MARKETING_BOT_TOKEN now used as primary in cron-post-videos.
- Caption safety guard added (blocks PULLED/do-not-repost captions).
- Platform format enforcement added to generate-lifestyle-video.py.
- DB caps corrected: facebook=2/day, twitter=2/day.
- Frame-by-frame visual description function added for voiceover sync.
