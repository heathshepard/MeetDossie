'use strict';

// TEMPORARY read/write admin endpoint — silence-alarm backlog cleanup
// (Carter, 2026-09-16). Same connection pattern as api/_lib/pg-admin.js.
// Used to inspect + resolve the three backlog problems the first real
// silence-alarm firing surfaced:
//   1. group_posts drafts >24h old never sent to Telegram
//   2. group_posts approved >48h old never posted
//   3. social_posts instagram/tiktok pending_video + video_failed dead rows
//      from the retired per-post Creatomate path
//
// Remove this file once the backlog is resolved and verified.
//
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     "https://<preview>/api/admin-fix-silence-backlog-2026-09-16?mode=inspect"
//
// Owner: Carter, 2026-09-16

const { Client } = require('pg');

const CRON_SECRET = process.env.CRON_SECRET;
const CONNECTION_STRING = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;

const ALLOWED_TABLES = new Set(['group_posts', 'social_posts']);
// 'skipped' for group_posts (matches scripts/regression-group-post-pipeline.js
// precedent), 'rejected' for social_posts (matches
// api/cron-sage-autonomous-review.js's own hard-reject convention — same
// rejection_reason column on both tables).
const ALLOWED_STATUSES = new Set(['skipped', 'rejected']);

async function withClient(fn) {
  const prevTlsFlag = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const client = new Client({
    connectionString: CONNECTION_STRING,
    ssl: { rejectUnauthorized: false, require: true },
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTlsFlag;
  }
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!CONNECTION_STRING) {
    return res.status(500).json({ ok: false, error: 'postgres_connection_env_missing' });
  }

  const mode = (req.query && req.query.mode) || 'inspect';

  try {
    if (mode === 'schema') {
      const result = await withClient(async (client) => {
        const cols = await client.query(
          `select table_name, column_name, data_type
           from information_schema.columns
           where table_schema='public' and table_name = ANY($1)
           order by table_name, ordinal_position`,
          [['group_posts', 'social_posts']],
        );
        return cols.rows;
      });
      return res.status(200).json({ ok: true, columns: result });
    }

    if (mode === 'inspect') {
      const result = await withClient(async (client) => {
        const staleDrafts = await client.query(
          `select id, group_name, group_url, category, pipeline, status,
                  telegram_sent_at, created_at, left(post_body, 200) as body_preview
           from public.group_posts
           where status = 'draft' and telegram_sent_at is null
             and created_at < now() - interval '24 hours'
           order by created_at asc`,
        );
        const staleApproved = await client.query(
          `select id, group_name, group_url, category, pipeline, status,
                  approved_at, posted_at, created_at, left(post_body, 200) as body_preview
           from public.group_posts
           where status = 'approved' and approved_at < now() - interval '48 hours'
           order by approved_at asc`,
        );
        const deadRows = await client.query(
          `select id, platform, target_owner, status, created_at, updated_at
           from public.social_posts
           where platform in ('instagram','tiktok')
             and status in ('pending_video','video_failed')
           order by platform, status, created_at asc`,
        );
        const deadCounts = await client.query(
          `select platform, status, count(*)::int as n
           from public.social_posts
           where platform in ('instagram','tiktok')
             and status in ('pending_video','video_failed')
           group by platform, status
           order by platform, status`,
        );
        return {
          stale_drafts: staleDrafts.rows,
          stale_approved: staleApproved.rows,
          dead_rows: deadRows.rows,
          dead_counts: deadCounts.rows,
        };
      });
      return res.status(200).json({ ok: true, ...result });
    }

    if (mode === 'apply') {
      if (req.method !== 'POST') {
        return res.status(405).json({ ok: false, error: 'apply requires POST' });
      }
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { body = {}; }
      }
      body = body || {};
      const table = body.table;
      const status = body.status;
      const reason = body.reason;
      const ids = Array.isArray(body.ids) ? body.ids : [];
      const extraColumn = 'rejection_reason';

      if (!ALLOWED_TABLES.has(table)) {
        return res.status(400).json({ ok: false, error: `table not allowed: ${table}` });
      }
      if (!ALLOWED_STATUSES.has(status)) {
        return res.status(400).json({ ok: false, error: `status not allowed: ${status}` });
      }
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'ids required' });
      }
      if (!reason || typeof reason !== 'string') {
        return res.status(400).json({ ok: false, error: 'reason required' });
      }

      const result = await withClient(async (client) => {
        let updated;
        if (extraColumn) {
          updated = await client.query(
            `update public.${table}
             set status = $1, ${extraColumn} = $2, updated_at = now()
             where id = ANY($3)
             returning id`,
            [status, reason, ids],
          );
        } else {
          updated = await client.query(
            `update public.${table}
             set status = $1, updated_at = now()
             where id = ANY($2)
             returning id`,
            [status, ids],
          );
        }
        return updated.rows;
      });
      return res.status(200).json({ ok: true, table, status, updated_count: result.length, updated_ids: result.map((r) => r.id) });
    }

    return res.status(400).json({ ok: false, error: `unknown mode: ${mode}` });
  } catch (err) {
    console.error('[admin-fix-silence-backlog-2026-09-16]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
