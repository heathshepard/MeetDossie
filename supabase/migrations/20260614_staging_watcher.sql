-- ============================================================================
-- staging_watch_state — Carter staging-push watcher state
--
-- Single-row table tracking the last-seen Carter staging commit SHA on
-- origin/staging. The cron-staging-watcher polls GitHub every ~2 min, and when
-- it finds a NEW commit not yet seen, it auto-spawns Quinn via agent_requests
-- + auto-fires the Dossie QA loop + Telegram-pings Heath.
--
-- Purpose: kill the Cole-as-bottleneck pattern. Heath sees Carter ship →
-- Quinn auto-runs → his merge decision. Cole standing by, not in the critical
-- path.
--
-- Schema:
--   id                          uuid (PK)
--   last_seen_sha               text   — most recent staging HEAD we've processed
--   last_seen_commit_message    text   — the commit's first line
--   last_seen_author            text   — committer's name (we treat Carter as
--                                        anything authored by heathshepard or
--                                        "Heath Shepard" — Carter pushes are
--                                        always Heath's git identity)
--   last_seen_committed_at      timestamptz — commit time per GitHub
--   last_quinn_dispatch_at      timestamptz — when we last dispatched Quinn
--   last_qa_loop_fire_at        timestamptz — when we last fired cron-dossie-qa-loop
--   last_polled_at              timestamptz — every poll updates this
--   poll_count                  bigint      — running counter
--   updated_at                  timestamptz — auto-updated
--
-- RLS: DISABLED — service-role-only. The watcher is the only writer.
-- Reads from cron-staging-watcher + ventures reliability dashboard.
--
-- Owner: Ridge (SV-ENG-STAGING-WATCHER / 2026-06-14)
-- ============================================================================

CREATE TABLE IF NOT EXISTS staging_watch_state (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  last_seen_sha            TEXT,
  last_seen_commit_message TEXT,
  last_seen_author         TEXT,
  last_seen_committed_at   TIMESTAMPTZ,
  last_quinn_dispatch_at   TIMESTAMPTZ,
  last_qa_loop_fire_at     TIMESTAMPTZ,
  last_polled_at           TIMESTAMPTZ,
  poll_count               BIGINT NOT NULL DEFAULT 0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enforce single-row pattern via a partial unique index on a constant column.
-- (We bootstrap by inserting one row and updating it forever.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_watch_state_singleton
  ON staging_watch_state ((1));

-- Bootstrap the singleton row if it doesn't exist yet.
INSERT INTO staging_watch_state (last_seen_sha)
SELECT NULL
WHERE NOT EXISTS (SELECT 1 FROM staging_watch_state);

-- Audit trail of every Carter staging push detected (for the reliability
-- dashboard + post-mortem when something slips through QA).
CREATE TABLE IF NOT EXISTS staging_push_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  commit_sha          TEXT NOT NULL,
  commit_message      TEXT,
  commit_author       TEXT,
  committed_at        TIMESTAMPTZ,
  quinn_dispatched    BOOLEAN NOT NULL DEFAULT FALSE,
  quinn_request_id    TEXT,
  qa_loop_fired       BOOLEAN NOT NULL DEFAULT FALSE,
  qa_loop_status      TEXT,
  telegram_sent       BOOLEAN NOT NULL DEFAULT FALSE,
  telegram_message_id BIGINT,
  metadata            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_staging_push_events_detected_at
  ON staging_push_events (detected_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staging_push_events_commit_sha
  ON staging_push_events (commit_sha);

COMMENT ON TABLE staging_watch_state IS
  'SV-ENG-STAGING-WATCHER — Ridge 2026-06-14. Singleton row tracking the last Carter staging commit the watcher has seen. cron-staging-watcher polls GitHub origin/staging every ~2 min.';

COMMENT ON TABLE staging_push_events IS
  'SV-ENG-STAGING-WATCHER — Ridge 2026-06-14. One row per detected new staging commit. Records Quinn auto-dispatch + QA loop fire + Telegram notify outcomes.';
