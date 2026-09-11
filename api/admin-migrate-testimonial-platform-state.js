// One-time migration: applies supabase/migrations/20260910b_testimonial_platform_state.sql
// (transactions Google/Zillow platform-state columns + profiles.zillow_profile_url).
//
// Follow-up to admin-migrate-testimonial-request-automation.js (already run and
// removed). cron-request-zillow-review-prompt.js references
// transactions.google_requested_at / zillow_prompt_created_at and
// profiles.zillow_profile_url, none of which exist yet -- the agent that wrote
// the migration had no Supabase credentials to run it.
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
  ADD COLUMN IF NOT EXISTS google_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS google_received_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS zillow_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quote_received BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS zillow_prompt_created_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.google_requested_at IS
  'Stamped by send-testimonial-request.js when the agent taps Send on the closing-day Google review ask. Also the anchor cron-request-zillow-review-prompt.js watches for its 7-day-later Zillow nudge.';
COMMENT ON COLUMN public.transactions.google_received_at IS
  'Stamped by action-items.js PATCH when the agent marks the testimonial_request action item Done (i.e. confirms the Google review actually came back). Manual confirmation -- no Google API integration in v1.';
COMMENT ON COLUMN public.transactions.zillow_requested_at IS
  'Stamped by action-items.js PATCH when the agent marks the zillow_review_prompt action item Done -- i.e. they went and ran Zillow''s own review-request flow themselves. Dossie never emails a Zillow ask to the client.';
COMMENT ON COLUMN public.transactions.quote_received IS
  'True once the agent records a non-empty reply_text on the testimonial_request action item (the two-sentence quote for social/website reuse).';
COMMENT ON COLUMN public.transactions.zillow_prompt_created_at IS
  'Idempotency marker for cron-request-zillow-review-prompt.js -- the zillow_review_prompt action item is created once per dossier, ever.';

CREATE INDEX IF NOT EXISTS idx_transactions_zillow_prompt_pending
  ON public.transactions (google_requested_at)
  WHERE google_requested_at IS NOT NULL AND zillow_prompt_created_at IS NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS google_review_url TEXT,
  ADD COLUMN IF NOT EXISTS zillow_profile_url TEXT;

COMMENT ON COLUMN public.profiles.google_review_url IS
  'Agent''s direct Google write-review link (Settings). Used verbatim in the closing-day testimonial ask -- if unset, Dossie skips drafting the client email and prompts the agent to add it instead of sending a broken link.';
COMMENT ON COLUMN public.profiles.zillow_profile_url IS
  'Agent''s Zillow profile review-request page (Settings). Surfaced in the zillow_review_prompt action item so the agent can run Zillow''s own flow -- never emailed to a client, since Zillow does not attribute reviews from a pasted link.';
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
      message: 'testimonial_platform_state columns/indexes ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to apply testimonial_platform_state migration', details: err.message });
  }
};
