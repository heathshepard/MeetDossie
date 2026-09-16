'use strict';

// One-time migration: add the model-verdict diagnostic columns to
// public.tc_discovery_responses. Full design commentary in
// supabase/migrations/20260916b_auto_reply_model_verdict.sql (keep the
// two in sync).
//
// Safe to re-run — ADD COLUMN IF NOT EXISTS.
//
// This route exists because POSTGRES_URL_NON_POOLING is a write-only
// ("Sensitive") Vercel var, so DDL cannot be run from a local shell — same
// reason the admin-migrate-* siblings exist.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Atlas, 2026-09-16 (staging->main merge, model-based auto-reply
// classifier)

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.tc_discovery_responses
  ADD COLUMN IF NOT EXISTS auto_reply_confidence TEXT
    CHECK (auto_reply_confidence IN ('high','medium','low') OR auto_reply_confidence IS NULL),
  ADD COLUMN IF NOT EXISTS auto_reply_reason TEXT,
  ADD COLUMN IF NOT EXISTS auto_reply_source TEXT
    CHECK (auto_reply_source IN ('pre_filter','model','model_error') OR auto_reply_source IS NULL);

COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_confidence IS
  'Confidence the classifier (pre-filter or model) attached to its verdict. eligible=true only ever survives to auto_reply_eligible when this is "high" — see classifyCommentRisk() in scripts/_lib/auto-reply-risk-classifier.js.';
COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_reason IS
  'One-line human-readable reason from the classifier (the model''s own explanation, or the specific pre-filter/fail-closed path that fired). Read this before trusting or disputing any auto_reply_category value.';
COMMENT ON COLUMN public.tc_discovery_responses.auto_reply_source IS
  'Which code path produced the verdict: pre_filter (hard $-figure/demo-word match, never eligible), model (a real Claude Haiku 4.5 classification), or model_error (API key missing, network/timeout failure, or a malformed/unparseable response — always eligible=false, fail-closed).';
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, message: 'tc_discovery_responses model-verdict columns ready' });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({ ok: false, error: 'Failed to migrate tc_discovery_responses', details: err.message });
  }
};
