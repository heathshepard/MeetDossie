// One-time migration: add public.jarvis_todos.attachments (JSONB array) —
// see supabase/migrations/20260827_jarvis_todos_attachments.sql for full
// commentary. Safe to re-run — ADD COLUMN IF NOT EXISTS, no data touched.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-08-27 (SV-ENG-JARVIS-TODO-ATTACHMENTS)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.jarvis_todos
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.jarvis_todos.attachments IS
  'Array of file attachments (video/screenshot/PDF/etc) proving/showing a completed deliverable for this to-do item. Same shape as jarvis-bridge chat-message attachments: [{name, url, media_type, kind: image|pdf|video|file, size, uploaded_at}]. Written by scripts/jarvis-todo-attach-file.js (uploads to the jarvis-attachments Storage bucket under todos/<todo_id>/, then PATCHes this column). Rendered by renderJarvisTodos() via the shared renderMessageAttachments() helper in jarvis-pwa.html.';
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
      message: 'jarvis_todos.attachments column added (or already existed)',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add jarvis_todos.attachments',
      details: err.message,
    });
  }
};
