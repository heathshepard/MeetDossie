-- 20260612_ridge_kpi_and_digest.sql
-- Ridge (Head of Reliability & Observability) week-1 ship:
--   - kpi_snapshots: daily metric snapshot used by cron-kpi-drift-detector for week-over-week drift alerts.
--   - customer_view_digests: log of Monday "Heath sees what customers see" screenshot batches.

CREATE TABLE IF NOT EXISTS kpi_snapshots (
  id BIGSERIAL PRIMARY KEY,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start TIMESTAMPTZ,
  window_end TIMESTAMPTZ,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kpi_snapshots_taken_at ON kpi_snapshots(taken_at DESC);

CREATE TABLE IF NOT EXISTS customer_view_digests (
  id BIGSERIAL PRIMARY KEY,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  urls TEXT[] NOT NULL,
  screenshot_paths JSONB NOT NULL DEFAULT '{}'::jsonb,
  email_status TEXT,
  email_id TEXT,
  errors JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_view_digests_taken_at ON customer_view_digests(taken_at DESC);
