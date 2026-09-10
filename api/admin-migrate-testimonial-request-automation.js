// One-time migration: applies supabase/migrations/20260910_testimonial_request_automation.sql
// (transactions.testimonial_draft_created_at + action_items testimonial columns).
// Carter's cron-request-testimonial-draft.js / cron-testimonial-nudge.js shipped
// 2026-09-10 (commit b98c688d) referencing these columns, but the migration was
// never run -- both crons were 500ing with "column does not exist" (42703)
// when registered on 2026-09-10 (Atlas, cron-slot-freeing pass).
//
// Safe to re-run -- ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS only,
// no data touched. Delete this file after the one-time run per the established
// admin-migrate-* pattern (see admin-migrate-cancellation-feedback.js).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-10

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
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
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'testimonial_request_automation columns/indexes ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to apply testimonial_request_automation migration', details: err.message });
  }
};
