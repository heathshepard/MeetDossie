-- ============================================================================
-- ops_flags -- shared kill-switch/settings table, replacing local JSON state
-- files for any flag that a LOCAL script/toggle needs to control and a
-- VERCEL serverless cron needs to read.
--
-- WHY (bug found 2026-09-16): scripts/_lib/auto-reply-kill-switch.js stored
-- its on/off state in scripts/.auto-reply-kill-switch.json -- a file on
-- whatever machine ran `node scripts/toggle-auto-reply.js`. Its real
-- consumers, api/cron-tc-reply-approval.js and
-- api/cron-auto-reply-veto-check.js, run on Vercel, where that path never
-- exists. Flipping the switch locally had ZERO effect on production.
-- Confirmed NOT a live safety hole: the loader's catch-all on a missing file
-- already returned { enabled: false } (fail-closed by construction), so
-- auto-reply has been effectively OFF in production the whole time -- but
-- there was also no way to ever turn it ON in prod. This table is the fix:
-- ONE row per flag, in the SAME Supabase project both local scripts and
-- Vercel functions already talk to via SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
--
-- Fail-closed contract (enforced in code, not just by DEFAULT false): an
-- unreadable table, a missing row, a network error, or a malformed value all
-- resolve to enabled=false in scripts/_lib/auto-reply-kill-switch.js. Never
-- fail open.
--
-- Owner: Carter, 2026-09-16 (SV-ENG-AUTO-REPLY-FLAG-SPLIT-BRAIN)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ops_flags (
  key         TEXT PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  reason      TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT
);

COMMENT ON TABLE public.ops_flags IS
  'Shared on/off flags read by both local scripts (via node scripts/toggle-*.js) and Vercel serverless crons -- the single source of truth so a local-only state file can never diverge from what production reads. Defaults OFF (missing row/table = disabled everywhere, enforced in the reading code as well as the DEFAULT here).';
COMMENT ON COLUMN public.ops_flags.key IS
  'Flag name, e.g. ''auto_reply'' for the auto-reply-with-veto kill switch (scripts/_lib/auto-reply-kill-switch.js).';
COMMENT ON COLUMN public.ops_flags.reason IS
  'Free-text note on why the flag was last flipped, shown by the toggle script''s `status` command.';
COMMENT ON COLUMN public.ops_flags.updated_by IS
  'Who/what flipped it last -- e.g. ''toggle-auto-reply.js'' or a cron falling back to manual review.';

-- Seed the auto-reply flag explicitly OFF (ship-time requirement -- Heath
-- must explicitly turn this on after a Quinn QA pass). ON CONFLICT no-op so
-- re-running this migration never clobbers a value someone already set.
INSERT INTO public.ops_flags (key, enabled, reason, updated_by)
VALUES ('auto_reply', FALSE, 'initial migration -- ships OFF', 'migration:20260916c_ops_flags')
ON CONFLICT (key) DO NOTHING;

-- Same RLS pattern as telegram_send_log/weekly_digest_surfaces/alert_state
-- (20260914_telegram_alerts_rls.sql): enable RLS, ZERO policies. Every real
-- caller (crons + local scripts) uses SUPABASE_SERVICE_ROLE_KEY, which
-- bypasses RLS regardless of policies -- so every real caller keeps working
-- unchanged, while anon/authenticated default to deny-all. This table holds
-- no customer/PII data, but a public on/off switch for an auto-posting
-- feature is exactly the kind of thing that should never be anon-writable.
ALTER TABLE public.ops_flags ENABLE ROW LEVEL SECURITY;
