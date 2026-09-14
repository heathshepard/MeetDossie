// ONE-TIME migration: widen public.social_posts_platform_check to allow
// platform='youtube', and make sure the "Shepard Real Estate Solutions"
// YouTube destination row exists in zernio_accounts.
//
// Root cause (same class as the 2026-08-15 linkedin_personal incident, see
// api/admin-migrate-social-posts-linkedin-personal.js): the YouTube publish
// path in cron-publish-approved.js (pushToZernio(), ~line 419) has existed
// since 2026-08-25, and supabase/migrations/20260825_zernio_accounts_youtube_heath_realtor.sql
// wired the zernio_accounts row — but no migration ever added 'youtube' to
// social_posts_platform_check. Every insert with platform='youtube' 400s at
// the DB, so the publish code has been unreachable dead code since it shipped.
//
// No 'youtube_short' value is added. Shorts are not a distinct Zernio
// platform slug in this codebase — Instagram Reels post with
// platform='instagram' (see api/sage-webhook.js Reels guidance) and are
// differentiated purely by video aspect ratio/duration, not a separate
// platform string. YouTube Shorts follow the same pattern: platform stays
// 'youtube', verticality comes from the uploaded media.
//
// Safe to re-run — DROP-then-CREATE constraint + WHERE-NOT-EXISTS insert,
// no data touched or destroyed.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-14

const { runAdminSql } = require('./_lib/pg-admin');
const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MIGRATE_SQL = `
ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_platform_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_platform_check
  CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'linkedin_personal', 'tiktok', 'twitter', 'youtube'));

INSERT INTO public.zernio_accounts (platform, account_handle, zernio_account_id, owner, is_active)
SELECT 'youtube', 'Shepard Real Estate Solutions', '6a846a0c77555aae017776e3', 'heath-realtor', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.zernio_accounts WHERE platform = 'youtube' AND owner = 'heath-realtor'
);
`;

// Same TLS workaround as _lib/pg-admin.js — needed for the verification
// SELECT since runAdminSql() doesn't return rows.
async function queryAdminSql(sql) {
  const connectionString = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('postgres_connection_env_missing');
  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false, require: true } });
  try {
    await client.connect();
    const result = await client.query(sql);
    return result.rows;
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader =
    (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(MIGRATE_SQL);

    const constraintRows = await queryAdminSql(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'social_posts_platform_check'`
    );
    const zernioRows = await queryAdminSql(
      `SELECT platform, account_handle, zernio_account_id, owner, is_active FROM public.zernio_accounts WHERE platform = 'youtube' AND owner = 'heath-realtor'`
    );

    // Real insert test — proves PostgREST (not just raw psql) accepts the
    // new value, then cleans up immediately. Uses status='failed' (never
    // 'approved') as a belt-and-suspenders guard against cron-publish-approved
    // picking it up if cleanup somehow didn't run.
    let insertTest = { attempted: false };
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const testPostId = `test-youtube-constraint-${Date.now()}`;
      const headers = {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      };
      const insRes = await fetch(`${SUPABASE_URL}/rest/v1/social_posts`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          post_id: testPostId,
          platform: 'youtube',
          status: 'failed',
          content: 'constraint-verification-test-row',
          persona: 'dossie',
          topic: 'test',
          generated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        }),
      });
      const insertOk = insRes.ok;
      const insertBody = insertOk ? null : (await insRes.text()).slice(0, 500);

      const delRes = await fetch(
        `${SUPABASE_URL}/rest/v1/social_posts?post_id=eq.${encodeURIComponent(testPostId)}`,
        { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } }
      );

      insertTest = {
        attempted: true,
        post_id: testPostId,
        insert_ok: insertOk,
        insert_status: insRes.status,
        insert_error: insertBody,
        delete_ok: delRes.ok,
        delete_status: delRes.status,
      };
    }

    // posting_schedule: add a draft cadence row if none exists for youtube,
    // left INACTIVE — Heath wants a manual first post confirmed working
    // before anything auto-posts. Inserted via REST (not raw SQL) so
    // PostgREST handles the time_slots array/jsonb coercion the same way
    // every other posting_schedule row is written.
    let postingSchedule = { attempted: false };
    if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
      const headers = {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      };
      const existingRes = await fetch(
        `${SUPABASE_URL}/rest/v1/posting_schedule?platform=eq.youtube&select=*`,
        { headers }
      );
      const existingRows = existingRes.ok ? await existingRes.json() : [];

      if (Array.isArray(existingRows) && existingRows.length > 0) {
        postingSchedule = { attempted: false, already_existed: true, rows: existingRows };
      } else {
        const insRes = await fetch(`${SUPABASE_URL}/rest/v1/posting_schedule`, {
          method: 'POST',
          headers: { ...headers, Prefer: 'return=representation' },
          body: JSON.stringify({
            platform: 'youtube',
            day_of_week: 3, // Wednesday
            time_slots: ['11:00:00'],
            timezone: 'America/Chicago',
            is_active: false,
            max_per_day: 1,
            max_per_slot: 1,
          }),
        });
        const insBody = await insRes.text();
        postingSchedule = {
          attempted: true,
          insert_ok: insRes.ok,
          insert_status: insRes.status,
          body: insBody.slice(0, 500),
        };
      }
    }

    return res.status(200).json({
      ok: true,
      message: "social_posts_platform_check now allows 'youtube'; zernio_accounts youtube/heath-realtor row confirmed",
      constraint: constraintRows[0] || null,
      zernio_account: zernioRows[0] || null,
      insert_test: insertTest,
      posting_schedule: postingSchedule,
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to widen social_posts_platform_check',
      details: err.message,
    });
  }
};
