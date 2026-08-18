-- ============================================================================
-- engagement_queue -- real FB-group comment/post engagement opportunities
--
-- Purpose: Heath's directive (2026-08-17) -- the group-listening scraper
-- (scripts/fb-lead-scraper.js) should not just fire a generic "warm lead"
-- alert. For each real, relevant comment/post it finds in a target group
-- (group_registry), it should capture the actual text + author + permalink,
-- draft a genuine reply IN HEATH'S OWN VOICE, and hold it for approval --
-- never auto-post as him. Mirrors content_pipeline_queue's flow.
--
-- Flow:
--   1. scripts/fb-engagement-scraper.js scans group_registry groups with the
--      Playwright DossieBot profile, finds matching posts/comments, drafts a
--      reply via Anthropic (Heath's real texting voice, short & direct),
--      inserts one row per candidate here (status='pending_review').
--   2. api/cron-engagement-review.js (every 20 min) sends each pending_review
--      row to Heath via Telegram with Approve / Reject buttons.
--   3. api/telegram-webhook.js handles engage_approve_<id> / engage_reject_<id>
--      -> status='approved' | 'rejected'. Approve does NOT auto-post --
--      it only marks the draft usable; posting the comment is still a
--      separate, deliberate manual/scripted action Heath triggers.
--   4. Heath can edit the draft by replying in Telegram to the card
--      (matches cron-content-pipeline-review.js's own no-inline-edit
--      pattern) -- edits are applied by re-running the scraper's draft step
--      or hand-editing the row directly; there is no auto-apply-edit path.
--
-- Terminal states: rejected (discarded), posted (Heath manually confirmed
-- the comment went up), expired (thread went stale before review).
--
-- Owner: Sage, 2026-08-17
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.engagement_queue (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source                TEXT NOT NULL DEFAULT 'facebook_group',
  group_name            TEXT NOT NULL,
  group_url             TEXT,
  content_type          TEXT NOT NULL DEFAULT 'post'
                        CHECK (content_type IN ('post', 'comment')),
  author_name           TEXT,
  original_text         TEXT NOT NULL,
  thread_context        TEXT,
  permalink             TEXT,
  matched_pattern       TEXT,
  drafted_reply         TEXT NOT NULL,
  draft_model            TEXT,
  status                TEXT NOT NULL DEFAULT 'pending_review'
                        CHECK (status IN (
                          'pending_review', 'approved', 'rejected',
                          'posted', 'expired'
                        )),
  telegram_sent_at      TIMESTAMPTZ,
  telegram_message_id   BIGINT,
  reviewed_at           TIMESTAMPTZ,
  posted_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_name, original_text)
);

CREATE INDEX IF NOT EXISTS idx_engagement_queue_status
  ON public.engagement_queue (status, created_at);

CREATE INDEX IF NOT EXISTS idx_engagement_queue_pending_review
  ON public.engagement_queue (telegram_sent_at)
  WHERE status = 'pending_review';

COMMENT ON TABLE public.engagement_queue IS
  'Real FB-group comment/post engagement candidates with a drafted reply in Heath''s voice. Nothing here is ever auto-posted -- Heath approves/rejects via Telegram, and posting the approved comment is a separate deliberate step.';
COMMENT ON COLUMN public.engagement_queue.drafted_reply IS
  'A genuine, contextual reply to the specific original_text -- never a generic pitch. Drafted to sound like Heath (short, direct, not corporate/salesy).';

ALTER TABLE public.engagement_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_queue_service_all ON public.engagement_queue
  FOR ALL USING (true) WITH CHECK (true);
