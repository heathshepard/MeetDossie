'use strict';

// One-time migration: enable RLS on listing_marketing_status +
// listing_marketing_rotation. Both shipped with RLS disabled in
// 20260910b_listing_marketing_pipeline.sql -- anon key had full
// SELECT/INSERT/UPDATE/DELETE via Supabase's default public-schema grants.
// DDL isn't reachable through PostgREST -- runs directly against Postgres
// via api/_lib/pg-admin.js (POSTGRES_URL_NON_POOLING), same pattern as
// api/admin-migrate-comment-opportunities.js.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-or-prod>/api/admin-migrate-listing-marketing-rls
//
// Mirrors supabase/migrations/20260911_listing_marketing_rls.sql -- see
// that file for the full audit of every reader/writer (all service-role or
// direct-Postgres, none use the anon key, so RLS-enable-with-no-policies
// is correct and safe). Safe to re-run -- ENABLE ROW LEVEL SECURITY is
// idempotent.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-11

const { runAdminSql } = require('./_lib/pg-admin');

const CRON_SECRET = process.env.CRON_SECRET;

const SQL = `
ALTER TABLE public.listing_marketing_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_marketing_rotation ENABLE ROW LEVEL SECURITY;
`;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    await runAdminSql(SQL);
    return res.status(200).json({ ok: true, migrated: 'RLS enabled on listing_marketing_status + listing_marketing_rotation, no policies (service-role/admin-only access)' });
  } catch (err) {
    console.error('[admin-migrate-listing-marketing-rls]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
