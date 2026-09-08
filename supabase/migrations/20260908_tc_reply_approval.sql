-- 20260908_tc_reply_approval.sql
--
-- Comment-reply approval loop for the TC discovery campaign (Heath's spec:
-- "when a comment comes in I get a telegram notification with the post, the
-- comment, and a proposed reply that I can edit if necessary and an approve
-- button").
--
-- Lifecycle (reply_status):
--   'new'         harvested, not yet drafted/notified
--   'flagged'     hostile / astroturf-accusation — Heath's personal judgment,
--                 NO draft is generated, nothing ever auto-posts
--   'notified'    Telegram approval message DELIVERED (never stamped on a
--                 telegram-gate-suppressed send — see cron-tc-reply-approval)
--   'approved'    Heath tapped Approve (reply_final = draft) or replied with
--                 an edit (reply_final = his text). Local poster picks it up.
--   'skipped'     Heath tapped Skip. Terminal.
--   'posting'     claimed by the local poster (claim = atomic PATCH from
--                 'approved'; prevents double-posting across runs)
--   'posted'      reply confirmed live on Facebook by re-reading the thread
--   'post_failed' submit or verification failed. Terminal — NEVER auto-retried,
--                 because a verify failure can mean the reply DID post.
--
-- One reply per comment, ever: the poster only claims 'approved' rows and the
-- claim is guarded on reply_status; 'posted'/'post_failed' are terminal.
--
-- Owner: Carter, 2026-09-08

ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS reply_status TEXT NOT NULL DEFAULT 'new'
    CHECK (reply_status IN ('new','flagged','notified','approved','skipped','posting','posted','post_failed')),
  ADD COLUMN IF NOT EXISTS reply_draft TEXT,
  ADD COLUMN IF NOT EXISTS reply_final TEXT,
  ADD COLUMN IF NOT EXISTS reply_notified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_telegram_message_id TEXT,
  ADD COLUMN IF NOT EXISTS reply_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_error TEXT;

COMMENT ON COLUMN public.tc_discovery_responses.reply_status IS
  'Reply-approval lifecycle: new -> (flagged|notified) -> (approved|skipped) -> posting -> (posted|post_failed). Nothing posts without an explicit Heath approval; post_failed is terminal (never auto-retried).';
COMMENT ON COLUMN public.tc_discovery_responses.reply_draft IS
  'AI-drafted reply in Heath''s voice (no Dossie mention, no pitch, no link). Display-only until approved.';
COMMENT ON COLUMN public.tc_discovery_responses.reply_final IS
  'The text that actually posts: the draft on plain Approve, or Heath''s edited text from the Telegram reply flow.';

CREATE INDEX IF NOT EXISTS idx_tc_discovery_responses_reply_status
  ON public.tc_discovery_responses (reply_status);

-- Heath's own comments are never reply targets.
UPDATE public.tc_discovery_responses
  SET reply_status = 'skipped'
  WHERE is_own_comment = TRUE AND reply_status = 'new';
