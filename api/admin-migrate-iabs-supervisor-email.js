// One-time migration: adds public.profiles.supervising_broker_email —
// the IABS "Licensed Supervisor of Sales Agent/Associate" email had nowhere
// to be stored anywhere in the product before this. Canonical SQL + column
// commentary: api/_migrations/0028-iabs-supervisor-email.sql.
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS only. No data is touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-10-01 (IABS supervisor email gap)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS supervising_broker_email TEXT;
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({
      ok: true,
      message: 'profiles.supervising_broker_email ready',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate iabs-supervisor-email column', details: err.message });
  }
};
