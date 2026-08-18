-- ============================================================================
-- engagement_queue -- manual-post handoff (replaces script-driven auto-post)
--
-- Heath's directive 2026-08-18: scripts/sage-engagement-queue-poster.js no
-- longer drives Playwright to post a reply as him -- zero code-driven posting
-- action on the personal profile, full stop. On Approve, telegram-webhook.js
-- now hands the thread permalink + drafted reply back to Heath via Telegram
-- for him to paste and post himself, and flips status to
-- 'awaiting_manual_post' instead of leaving it at 'approved' (which used to
-- mean "the poster script will pick this up"). 'posted' is now only reached
-- when Heath explicitly confirms via the "Mark Posted" button.
--
-- Owner: Atlas, 2026-08-18
-- ============================================================================

ALTER TABLE public.engagement_queue
  DROP CONSTRAINT IF EXISTS engagement_queue_status_check;

ALTER TABLE public.engagement_queue
  ADD CONSTRAINT engagement_queue_status_check
  CHECK (status IN (
    'pending_review', 'approved', 'awaiting_manual_post', 'rejected',
    'posted', 'expired'
  ));

-- Telegram message_id of the follow-up "here's your thread + text, paste it
-- yourself" handoff card, captured so the confirmation tap can edit that
-- specific message rather than the original approval card.
ALTER TABLE public.engagement_queue
  ADD COLUMN IF NOT EXISTS handoff_message_id BIGINT;

ALTER TABLE public.engagement_queue
  ADD COLUMN IF NOT EXISTS handoff_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.engagement_queue.handoff_message_id IS
  'Telegram message_id of the post-approval handoff card (permalink + reply text + Mark Posted button). Distinct from telegram_message_id, which is the original review card.';
COMMENT ON COLUMN public.engagement_queue.handoff_sent_at IS
  'When the manual-post handoff card was sent to Heath, immediately after Approve.';

-- ----------------------------------------------------------------------------
-- engagement_post_log -- audit trail of actually-posted comments
--
-- Written once, at the moment Heath taps "Mark Posted" in Telegram to confirm
-- he pasted + posted the reply himself. Separate from engagement_queue so the
-- queue table stays one-row-per-candidate while this stays append-only and
-- gives a clean timestamped history for pacing/volume audits (the daily scan
-- cap in scripts/_lib/scan-caps.js governs page-visit volume; this table is
-- the equivalent record for actual posted comments).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.engagement_post_log (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  engagement_queue_id   UUID REFERENCES public.engagement_queue(id) ON DELETE SET NULL,
  group_name            TEXT NOT NULL,
  permalink             TEXT,
  drafted_reply         TEXT,
  posted_at             TIMESTAMPTZ NOT NULL,
  confirmed_via         TEXT NOT NULL DEFAULT 'telegram_button',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_engagement_post_log_posted_at
  ON public.engagement_post_log (posted_at);

COMMENT ON TABLE public.engagement_post_log IS
  'Append-only audit log of comments Heath confirmed he actually posted manually after the engagement_queue handoff. Never written to by any auto-posting code path -- only by the engage_posted_<id> Telegram confirmation.';

ALTER TABLE public.engagement_post_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_post_log_service_all ON public.engagement_post_log
  FOR ALL USING (true) WITH CHECK (true);
