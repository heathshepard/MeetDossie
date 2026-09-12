'use strict';

// api/_lib/weekly-batch-digest.js
//
// Shared logic for the weekly batch-approval digest (Heath, 2026-09-12:
// "lets prepare a week's worth of posts that I can approve at a time. Im a
// bottle neck here and I dont like it"). Used by:
//   - api/cron-weekly-batch-digest.js  — builds + sends the Sunday digest
//   - api/telegram-webhook.js          — resolves "Approve all" tap and the
//                                         "approve/reject/edit post N" text
//                                         commands against the same items
//                                         Heath actually saw
//
// Covers BOTH social_posts and group_posts — kept as two separate source
// queries because they really are separate tables with separate approval
// mechanics (social_posts publishes via Zernio/cron-publish-approved.js;
// group_posts is picked up by local browser-automation scripts once
// status='approved' + auto_post_at is set — see CLAUDE.md RULE 4).
//
// Design note: this does NOT pre-generate a week of future content. Doing
// that safely would mean teaching cron-generate-posts.js (1800+ lines, the
// core money-making cron) to backdate post_id/topic-rotation/day-of-week
// logic for 7 future days in one run — too much blast radius for this
// change. Instead the digest rolls up whatever the existing daily generators
// have produced and left unresolved (status='draft') over the past week,
// which is the actual backlog causing the bottleneck complaint. If Heath
// wants true forward pre-generation later, that's a separate, larger change
// to cron-generate-posts.js's date handling.
//
// Owner: Carter, 2026-09-12

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const LOOKBACK_DAYS = 8; // safety margin over 7 so nothing generated right at the week boundary gets missed

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function sinceIso(days = LOOKBACK_DAYS) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Next Monday (America/Chicago-agnostic — date label only, no time math needed).
function nextMondayLabel(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const daysUntilMonday = (8 - day) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}

function scoreLabel(row) {
  const parts = [];
  if (row.score_hook != null) parts.push(`hook ${row.score_hook}`);
  if (row.score_platform_fit != null) parts.push(`fit ${row.score_platform_fit}`);
  if (row.score_cta != null) parts.push(`cta ${row.score_cta}`);
  return parts.length ? parts.join('/') : null;
}

function oneLine(str, max = 90) {
  const clean = String(str || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function fetchPendingSocialPosts() {
  const cols = 'id,platform,persona,hook,content,created_at,media_url,target_owner,score_hook,score_platform_fit,score_cta';
  const { ok, data } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&created_at=gte.${encodeURIComponent(sinceIso())}&select=${cols}&order=created_at.asc`,
  );
  return ok && Array.isArray(data) ? data : [];
}

async function fetchPendingGroupPosts() {
  const cols = 'id,group_name,pipeline,post_body,first_comment_body,created_at';
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.draft&created_at=gte.${encodeURIComponent(sinceIso())}&select=${cols}&order=created_at.asc`,
  );
  return ok && Array.isArray(data) ? data : [];
}

// Builds the numbered items list + human-readable digest text.
// Returns { items, lines, mediaUrls, socialCount, groupCount }
function buildDigest(socialRows, groupRows) {
  const items = [];
  const byDay = new Map(); // day -> lines[]
  const mediaUrls = [];
  let n = 0;

  for (const row of socialRows) {
    n += 1;
    const day = String(row.created_at || '').slice(0, 10);
    const score = scoreLabel(row);
    const preview = oneLine(row.hook || row.content);
    const owner = row.target_owner && row.target_owner !== 'dossie' ? ` (${row.target_owner})` : '';
    items.push({
      n, table: 'social_posts', id: row.id, platform: row.platform, day, preview,
    });
    if (row.media_url) mediaUrls.push(row.media_url);
    const line = `${n}. [${row.platform}${owner}]${score ? ` (${score})` : ''} ${preview}`;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(line);
  }

  const groupLines = [];
  for (const row of groupRows) {
    n += 1;
    const day = String(row.created_at || '').slice(0, 10);
    const preview = oneLine(row.post_body);
    items.push({
      n, table: 'group_posts', id: row.id, group_name: row.group_name, pipeline: row.pipeline || null, day, preview,
    });
    groupLines.push(`${n}. [FB group: ${row.group_name}] ${preview}`);
  }

  const lines = [];
  const days = [...byDay.keys()].sort();
  for (const day of days) {
    lines.push('', day);
    lines.push(...byDay.get(day).map((l) => `  ${l}`));
  }
  if (groupLines.length) {
    lines.push('', 'FB groups (all days)');
    lines.push(...groupLines.map((l) => `  ${l}`));
  }

  return { items, lines, mediaUrls, socialCount: socialRows.length, groupCount: groupRows.length };
}

// Splits a long digest body into Telegram-safe (<=4000 char) chunks, never
// cutting a line in half.
function chunkMessage(text, limit = 4000) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    if ((cur + '\n' + line).length > limit) {
      chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function resolveItemByNumber(items, n) {
  return (Array.isArray(items) ? items : []).find((it) => it.n === n) || null;
}

// Legacy group_posts guard (api/group-post-callback.js parity): a
// first_comment_body must mention Dossie/meetdossie for the un-piped
// (pipeline=null) legacy campaign only. daily5/listing-groups rows never
// carry a self-promotional first_comment_body and must skip this check.
function groupPostBlockedByDossieMentionRule(row) {
  return !row.pipeline && row.first_comment_body
    && !row.first_comment_body.includes('Dossie')
    && !row.first_comment_body.includes('meetdossie');
}

// Approves every item in `items`, per-table-correct PATCH, guarded by
// status=eq.draft so a row Heath already handled individually (edit/reject)
// between digest-send and "Approve all" tap can't be silently clobbered.
// Returns { approved: [...ids], skipped: [...{n,reason}], errors: [...] }.
async function approveAllItems(items) {
  const now = new Date().toISOString();
  const approved = [];
  const skipped = [];
  const errors = [];

  const socialIds = items.filter((it) => it.table === 'social_posts').map((it) => it.id);
  const groupItems = items.filter((it) => it.table === 'group_posts');

  if (socialIds.length) {
    const idList = socialIds.map((id) => encodeURIComponent(id)).join(',');
    const res = await supabaseFetch(
      `/rest/v1/social_posts?id=in.(${idList})&status=eq.draft`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'approved', approved_at: now }),
      },
    );
    if (res.ok && Array.isArray(res.data)) {
      for (const row of res.data) approved.push({ table: 'social_posts', id: row.id });
      const returnedIds = new Set(res.data.map((r) => r.id));
      for (const id of socialIds) {
        if (!returnedIds.has(id)) skipped.push({ table: 'social_posts', id, reason: 'no longer draft (already handled)' });
      }
    } else {
      errors.push({ table: 'social_posts', error: res.data?.message || `HTTP ${res.status}` });
    }
  }

  if (groupItems.length) {
    // Legacy-pipeline rows with a non-compliant first_comment_body are
    // excluded from the bulk PATCH — same rule api/group-post-callback.js
    // enforces per-tap, applied here too so "Approve all" can't bypass it.
    // Re-fetched live (not from the digest snapshot) so a row edited after
    // the digest was sent is checked against its current content.
    const idList = groupItems.map((it) => encodeURIComponent(it.id)).join(',');
    const guardRes = await supabaseFetch(
      `/rest/v1/group_posts?id=in.(${idList})&select=id,pipeline,first_comment_body,status`,
    );
    const guardRows = guardRes.ok && Array.isArray(guardRes.data) ? guardRes.data : [];
    const guardById = new Map(guardRows.map((r) => [r.id, r]));

    const eligible = [];
    for (const it of groupItems) {
      const row = guardById.get(it.id);
      if (row && row.status !== 'draft') {
        skipped.push({ table: 'group_posts', id: it.id, reason: 'no longer draft (already handled)' });
      } else if (row && groupPostBlockedByDossieMentionRule(row)) {
        skipped.push({ table: 'group_posts', id: it.id, reason: 'first_comment_body must mention Dossie — approve individually' });
      } else {
        eligible.push(it.id);
      }
    }
    if (eligible.length) {
      const idList = eligible.map((id) => encodeURIComponent(id)).join(',');
      const res = await supabaseFetch(
        `/rest/v1/group_posts?id=in.(${idList})&status=eq.draft`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ status: 'approved', approved_at: now, auto_post_at: now }),
        },
      );
      if (res.ok && Array.isArray(res.data)) {
        for (const row of res.data) approved.push({ table: 'group_posts', id: row.id });
        const returnedIds = new Set(res.data.map((r) => r.id));
        for (const id of eligible) {
          if (!returnedIds.has(id)) skipped.push({ table: 'group_posts', id, reason: 'no longer draft (already handled)' });
        }
      } else {
        errors.push({ table: 'group_posts', error: res.data?.message || `HTTP ${res.status}` });
      }
    }
  }

  return { approved, skipped, errors };
}

async function approveOneItem(item) {
  return approveAllItems([item]);
}

async function rejectOneItem(item) {
  const now = new Date().toISOString();
  if (item.table === 'social_posts') {
    return supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(item.id)}&status=eq.draft`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'rejected' }),
    });
  }
  return supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(item.id)}&status=eq.draft`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ status: 'rejected', failure_reason: 'rejected via weekly digest' }),
  });
}

async function saveSurface({ chatId, messageId, weekStart, items }) {
  const res = await supabaseFetch('/rest/v1/weekly_digest_surfaces', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      chat_id: String(chatId),
      message_id: messageId || null,
      week_start: weekStart,
      items,
    }),
  });
  return res.ok && Array.isArray(res.data) && res.data[0] ? res.data[0] : null;
}

async function loadLatestOpenSurface(chatId) {
  const res = await supabaseFetch(
    `/rest/v1/weekly_digest_surfaces?chat_id=eq.${encodeURIComponent(String(chatId))}&status=eq.open&order=surfaced_at.desc&limit=1`,
  );
  return res.ok && Array.isArray(res.data) && res.data[0] ? res.data[0] : null;
}

async function markSurfaceApprovedAll(id) {
  return supabaseFetch(`/rest/v1/weekly_digest_surfaces?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved_all', approved_all_at: new Date().toISOString() }),
  });
}

module.exports = {
  supabaseFetch,
  sinceIso,
  nextMondayLabel,
  fetchPendingSocialPosts,
  fetchPendingGroupPosts,
  buildDigest,
  chunkMessage,
  resolveItemByNumber,
  approveAllItems,
  approveOneItem,
  rejectOneItem,
  saveSurface,
  loadLatestOpenSurface,
  markSurfaceApprovedAll,
  groupPostBlockedByDossieMentionRule,
};
