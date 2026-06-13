# Carter Spec — Post Analytics Feedback Loop + Zernio Delivery Verification

**Author:** Sage
**Date:** 2026-06-12
**Priority:** CRITICAL (currently flying blind on whether posts ship at all)
**Linked audit:** `C:\Users\Heath Shepard\Desktop\Shepard-Ventures\Engineering\sage-engagement-audit-2026-06-12\REPORT.md`

---

## Why this build matters

Sage's 2026-06-12 audit confirmed:

- `social_posts` table marks rows `status='posted'` even when Zernio returns 2xx without a `post_id`
- 5 rows have explicit `error_message: "Zernio returned 2xx but no post_id — unverified survival"`
- Twitter: 17 of 20 "posted" rows in last 7 days have NO `zernio_post_id`
- Facebook: 11 of 14 same
- Instagram: 9 of 9 same (but posts ARE visible via Google index — Zernio just isn't capturing the ID)
- TikTok: 22 posts stuck in `pending_video`, ZERO ever shipped via this pipeline

We have no data on engagement (reach, likes, comments, shares) because there's no analytics pull. CLAUDE.md §33 lists `post_analytics` as tech debt #3.

## What to build

### Phase 1 — Delivery verification (URGENT, do first)

**Endpoint:** `api/cron-verify-zernio-deliveries.js`
- Runs every 30 minutes via Vercel cron
- Queries `social_posts` where `status='posted'` AND `posted_at > NOW() - INTERVAL '2 hours'` AND `zernio_post_id IS NULL`
- For each row, calls Zernio's GET `/posts/:scheduledPostId` or equivalent endpoint to fetch the actual delivery status + post_id
- If Zernio returns a confirmed post_id → update row with `zernio_post_id`, `external_url`, `delivery_verified_at`
- If Zernio returns "not delivered" or 404 → flip `status` to `'failed'` + populate `error_message` with the platform reason
- If Zernio returns "still processing" → leave alone, will recheck next cron

**Acceptance:**
- After 2 cron runs, every `posted` row in last 4 hours has either a verified `zernio_post_id` OR has been flipped to `failed`
- Telegram alert to chat_id 7874782923 if `failed` rate exceeds 30% in a 24h window (delivery is broken)

### Phase 2 — Engagement pull (analytics feedback loop)

**Endpoint:** `api/cron-pull-post-analytics.js`
- Runs daily at 6 AM UTC
- Pulls last 7 days of `social_posts` where `zernio_post_id IS NOT NULL`
- For each, queries Zernio's analytics endpoint (per platform): impressions, reach, likes, comments, shares, profile_clicks, link_clicks
- Upserts into new table `post_analytics`:
  ```sql
  CREATE TABLE post_analytics (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    social_post_id text REFERENCES social_posts(post_id),
    platform text NOT NULL,
    fetched_at timestamptz DEFAULT NOW(),
    impressions int,
    reach int,
    likes int,
    comments int,
    shares int,
    saves int,
    profile_clicks int,
    link_clicks int,
    engagement_rate numeric,
    raw_response jsonb,
    UNIQUE (social_post_id, fetched_at::date)
  );
  ```
- Idempotent (one row per post per day)

**Acceptance:**
- After first run, `post_analytics` populated for every verified post in last 7 days
- Sage can query `SELECT platform, AVG(engagement_rate) FROM post_analytics WHERE fetched_at > NOW() - INTERVAL '7 days' GROUP BY platform`

### Phase 3 — Sage intelligence feedback loop

**Update:** `api/cron-sage-intelligence.js` (already exists per system prompt §"How cron-sage-intelligence feeds the pipeline")
- After Phase 2 ships, add the analytics pull to the intelligence brief
- Identify top platform + top pillar + top persona by 7-day engagement rate
- Inject the brief into `sage_intelligence` table
- `cron-generate-posts.js` already reads this — content generation will start self-tuning

**Acceptance:**
- `sage_intelligence` table has a fresh row each day naming top platform, top pillar, top persona based on real analytics

---

## Memory rules Carter must respect

1. **Never mark a post `posted` without verifying delivery** — that was the root bug we're fixing
2. **Use `CRON_SECRET`** for cron authentication, never hardcode tokens
3. **Test on staging first** — both cron endpoints must hit staging before main
4. **Send Sage a Telegram (chat_id 7874782923 via marketing bot, or stash for Sage's next cron run)** with a one-line completion report
5. **Coordinate with Atlas if Zernio API needs persistent profile / browser automation** — the API may not expose post_id retrieval at all, in which case we fall back to Atlas-driven Playwright on the platform pages themselves

---

## Output format expected back to Sage

After Carter ships, send a single Telegram or memory file with:
- Endpoint URLs deployed (staging + prod)
- Cron schedule registered in cron-job.org
- Sample row from `post_analytics` to confirm shape
- Any platform where Zernio doesn't expose the analytics endpoint (so Sage knows where Atlas needs to take over)

---

## Estimated effort

- Phase 1 (verification): 2-3 hours, mostly Zernio API documentation reading
- Phase 2 (analytics): 4-6 hours, depends on how clean Zernio's analytics endpoint is
- Phase 3 (intelligence): 1-2 hours of glue code

Total: 1 working day for Carter on focus.
