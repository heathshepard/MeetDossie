-- Post-closing testimonial request automation.
--
-- Heath, 2026-09-10, after 104 Wild Cherry (the Lintons) closed: "we need to
-- make sure to get testimonials from the Lintons. This is something that
-- Dossie should do automatically once a sale happens." Product requirement,
-- not a one-off — see memory dossie-post-closing-testimonial-request.md.
--
-- Shape: when a transaction reaches status='closed', a cron drafts a
-- testimonial/review-request email (agent's own voice, per-agent profile —
-- never hardcoded to Heath) into email_queue as a pending draft, plus an
-- action_items row so it can't be skipped silently. The agent taps Send —
-- never auto-sent. A one-time nudge fires at 7 days if still un-actioned.
--
-- Distinct from the older cron-testimonial-request.js / testimonial_requested_at
-- flow, which emails the AGENT a forward-to-client suggestion. This is the
-- newer draft-to-client-in-app flow the 2026-09-10 spec asks for. Both may
-- coexist; they use separate idempotency markers so neither interferes with
-- the other.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS testimonial_draft_created_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.testimonial_draft_created_at IS
  'Set once by cron-request-testimonial-draft.js when the closed-deal testimonial email_queue draft + action_item are created. Idempotency marker -- never re-drafted once set. Distinct from testimonial_requested_at (the older agent-forward-copy reminder in cron-testimonial-request.js).';

ALTER TABLE public.action_items
  ADD COLUMN IF NOT EXISTS email_queue_id UUID,
  ADD COLUMN IF NOT EXISTS sms_draft TEXT,
  ADD COLUMN IF NOT EXISTS consent_to_use_name BOOLEAN,
  ADD COLUMN IF NOT EXISTS reply_text TEXT,
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN public.action_items.email_queue_id IS
  'Links a testimonial_request (or similar drafted-email) action item to its email_queue row. Not an enforced FK -- avoids migration coupling, matches the pattern used by tc_consent.email_queue_id.';
COMMENT ON COLUMN public.action_items.sms_draft IS
  'One-line SMS variant of the drafted email. Populated for action_type=testimonial_request rows.';
COMMENT ON COLUMN public.action_items.consent_to_use_name IS
  'v1 testimonial capture: whether the client gave permission to use their name/street publicly. Recorded manually by the agent alongside reply_text.';
COMMENT ON COLUMN public.action_items.reply_text IS
  'v1 testimonial capture: free-text field for the client''s reply/quote, recorded manually by the agent. No dedicated testimonials UI in v1 -- this column is the whole of it.';
COMMENT ON COLUMN public.action_items.reminder_sent_at IS
  'Set when the one-time 7-day nudge fires for a testimonial_request action item still pending/not dismissed. A non-null value blocks any further nudge -- exactly one, ever.';

CREATE INDEX IF NOT EXISTS idx_transactions_testimonial_draft_pending
  ON public.transactions (status)
  WHERE status = 'closed' AND testimonial_draft_created_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_action_items_testimonial_nudge_pending
  ON public.action_items (action_type, created_at)
  WHERE action_type = 'testimonial_request' AND reminder_sent_at IS NULL;
