-- telegram_gate_suppressions
--
-- WHY: api/_lib/telegram-gate.js has silently swallowed real sends TWICE
-- (cron-social-digest missing an ALWAYS_ALLOW entry for a month from
-- 2026-08-16; cron-tc-reply-approval's sends hidden by a job-name collision
-- from ~2026-09-12), both invisible until Heath noticed the SYMPTOM, not the
-- cause. The gate already marks a suppressed send as non-delivered in its
-- own response (delivered:false/suppressed:true) so a caller that checks can
-- tell -- but nothing durable recorded WHICH job got eaten, so there was
-- nowhere to look and nothing to alarm on. This table is that record.
--
-- Append-only, written by api/_lib/telegram-gate.js's gatedFetch on every
-- suppressed send (best-effort -- a logging failure must never block or
-- throw inside the fetch wrapper). Read by api/_lib/silence-alarm.js's
-- checkTelegramGateSuppressionSilence() to alarm when a job keeps trying to
-- reach Heath and never gets through.
--
-- Owner: Carter, 2026-09-18
--
-- KNOWN DRIFT (found by Quinn QA, 2026-09-18, staging 816ccd57): the live
-- table's `id` column is actually a plain integer identity/sequence, not the
-- UUID this file declares below. The table already existed (created ad hoc,
-- before this migration file was written) when this CREATE TABLE IF NOT
-- EXISTS ran, so Postgres silently no-op'd the whole statement against the
-- live schema -- this file has never actually taken effect for that column.
-- Left as-is rather than reconciled: nothing in the codebase reads
-- telegram_gate_suppressions.id (job_name + created_at is the only lookup
-- key anything uses -- see the index below and silence-alarm.js's reader),
-- so the mismatch is harmless today, and an ALTER TABLE to convert a live
-- production column's type/default is a real-risk migration to run just to
-- make a comment-and-code-match exercise -- not worth it for a column
-- nothing depends on. If anything ever needs telegram_gate_suppressions.id
-- as a foreign key or an external reference, reconcile then, for real, with
-- a proper ALTER TABLE migration -- not by editing this file to match.

CREATE TABLE IF NOT EXISTS public.telegram_gate_suppressions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name     TEXT NOT NULL,
  method       TEXT,
  chat_id      TEXT,
  text_preview TEXT,
  mode         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_gate_suppressions_job_time
  ON public.telegram_gate_suppressions (job_name, created_at DESC);

COMMENT ON TABLE public.telegram_gate_suppressions IS
  'Append-only log of every Telegram send api/_lib/telegram-gate.js ate instead of delivering -- job_name, method, chat_id, a short text preview, and the TELEGRAM_CRON_NOTIFICATIONS mode active at the time. Written best-effort from the fetch wrapper (a log-write failure never blocks the caller). Queried by silence-alarm.js to catch a job whose sends are being silently eaten for an unusual stretch -- the exact failure class that hid cron-social-digest for a month and cron-tc-reply-approval for ~2 weeks. Added 2026-09-18.';

-- Same RLS posture as the sibling ops tables (telegram_send_log,
-- weekly_digest_surfaces, alert_state, see 20260914_telegram_alerts_rls.sql):
-- global operational log, no user_id/tenant column, holds no customer PII
-- (job names + Heath's own message previews) -- but the anon key is public
-- by design, so RLS goes on from creation with no matching policy for
-- anon/authenticated. Every real writer (telegram-gate.js) and reader
-- (silence-alarm.js) uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS
-- regardless of policy.
ALTER TABLE public.telegram_gate_suppressions ENABLE ROW LEVEL SECURITY;
