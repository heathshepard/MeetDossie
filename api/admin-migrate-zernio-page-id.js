// One-time migration: add nullable page_id column to public.zernio_accounts,
// backfill MeetDossie's own Page ID onto the existing dossie/facebook row,
// and insert the second Facebook destination (Heath's realtor Page) reusing
// the SAME zernio_account_id (see supabase/migrations/20260818_zernio_accounts_page_id.sql
// for full rationale). Applied live 2026-08-18. Safe to re-run — every
// clause is IF NOT EXISTS / idempotent, no data destroyed.
//
// DDL isn't reachable through PostgREST (no generic SQL-exec RPC deployed on
// this project), so this runs directly against Postgres via the shared
// api/_lib/pg-admin.js helper (POSTGRES_URL_NON_POOLING).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-18

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.zernio_accounts
  ADD COLUMN IF NOT EXISTS page_id text;

UPDATE public.zernio_accounts
  SET page_id = '1066823756515739'
  WHERE platform = 'facebook' AND owner = 'dossie' AND page_id IS NULL;

INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, page_id, owner, is_active)
SELECT 'facebook', '@HeathShepardRealtor', '69f253c3985e734bf3d8f9bc', '102113502016276', 'heath-realtor', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'facebook' AND owner = 'heath-realtor'
);
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
      message: 'zernio_accounts.page_id column added, dossie row backfilled, heath-realtor row inserted',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to migrate zernio_accounts.page_id',
      details: err.message,
    });
  }
};
