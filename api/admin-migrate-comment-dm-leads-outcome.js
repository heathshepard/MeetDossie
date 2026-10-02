// One-time migration: add outcome/outcome_at/outcome_notes to
// public.comment_dm_leads so the brokerage/personal-brand funnel's downstream
// stages (reply -> appointment -> listing/buyer agreement -> closing) have
// somewhere to be manually logged. See
// supabase/migrations/20261002_comment_dm_leads_outcome.sql for the full
// rationale — this does NOT automate outcome tracking (no event source
// exists for it), it only adds the column for a human to fill in. Safe to
// re-run — IF NOT EXISTS, no data destroyed, no existing row touched.
//
// NOT INVOKED as part of this branch/PR — this changes the live production
// database immediately regardless of git branch/merge state, so it is left
// for Heath to trigger deliberately:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://meetdossie.com/api/admin-migrate-comment-dm-leads-outcome
//
// Mirrors api/admin-migrate-post-analytics-owner.js's exact pattern.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Pierce, 2026-10-02 (feat/lead-attribution-1002)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.comment_dm_leads
  ADD COLUMN IF NOT EXISTS outcome TEXT,
  ADD COLUMN IF NOT EXISTS outcome_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_notes TEXT;

ALTER TABLE public.comment_dm_leads
  DROP CONSTRAINT IF EXISTS comment_dm_leads_outcome_chk;
ALTER TABLE public.comment_dm_leads
  ADD CONSTRAINT comment_dm_leads_outcome_chk
  CHECK (outcome IS NULL OR outcome IN ('replied', 'appointment_booked', 'listing_agreement', 'buyer_agreement', 'closed', 'dead'));

CREATE INDEX IF NOT EXISTS idx_comment_dm_leads_outcome
  ON public.comment_dm_leads (outcome)
  WHERE outcome IS NOT NULL;
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
      message: 'comment_dm_leads.outcome/outcome_at/outcome_notes added — manual brokerage-funnel outcome logging is now possible (see api/_lib/brokerage-funnel.js).',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate comment_dm_leads outcome tracking',
      details: err.message,
    });
  }
};
