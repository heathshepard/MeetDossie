// One-time migration: offers model additive pieces — see
// supabase/migrations/20260921_offers_model_additive.sql for full
// commentary (the DDL is duplicated here verbatim; that file is the
// documented source, this is what actually runs — same split as the other
// admin-migrate-*.js files in this repo).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-21 (offers model, item 2 — additive schema).

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.transaction_offers
  ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS retired_reason TEXT,
  ADD COLUMN IF NOT EXISTS applied_to_transaction_at TIMESTAMPTZ;

COMMENT ON COLUMN public.transaction_offers.accepted_at IS
  'When this offer''s status became ''accepted'' AND its terms were copied onto transactions.';
COMMENT ON COLUMN public.transaction_offers.retired_at IS
  'When an ACCEPTED offer later fell through. Status moves to ''retired'', never deleted.';
COMMENT ON COLUMN public.transaction_offers.retired_reason IS
  'Free text reason for retirement.';
COMMENT ON COLUMN public.transaction_offers.applied_to_transaction_at IS
  'The moment this offer''s terms were written onto the parent transactions row''s flat columns.';

CREATE INDEX IF NOT EXISTS transaction_offers_status_idx ON public.transaction_offers (status);

CREATE TABLE IF NOT EXISTS public.offer_field_snapshots (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id       UUID NOT NULL REFERENCES public.transaction_offers(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  field_name     TEXT NOT NULL,
  prior_value    TEXT,
  new_value      TEXT
);

CREATE INDEX IF NOT EXISTS offer_field_snapshots_offer_idx ON public.offer_field_snapshots (offer_id);
CREATE INDEX IF NOT EXISTS offer_field_snapshots_transaction_idx ON public.offer_field_snapshots (transaction_id, captured_at DESC);

ALTER TABLE public.offer_field_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read" ON public.offer_field_snapshots;
CREATE POLICY "owner_read"   ON public.offer_field_snapshots
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_all" ON public.offer_field_snapshots;
CREATE POLICY "service_all"  ON public.offer_field_snapshots
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.offer_field_snapshots IS
  'Rule C revert mechanism: per-field before/after values captured the moment an offer''s terms are copied onto transactions.';

CREATE TABLE IF NOT EXISTS public.document_offer_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  offer_id    UUID NOT NULL REFERENCES public.transaction_offers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, offer_id)
);

CREATE INDEX IF NOT EXISTS document_offer_links_document_idx ON public.document_offer_links (document_id);
CREATE INDEX IF NOT EXISTS document_offer_links_offer_idx ON public.document_offer_links (offer_id);

ALTER TABLE public.document_offer_links ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner_read" ON public.document_offer_links;
CREATE POLICY "owner_read"   ON public.document_offer_links
  FOR SELECT USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "service_all" ON public.document_offer_links;
CREATE POLICY "service_all"  ON public.document_offer_links
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE public.document_offer_links IS
  'Which documents belong to which offer''s paper trail. Absence of a row = property-level document that survives every offer.';
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
      message: 'transaction_offers retirement columns + offer_field_snapshots + document_offer_links added successfully',
    });
  } catch (err) {
    const status = err.message === 'postgres_connection_env_missing' ? 503 : 500;
    return res.status(status).json({
      ok: false,
      error: 'Failed to add offers-model additive schema',
      details: err.message,
    });
  }
};
