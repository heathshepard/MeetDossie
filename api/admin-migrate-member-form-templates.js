// One-time migration: create member_form_templates — see
// supabase/migrations/20260921_member_form_templates.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21.

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
CREATE TABLE IF NOT EXISTS public.member_form_templates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  description  TEXT,
  file_name    TEXT,
  file_type    TEXT,
  file_size    BIGINT,
  storage_path TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS member_form_templates_user_idx ON public.member_form_templates (user_id, created_at DESC);

ALTER TABLE public.member_form_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_all" ON public.member_form_templates;
CREATE POLICY "owner_all" ON public.member_form_templates
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_all" ON public.member_form_templates;
CREATE POLICY "service_all" ON public.member_form_templates
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.member_form_templates IS
  'A member''s own brokerage/standard PDF forms — stored once, attachable and sendable on any dossier. Per-member, mirrors form_packages.user_id.';
`;

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'member_form_templates created successfully' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to create member_form_templates', details: err.message });
  }
};
