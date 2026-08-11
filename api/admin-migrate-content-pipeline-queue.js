// One-time migration: create public.content_pipeline_queue (nightly content
// pipeline pending-review table). Safe to re-run -- CREATE TABLE/INDEX IF NOT
// EXISTS throughout, no data touched.
//
// DDL isn't reachable through PostgREST (no generic SQL-exec RPC deployed on
// this project), so this runs directly against Postgres via the shared
// api/_lib/pg-admin.js helper (POSTGRES_URL_NON_POOLING, bypasses PgBouncer --
// safer for DDL than the pooled POSTGRES_URL). Mirrors the SQL tracked at
// supabase/migrations/20260811_content_pipeline_queue.sql and the exact
// pattern of api/admin-migrate-agent-queue-business-line.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-11 (SV-ENG-NIGHTLY-CONTENT-PIPELINE)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS content_pipeline_queue (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  night_batch_id        TEXT NOT NULL,
  page_type             TEXT NOT NULL
                        CHECK (page_type IN ('guide', 'feature', 'answer')),
  topic                 TEXT NOT NULL CHECK (length(topic) <= 300),
  slug                  TEXT,
  status                TEXT NOT NULL DEFAULT 'researching'
                        CHECK (status IN (
                          'researching', 'pending_review', 'approved',
                          'rejected', 'promoted', 'failed'
                        )),
  json_data             JSONB,
  sources               JSONB NOT NULL DEFAULT '[]'::jsonb,
  excerpt               TEXT,
  generation_task_id    UUID REFERENCES agent_queue(id) ON DELETE SET NULL,
  promote_task_id       UUID REFERENCES agent_queue(id) ON DELETE SET NULL,
  rejection_reason      TEXT,
  error                 TEXT,
  telegram_sent_at      TIMESTAMPTZ,
  telegram_message_id   BIGINT,
  reviewed_at           TIMESTAMPTZ,
  promoted_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_pipeline_queue_status
  ON content_pipeline_queue (status, created_at);

CREATE INDEX IF NOT EXISTS idx_content_pipeline_queue_pending_review
  ON content_pipeline_queue (telegram_sent_at)
  WHERE status = 'pending_review';

CREATE INDEX IF NOT EXISTS idx_content_pipeline_queue_approved
  ON content_pipeline_queue (status)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_content_pipeline_queue_type_slug
  ON content_pipeline_queue (page_type, slug);

CREATE INDEX IF NOT EXISTS idx_content_pipeline_queue_batch
  ON content_pipeline_queue (night_batch_id);

ALTER TABLE content_pipeline_queue ENABLE ROW LEVEL SECURITY;
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
      message: 'content_pipeline_queue table + indexes created successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to create content_pipeline_queue',
      details: err.message,
    });
  }
};
