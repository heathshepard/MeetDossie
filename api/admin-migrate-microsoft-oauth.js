// One-time migration: add user_integrations.microsoft_email, mirroring the
// existing google_email column. Full design commentary in
// supabase/migrations/20260901_microsoft_email_integration.sql.
//
// Safe to re-run: ADD COLUMN IF NOT EXISTS is a no-op on a second run.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-01 (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.user_integrations ADD COLUMN IF NOT EXISTS microsoft_email text;

COMMENT ON COLUMN public.user_integrations.microsoft_email IS
  'The connected Microsoft 365 / Outlook.com account email, for oauth_provider=microsoft_graph rows. Written by api/microsoft-oauth-callback.js.';
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
      message: 'user_integrations.microsoft_email column ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate microsoft_email column', details: err.message });
  }
};
