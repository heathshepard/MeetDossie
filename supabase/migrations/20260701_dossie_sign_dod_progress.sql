-- ============================================================================
-- dossie_sign_dod_progress + dossie_sign_dod_runs
--
-- Ridge, 2026-07-01 — Dossie Sign dedicated 20-min completion loop.
--
-- Every 20 minutes cron-dossie-sign-completion-loop.js:
--   1. Reads state from dossie_sign_dod_progress (8 forms x 9 gates = 72 rows)
--   2. Reads latest Hadley PASS reports (docs/hadley-pass-report-trec-*-*.md)
--   3. Reads latest Atlas E2E test results (agent_queue rows + jarvis_future_builds)
--   4. Picks the ONE lowest-hanging red gate (weighted: broken customer-facing >
--      multi-signer > audit trail > cosmetic)
--   5. Dispatches to the right agent via agent_queue
--   6. Logs the tick to dossie_sign_dod_runs
--   7. If all 72 rows green → celebration ping + exit
--
-- This is SEPARATE from cron-autonomous-loop (which runs every 4h and covers
-- everything else). The general loop consumes signals from this table so it
-- does NOT dispatch Dossie-Sign-related work while this loop is active.
--
-- Definition of Done — 9 gates per form:
--   1. fill_accuracy         — Hadley PASS on rendered PDF
--   2. hadley_signed_pass    — signed report on file
--   3. send_button_works     — "Send for signature" button fires from app
--   4. multi_signer          — buyer + seller + co-buyer + co-seller
--   5. signer_email_collect  — collection UI works per form type
--   6. envelope_status       — status shows in customer dashboard
--   7. audit_trail           — Certificate of Completion (signer/time/IP/hash)
--   8. signed_pdf_stored     — retrievable from Storage permanently
--   9. real_deal_closed      — Brittney (or founder) closes end-to-end
--                              (human-gated — loop cannot flip this alone)
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Per-form per-gate status
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dossie_sign_dod_progress (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Form identity
  docuseal_template_id   TEXT NOT NULL,     -- '4018208', '4023463', etc.
  form_code              TEXT NOT NULL,     -- 'TREC-20-18', 'TREC-40-11', etc.
  form_label             TEXT NOT NULL,     -- human-readable form name

  -- Gate identity
  gate_key               TEXT NOT NULL,     -- 'fill_accuracy' | 'hadley_signed_pass' |
                                            -- 'send_button_works' | 'multi_signer' |
                                            -- 'signer_email_collect' | 'envelope_status' |
                                            -- 'audit_trail' | 'signed_pdf_stored' |
                                            -- 'real_deal_closed'
  gate_label             TEXT NOT NULL,     -- human-readable gate name
  gate_weight            NUMERIC NOT NULL DEFAULT 50,   -- higher = pick first
                                            -- 100 = broken customer-facing flow
                                            --  80 = multi-signer
                                            --  60 = audit trail
                                            --  40 = fill accuracy
                                            --  20 = cosmetic
                                            -- 999 = human-gated (real_deal_closed)

  -- Status
  status                 TEXT NOT NULL DEFAULT 'red',   -- 'red' | 'yellow' | 'green'
  last_checked_at        TIMESTAMPTZ,
  last_evidence          TEXT,              -- pointer to Hadley report, screenshot, etc.
  last_evidence_meta     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Loop dispatch tracking (per gate)
  last_dispatched_at     TIMESTAMPTZ,
  last_dispatched_agent  TEXT,              -- 'carter' | 'atlas' | 'hadley' | 'quinn'
  last_dispatched_queue_id UUID,            -- soft FK to agent_queue.id
  dispatch_count         INTEGER NOT NULL DEFAULT 0,
  cooldown_until         TIMESTAMPTZ,       -- prevents re-dispatch every 20min

  -- Human-gated flag — loop cannot flip these to green on its own
  human_gated            BOOLEAN NOT NULL DEFAULT FALSE,

  -- Notes
  notes                  TEXT,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (docuseal_template_id, gate_key)
);

CREATE INDEX IF NOT EXISTS idx_dossie_sign_dod_progress_status
  ON public.dossie_sign_dod_progress (status, gate_weight DESC);

CREATE INDEX IF NOT EXISTS idx_dossie_sign_dod_progress_form
  ON public.dossie_sign_dod_progress (form_code);

CREATE INDEX IF NOT EXISTS idx_dossie_sign_dod_progress_cooldown
  ON public.dossie_sign_dod_progress (cooldown_until)
  WHERE cooldown_until IS NOT NULL;

COMMENT ON TABLE public.dossie_sign_dod_progress IS
  'Dossie Sign Definition of Done: 8 forms x 9 gates = 72 rows. Loop reads this to pick the lowest-hanging red. Green everywhere = mission complete.';

ALTER TABLE public.dossie_sign_dod_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_dossie_sign_dod_progress"
  ON public.dossie_sign_dod_progress;
CREATE POLICY "service_role_all_dossie_sign_dod_progress"
  ON public.dossie_sign_dod_progress
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Anon read for the admin dashboard (safe — no PII, aggregated status only).
-- Dashboard uses anon key from client; that's the ONLY read path.
DROP POLICY IF EXISTS "anon_read_dossie_sign_dod_progress"
  ON public.dossie_sign_dod_progress;
CREATE POLICY "anon_read_dossie_sign_dod_progress"
  ON public.dossie_sign_dod_progress
  FOR SELECT
  USING (true);

-- ────────────────────────────────────────────────────────────────────────────
-- Per-tick run log
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.dossie_sign_dod_runs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- What we snapshotted at tick start
  total_gates            INTEGER NOT NULL DEFAULT 0,
  green_count            INTEGER NOT NULL DEFAULT 0,
  yellow_count           INTEGER NOT NULL DEFAULT 0,
  red_count              INTEGER NOT NULL DEFAULT 0,

  -- What we picked
  picked_form_code       TEXT,
  picked_gate_key        TEXT,
  picked_gate_weight     NUMERIC,
  picked_reason          TEXT,

  -- Who we dispatched to
  agent_dispatched       TEXT,
  queue_id               UUID,
  future_build_id        UUID,

  -- Outcome
  outcome                TEXT NOT NULL,      -- 'dispatched' | 'skipped_all_green'
                                             -- | 'skipped_cooldown' | 'skipped_human_gated'
                                             -- | 'skipped_guardrail' | 'skipped_no_red'
                                             -- | 'error'
  outcome_reason         TEXT,
  duration_ms            INTEGER,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_dossie_sign_dod_runs_ts
  ON public.dossie_sign_dod_runs (run_ts DESC);

CREATE INDEX IF NOT EXISTS idx_dossie_sign_dod_runs_outcome
  ON public.dossie_sign_dod_runs (outcome, run_ts DESC);

COMMENT ON TABLE public.dossie_sign_dod_runs IS
  'One row per 20-min Dossie Sign loop tick. Signal in, dispatch out. Daily digest reads this.';

ALTER TABLE public.dossie_sign_dod_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_all_dossie_sign_dod_runs"
  ON public.dossie_sign_dod_runs;
CREATE POLICY "service_role_all_dossie_sign_dod_runs"
  ON public.dossie_sign_dod_runs
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "anon_read_dossie_sign_dod_runs"
  ON public.dossie_sign_dod_runs;
CREATE POLICY "anon_read_dossie_sign_dod_runs"
  ON public.dossie_sign_dod_runs
  FOR SELECT
  USING (true);

-- ────────────────────────────────────────────────────────────────────────────
-- Seed the 8 forms x 9 gates = 72 rows
--
-- Per project_docuseal_template_ids.md — Heath's canonical mapping.
-- All gates start 'red' except placeholders; loop will flip to green as
-- evidence lands.
-- ────────────────────────────────────────────────────────────────────────────

WITH forms(docuseal_template_id, form_code, form_label) AS (
  VALUES
    ('4018208', 'TREC-20-18', 'TREC 20-18 One to Four Family Residential Contract (Resale)'),
    ('4023463', 'TREC-40-11', 'TREC 40-11 Third Party Financing Addendum'),
    ('4023472', 'TREC-49-1',  'TREC 49-1 Right to Terminate Due to Lender''s Appraisal'),
    ('4023470', 'TREC-OP-H',  'Seller''s Disclosure Notice (TREC OP-H equivalent)'),
    ('4111321', 'TREC-36-11', 'TREC 36-11 HOA Addendum'),
    ('4111320', 'TREC-39-10', 'TREC 39-10 Amendment to Contract'),
    ('4023578', 'TREC-11-7',  'TREC 11-7 Backup Contract Addendum'),
    ('4023469', 'TREC-OP-L',  'OP-L Lead-Based Paint Addendum')
),
gates(gate_key, gate_label, gate_weight, human_gated) AS (
  VALUES
    ('fill_accuracy',        'Fill accuracy on rendered PDF',                 40::numeric, false),
    ('hadley_signed_pass',   'Hadley signed PASS report on file',             60::numeric, false),
    ('send_button_works',    '"Send for signature" button works from app',   100::numeric, false),
    ('multi_signer',         'Buyer + seller + co-buyer + co-seller work',    80::numeric, false),
    ('signer_email_collect', 'Signer email-collection screen works',          80::numeric, false),
    ('envelope_status',      'Envelope status shows in customer dashboard',   60::numeric, false),
    ('audit_trail',          'Certificate of Completion — signer/time/IP',    60::numeric, false),
    ('signed_pdf_stored',    'Signed PDFs stored permanently, retrievable',   60::numeric, false),
    ('real_deal_closed',     'Real deal end-to-end (Brittney or founder)',   999::numeric, true)
)
INSERT INTO public.dossie_sign_dod_progress
  (docuseal_template_id, form_code, form_label, gate_key, gate_label, gate_weight, human_gated, status)
SELECT
  f.docuseal_template_id,
  f.form_code,
  f.form_label,
  g.gate_key,
  g.gate_label,
  g.gate_weight,
  g.human_gated,
  'red'
FROM forms f CROSS JOIN gates g
ON CONFLICT (docuseal_template_id, gate_key) DO NOTHING;
