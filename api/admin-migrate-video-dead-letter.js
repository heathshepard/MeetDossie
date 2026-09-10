// One-time migration: dead-letter support for the video render queue.
// Run this ONCE manually (staging), confirm, then delete.
// Mirrors supabase/migrations/20260909_social_posts_video_dead_letter.sql.
//
// Uses a direct Postgres connection (pg) because no working SQL-exec RPC
// exists in this project (api/admin-migrate-buyer2-seller2.js's rpc/exec
// call was verified 404 — no such function in the schema cache, 2026-09-09).
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

const SQL = `
ALTER TABLE public.social_posts
  ADD COLUMN IF NOT EXISTS render_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold', 'video_failed'
  ));
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!CONNECTION_STRING) {
    return res.status(500).json({ ok: false, error: 'POSTGRES_URL_NON_POOLING / POSTGRES_URL not configured' });
  }

  const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query(SQL);
    const check = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='social_posts' AND column_name='render_attempts'`
    );
    return res.status(200).json({
      ok: true,
      message: 'render_attempts column + video_failed status added to social_posts',
      column_confirmed: check.rows.length > 0,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message });
  } finally {
    await client.end().catch(() => {});
  }
};
