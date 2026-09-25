// Vercel Serverless Function: /api/admin-migrate-zernio-comment-engine
//
// One-shot, idempotent DDL for
// supabase/migrations/20260925_zernio_comment_engine.sql.
//
// WHY THIS EXISTS: PostgREST cannot run DDL, and the POSTGRES_* credentials
// are Vercel *Sensitive* vars, so `.env.local` holds the literal "[SENSITIVE]"
// and DDL cannot be applied from a developer machine at all. It CAN be applied
// from inside a deployment, where the real POSTGRES_URL is injected at
// runtime. Same pattern as api/admin-migrate-video-retraction.js.
//
// Deliberately NOT a generic "run any SQL" endpoint: every statement is
// hardcoded below, so a leaked CRON_SECRET cannot turn this into arbitrary DDL
// execution. Every statement is IF NOT EXISTS / ON CONFLICT DO NOTHING, so
// re-running is a no-op.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}
// Method: POST

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;

// Keep in sync with supabase/migrations/20260925_zernio_comment_engine.sql.
const STATEMENTS = [
  // 1. social_comment_replies -- inbound comments on our own posts
  `ALTER TABLE public.social_comment_replies
     ADD COLUMN IF NOT EXISTS account_id            text,
     ADD COLUMN IF NOT EXISTS parent_comment_id     text,
     ADD COLUMN IF NOT EXISTS comment_url           text,
     ADD COLUMN IF NOT EXISTS commenter_platform_id text,
     ADD COLUMN IF NOT EXISTS commenter_name        text,
     ADD COLUMN IF NOT EXISTS comment_created_at    timestamptz,
     ADD COLUMN IF NOT EXISTS post_excerpt          text,
     ADD COLUMN IF NOT EXISTS post_permalink        text,
     ADD COLUMN IF NOT EXISTS risk_category         text,
     ADD COLUMN IF NOT EXISTS risk_confidence       text,
     ADD COLUMN IF NOT EXISTS escalated             boolean NOT NULL DEFAULT false,
     ADD COLUMN IF NOT EXISTS escalation_reason     text,
     ADD COLUMN IF NOT EXISTS gate_failures         jsonb,
     ADD COLUMN IF NOT EXISTS telegram_message_id   bigint,
     ADD COLUMN IF NOT EXISTS telegram_sent_at      timestamptz,
     ADD COLUMN IF NOT EXISTS approved_at           timestamptz,
     ADD COLUMN IF NOT EXISTS approved_by           text,
     ADD COLUMN IF NOT EXISTS thread_status         text NOT NULL DEFAULT 'open',
     ADD COLUMN IF NOT EXISTS thread_closed_at      timestamptz,
     ADD COLUMN IF NOT EXISTS thread_close_reason   text,
     ADD COLUMN IF NOT EXISTS attempt_count         integer NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS last_seen_at          timestamptz,
     ADD COLUMN IF NOT EXISTS ingested_at           timestamptz NOT NULL DEFAULT now()`,

  `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'social_comment_replies_thread_status_chk') THEN
       ALTER TABLE public.social_comment_replies
         ADD CONSTRAINT social_comment_replies_thread_status_chk
         CHECK (thread_status IN ('open','closed'));
     END IF;
   END $$`,

  // The mechanical guarantee behind "nothing may be lost": re-ingesting a
  // comment can never duplicate it and can never fail the batch.
  `CREATE UNIQUE INDEX IF NOT EXISTS social_comment_replies_platform_comment_uniq
     ON public.social_comment_replies (platform, comment_external_id)`,

  `CREATE INDEX IF NOT EXISTS social_comment_replies_outstanding_idx
     ON public.social_comment_replies (thread_status, reply_status, comment_created_at DESC)`,

  // 2. video_comment_automations -- the keyword ledger
  `CREATE TABLE IF NOT EXISTS public.video_comment_automations (
     id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     video_library_id     text NOT NULL REFERENCES public.video_library(id) ON DELETE CASCADE,
     keyword              text NOT NULL,
     platform             text NOT NULL CHECK (platform IN ('instagram','facebook')),
     account_id           text NOT NULL,
     platform_post_id     text,
     zernio_automation_id text,
     dm_message           text NOT NULL,
     asset_url            text,
     asset_button_label   text NOT NULL DEFAULT 'Get the one-pager',
     match_mode           text NOT NULL DEFAULT 'word' CHECK (match_mode IN ('exact','contains','word')),
     typo_tolerance       boolean NOT NULL DEFAULT true,
     exclude_keywords     text[] NOT NULL DEFAULT '{}',
     status               text NOT NULL DEFAULT 'pending'
       CHECK (status IN ('pending','armed','paused','retired','error')),
     armed_at             timestamptz,
     paused_at            timestamptz,
     retired_at           timestamptz,
     retire_reason        text,
     last_error           text,
     last_synced_at       timestamptz,
     created_at           timestamptz NOT NULL DEFAULT now(),
     updated_at           timestamptz NOT NULL DEFAULT now()
   )`,

  // A keyword is a permanent attribution token. Recycling one makes every lead
  // it ever produced ambiguous, so uniqueness lives in the DB, not in a code
  // path somebody can forget to call.
  `CREATE UNIQUE INDEX IF NOT EXISTS video_comment_automations_keyword_uniq
     ON public.video_comment_automations (lower(keyword))`,

  `CREATE UNIQUE INDEX IF NOT EXISTS video_comment_automations_video_account_uniq
     ON public.video_comment_automations (video_library_id, account_id)`,

  `CREATE INDEX IF NOT EXISTS video_comment_automations_status_idx
     ON public.video_comment_automations (status)`,

  // The declaration site: the keyword lives ON the video record.
  `ALTER TABLE public.video_library
     ADD COLUMN IF NOT EXISTS dm_keyword   text,
     ADD COLUMN IF NOT EXISTS dm_asset_url text,
     ADD COLUMN IF NOT EXISTS dm_message   text,
     ADD COLUMN IF NOT EXISTS dm_target_posts jsonb`,

  `CREATE UNIQUE INDEX IF NOT EXISTS video_library_dm_keyword_uniq
     ON public.video_library (lower(dm_keyword)) WHERE dm_keyword IS NOT NULL`,

  // 3. comment_dm_leads -- who asked for the asset
  `CREATE TABLE IF NOT EXISTS public.comment_dm_leads (
     id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     zernio_log_id         text NOT NULL UNIQUE,
     platform              text NOT NULL,
     account_id            text,
     commenter_platform_id text,
     commenter_name        text,
     commenter_handle      text,
     is_follower           boolean,
     follower_count        integer,
     keyword               text,
     video_library_id      text REFERENCES public.video_library(id) ON DELETE SET NULL,
     automation_id         uuid REFERENCES public.video_comment_automations(id) ON DELETE SET NULL,
     zernio_automation_id  text,
     comment_text          text,
     comment_external_id   text,
     dm_status             text,
     dm_error              text,
     delivered             boolean,
     read                  boolean,
     triggered_at          timestamptz,
     synced_at             timestamptz NOT NULL DEFAULT now(),
     created_at            timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS comment_dm_leads_keyword_idx ON public.comment_dm_leads (keyword)`,
  `CREATE INDEX IF NOT EXISTS comment_dm_leads_video_idx   ON public.comment_dm_leads (video_library_id)`,
  `CREATE INDEX IF NOT EXISTS comment_dm_leads_time_idx    ON public.comment_dm_leads (triggered_at DESC)`,

  // Ops tables, service-role only. Same posture as the 2026-09-24 RLS fix.
  `ALTER TABLE public.video_comment_automations ENABLE ROW LEVEL SECURITY`,
  `ALTER TABLE public.comment_dm_leads          ENABLE ROW LEVEL SECURITY`,

  // 4. Kill switches -- default OFF. Nothing talks to a real person until
  //    Heath flips these.
  `INSERT INTO public.ops_flags (key, enabled, reason, updated_by) VALUES
     ('zernio_comment_replies', false,
      'Auto-posting drafted replies to real commenters via the Zernio API. OFF until Heath turns it on. Drafting + Telegram approval run regardless; this flag only controls whether an APPROVED reply is actually posted.',
      'atlas'),
     ('zernio_comment_automations', false,
      'STAGE 1. Allows the sync to CREATE comment-to-DM automations at Zernio, in a PAUSED state. OFF until Heath turns it on; with it off the sync is report-only and creates nothing.',
      'atlas'),
     ('zernio_comment_automations_live', false,
      'STAGE 2. Allows created automations to be ARMED so they DM real people who comment the keyword. Requires stage 1. Two flags because POST /v1/comment-automations ignores isActive:false and returns an ACTIVE automation - creating one is itself a publish-class action.',
      'atlas')
   ON CONFLICT (key) DO NOTHING`,

  // 5. Outcome expectation -- a zero-output run must be VISIBLE. This pipeline
  //    is the exhibit: the old cron-comment-monitor said 'ok' for 79 days.
  `INSERT INTO public.outcome_expectations
     (key, pipeline, label, source_table, source_filters, time_column,
      window_mode, window_hours, min_count, classifiers, remediations,
      remediation_mode, severity, grace_hours)
   VALUES
     ('comment_ingest_weekly', 'zernio-comments',
      'Inbound comments ingested from the Zernio API',
      'social_comment_replies', '{}'::jsonb, 'ingested_at',
      'recent', 168, 1, '{}', '{}', 'safe', 'warn', 24)
   ON CONFLICT (key) DO NOTHING`,
];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const conn = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!conn || conn === '[SENSITIVE]') {
    return res.status(500).json({
      ok: false,
      error: 'No usable POSTGRES_URL_NON_POOLING/POSTGRES_URL in this environment',
    });
  }

  // pg (>=8.11) lets an sslmode in the connection string win over the ssl
  // option, which resurfaces "self-signed certificate in certificate chain".
  let cleanConn = conn;
  try {
    const u = new URL(conn);
    u.searchParams.delete('sslmode');
    cleanConn = u.toString();
  } catch { /* not URL-parseable: fall back to the raw string */ }

  const client = new Client({ connectionString: cleanConn, ssl: { rejectUnauthorized: false } });
  const applied = [];
  try {
    await client.connect();
    for (const sql of STATEMENTS) {
      await client.query(sql);
      applied.push(sql.trim().split('\n')[0].trim().slice(0, 90));
    }

    // Prove the schema exists rather than trusting that the DDL "succeeded".
    const tables = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND table_name IN ('video_comment_automations','comment_dm_leads','social_comment_replies')
        ORDER BY table_name`,
    );
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='social_comment_replies'
          AND column_name IN ('account_id','escalated','thread_status','ingested_at')
        ORDER BY column_name`,
    );
    const vcols = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='video_library'
          AND column_name IN ('dm_keyword','dm_asset_url','dm_message','dm_target_posts')
        ORDER BY column_name`,
    );
    const flags = await client.query(
      `SELECT key, enabled FROM public.ops_flags WHERE key LIKE 'zernio_comment%' ORDER BY key`,
    );

    return res.status(200).json({
      ok: true,
      statements_applied: applied.length,
      tables_present: tables.rows.map((r) => r.table_name),
      social_comment_replies_columns: cols.rows.map((r) => r.column_name),
      video_library_columns: vcols.rows.map((r) => r.column_name),
      flags: flags.rows,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message, applied });
  } finally {
    await client.end().catch(() => {});
  }
};
