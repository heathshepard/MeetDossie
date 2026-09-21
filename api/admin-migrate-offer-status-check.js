// One-time fix: transaction_offers_status_check rejected 'retired' — see
// supabase/migrations/20260921_offer_status_check_allow_retired.sql for the
// full story (found by live verification of retire_offer, not by the
// earlier OpenAPI introspection pull).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21.

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.transaction_offers
  DROP CONSTRAINT IF EXISTS transaction_offers_status_check;

ALTER TABLE public.transaction_offers
  ADD CONSTRAINT transaction_offers_status_check
  CHECK (status IN ('pending', 'accepted', 'rejected', 'countered', 'retired'));
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
      message: 'transaction_offers_status_check now allows retired',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to update transaction_offers_status_check',
      details: err.message,
    });
  }
};
