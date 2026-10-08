'use strict';

// api/cron-sync-comment-dm-leads.js
// =============================================================================
// LEAD CAPTURE. Pulls every comment-to-DM trigger out of Zernio and records
// who asked, what they asked for, and which video earned it.
//
// "A DM'd asset is worthless if we don't record who asked. That's the list."
//
// Source: GET /v1/comment-automations/{id}/logs -- VERIFIED live 2026-09-25.
// Each log row carries commenterId, commenterName, commentText, the DM status,
// and (Instagram) the follow relationship and follower count.
//
// ─── WHY A NEW TABLE ─────────────────────────────────────────────────────────
// Checked the existing homes first, as instructed:
//   waitlist            -> id, created_at, email, source. Email-only. A
//                          commenter gives us a platform handle and no email,
//                          so every row would be null in the one column that
//                          table exists for.
//   calculator_signups  -> email + TREC contract_data + deadlines + reminder
//                          state. Models a calculator submission; nothing
//                          about a DM lead fits it.
// Neither can hold (platform, handle, which video, which keyword) without
// being deformed into something else. Hence comment_dm_leads.
//
// ─── IDEMPOTENCY ─────────────────────────────────────────────────────────────
// Keyed on Zernio's own log row id (unique index). This cron re-reads the same
// pages every run by design -- a log row's status changes over time (pending ->
// sent, delivered, read) -- so re-reading has to be free, and a missed run has
// to backfill rather than lose leads.
//
// Also surfaces `misses`: comments that reached an automation and matched no
// keyword. That is the ONLY signal that a keyword is catching nothing, Zernio
// keeps it for 14 days, and a keyword that fires zero is exactly the failure
// this whole system is supposed to make visible rather than quiet.
//
// Schedule: 0 * * * *. Owner: Atlas, 2026-09-25.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { makeBudget, getAutomationLogs } = require('./_lib/zernio-comments.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_PAGES_PER_AUTOMATION = 5;
const PAGE_SIZE = 100;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 300) : '' };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!process.env.ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  // Every automation we have ever created, INCLUDING retired ones -- a retired
  // automation's logs still hold real leads, and deleteAutomation() at Zernio
  // destroys its logs, so anything already synced here is the only copy.
  const ledgerR = await sb(
    'video_comment_automations?zernio_automation_id=not.is.null'
    + '&select=id,zernio_automation_id,keyword,platform,account_id,video_library_id,status',
  );
  if (!ledgerR.ok) return res.status(500).json({ ok: false, error: `ledger_read_${ledgerR.status}` });
  const ledger = Array.isArray(ledgerR.data) ? ledgerR.data : [];

  if (ledger.length === 0) {
    return res.status(200).json({
      ok: true, synced: 0, automations: 0,
      note: 'no comment-to-DM automations exist yet, so there are no leads to sync',
    });
  }

  const budget = makeBudget(60);
  let synced = 0;
  let seen = 0;
  const errors = [];
  const keywordMisses = [];

  for (const row of ledger) {
    let skip = 0;
    for (let page = 0; page < MAX_PAGES_PER_AUTOMATION; page += 1) {
      const r = await getAutomationLogs({
        automationId: row.zernio_automation_id, limit: PAGE_SIZE, skip, budget,
      });
      if (!r.ok) {
        // A 404 means the automation was deleted at Zernio. Not an error --
        // the ledger row is the record and previously synced leads persist.
        if (r.status !== 404) errors.push({ automation: row.zernio_automation_id, status: r.status, error: r.error });
        break;
      }

      if (page === 0 && r.misses && r.misses.total > 0) {
        keywordMisses.push({
          keyword: row.keyword,
          video: row.video_library_id,
          non_matching_comments: r.misses.total,
          retention_days: r.misses.retentionDays,
          samples: (r.misses.samples || []).slice(0, 3).map((s) => String(s.commentText || '').slice(0, 120)),
        });
      }

      const logs = r.logs || [];
      seen += logs.length;
      if (logs.length === 0) break;

      const rows = logs.map((l) => ({
        zernio_log_id: String(l.id),
        platform: row.platform,
        account_id: row.account_id,
        commenter_platform_id: l.commenterId || null,
        commenter_name: l.commenterName || null,
        commenter_handle: l.commenterName || null,
        is_follower: typeof l.commenterIsFollower === 'boolean' ? l.commenterIsFollower : null,
        follower_count: Number.isFinite(l.commenterFollowerCount) ? l.commenterFollowerCount : null,
        keyword: row.keyword,
        video_library_id: row.video_library_id,
        automation_id: row.id,
        zernio_automation_id: row.zernio_automation_id,
        comment_text: String(l.commentText || '').slice(0, 2000),
        comment_external_id: l.commentId || null,
        dm_status: l.status || null,
        dm_error: l.error ? String(l.error).slice(0, 400) : null,
        triggered_at: l.createdAt || null,
        synced_at: new Date().toISOString(),
      }));

      // merge-duplicates, not ignore: a log row's status legitimately changes
      // (pending -> sent -> failed) and the latest truth is the one we want.
      const ins = await sb('comment_dm_leads?on_conflict=zernio_log_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(rows),
      });
      if (!ins.ok) { errors.push({ automation: row.zernio_automation_id, stage: 'upsert', error: ins.raw }); break; }
      synced += Array.isArray(ins.data) ? ins.data.length : 0;

      const pg = r.pagination || {};
      if (!pg.hasMore) break;
      skip += PAGE_SIZE;
    }
  }

  return res.status(200).json({
    ok: true,
    synced,
    logs_seen: seen,
    automations: ledger.length,
    // A keyword with zero triggers but non-zero misses is a MISCONFIGURED
    // keyword, not a quiet one. Surfaced rather than dropped.
    keyword_misses: keywordMisses,
    requests_used: budget.used,
    error_count: errors.length,
    errors: errors.slice(0, 5),
  });
}

module.exports = withTelemetry('cron-sync-comment-dm-leads', handler);
module.exports.handler = handler;
