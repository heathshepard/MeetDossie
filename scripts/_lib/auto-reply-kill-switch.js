'use strict';

// scripts/_lib/auto-reply-kill-switch.js
//
// GLOBAL kill switch for the auto-reply-with-veto feature ONLY (see
// supabase/migrations/20260916_auto_reply_veto.sql). Deliberately a
// SEPARATE mechanism from scripts/_lib/comment-hunt-halt.js — that circuit
// breaker halts the whole comment-hunt/group-post pipeline on
// account-level Facebook signals (checkpoint, login redirect, removed
// comment). This switch controls exactly one thing: whether a low-risk
// reply may EVER take the veto-timeout auto-post path. Reusing the halt
// file would mean an unrelated FB-account issue could silently flip
// auto-reply back on (or vice versa) as a side effect — kept separate on
// purpose.
//
// STORAGE (rewritten 2026-09-16 — was a local JSON file, see below):
// public.ops_flags, row key='auto_reply' (supabase/migrations/
// 20260916c_ops_flags.sql). Read/written over the Supabase REST API via
// SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — the SAME project both local
// scripts and the Vercel crons already talk to. One row, one source of
// truth: flipping it from a local `node scripts/toggle-auto-reply.js` call
// is now the ONLY way to flip it, and it's immediately visible to
// api/cron-tc-reply-approval.js and api/cron-auto-reply-veto-check.js on
// their very next run.
//
// THE BUG THIS REPLACED: the switch used to live in a local JSON file
// (scripts/.auto-reply-kill-switch.json) read via plain fs calls. That file
// only ever existed on whatever machine ran the toggle script — Vercel's
// serverless filesystem never had it, so every production read hit the
// "missing file" branch. Turning the switch on or off locally had ZERO
// effect on production. The missing-file branch already returned
// enabled=false (fail-closed by construction), so this was NOT a live
// "auto-reply silently ON" hole — but it also meant there was no way to
// ever turn it ON in production. Confirmed via code read 2026-09-16, no
// fix needed for the fail-closed part; the storage split is what's fixed
// here.
//
// FAIL-CLOSED CONTRACT — unchanged, now enforced against the network
// instead of the filesystem: a missing row, an unreachable Supabase
// project, a non-2xx response, or a malformed value ALL resolve to
// enabled=false. Never fail open. See loadState() below.
//
// Read by:
//   - api/cron-tc-reply-approval.js       (gates entry into pending_veto)
//   - api/cron-auto-reply-veto-check.js   (gates the actual auto-approve)
//   - scripts/fb-group-commenter.js       (defense-in-depth: refuses to
//                                          post an auto_approved row if the
//                                          switch is off, even if it was
//                                          flipped off AFTER auto-approval)
//
// Flip with:
//   node scripts/toggle-auto-reply.js on
//   node scripts/toggle-auto-reply.js off
//   node scripts/toggle-auto-reply.js status
//
// Every exported function takes an OPTIONAL sbFetch override as its last
// argument — regression tests inject an in-memory PostgREST mock (see
// scripts/regression-auto-reply-veto.js) instead of ever touching the real
// project. Production/local callers pass nothing and get the real network
// call built from SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY.
//
// Owner: Carter, 2026-09-16

const fs = require('fs');
const path = require('path');

// Load .env.local when running as a local script (node scripts/toggle-...).
// No-op on Vercel (file doesn't exist there) and never overwrites an
// already-set env var, so this can never shadow the real Vercel env.
(function loadDotEnvLocal() {
  try {
    const envPath = path.join(__dirname, '..', '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (e) { /* non-fatal */ }
})();

const OPS_FLAG_KEY = 'auto_reply';

function envSbFetch() {
  return async function sbFetch(urlPath, init = {}) {
    const base = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!base || !key) {
      return { ok: false, status: 0, data: null, error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing' };
    }
    try {
      const headers = {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        ...(init.headers || {}),
      };
      const res = await fetch(`${base}${urlPath}`, { ...init, headers });
      const text = await res.text();
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch { data = null; } }
      return { ok: res.ok, status: res.status, data };
    } catch (e) {
      return { ok: false, status: 0, data: null, error: e.message };
    }
  };
}

/** @returns {Promise<{enabled: boolean, updated_at: string|null, reason: string|null}>} */
async function loadState(sbFetch = envSbFetch()) {
  try {
    const { ok, data } = await sbFetch(
      `/rest/v1/ops_flags?key=eq.${OPS_FLAG_KEY}&select=enabled,updated_at,reason`,
    );
    if (!ok) {
      return { enabled: false, updated_at: null, reason: 'ops_flags unreadable — failing closed' };
    }
    if (!Array.isArray(data) || data.length === 0) {
      return { enabled: false, updated_at: null, reason: 'no ops_flags row for auto_reply — defaults OFF' };
    }
    const row = data[0];
    if (typeof row.enabled !== 'boolean') {
      return { enabled: false, updated_at: null, reason: 'malformed ops_flags row — failing closed' };
    }
    return { enabled: row.enabled, updated_at: row.updated_at || null, reason: row.reason || null };
  } catch (e) {
    // Corrupt/unreachable = fail SAFE = disabled, never fail open.
    return { enabled: false, updated_at: null, reason: `ops_flags read failed: ${e.message}` };
  }
}

async function saveState(enabled, reason, sbFetch = envSbFetch()) {
  const nowIso = new Date().toISOString();
  const payload = {
    key: OPS_FLAG_KEY,
    enabled,
    reason: String(reason),
    updated_at: nowIso,
    updated_by: 'toggle-auto-reply.js',
  };
  const res = await sbFetch('/rest/v1/ops_flags?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`failed to write ops_flags: status ${res.status}${res.error ? ` (${res.error})` : ''}`);
  }
  return { enabled, updated_at: nowIso, reason: String(reason) };
}

/** @returns {Promise<boolean>} */
async function isAutoReplyEnabled(sbFetch) {
  return (await loadState(sbFetch)).enabled === true;
}

/** @returns {Promise<{enabled: boolean, updated_at: string|null, reason: string|null}>} */
async function getState(sbFetch) {
  return loadState(sbFetch);
}

async function enableAutoReply(reason = 'manual enable', sbFetch) {
  return saveState(true, reason, sbFetch);
}

async function disableAutoReply(reason = 'manual disable', sbFetch) {
  return saveState(false, reason, sbFetch);
}

/** Human-readable description of what this instance is pointed at — printed
 * by `node scripts/toggle-auto-reply.js status` so it can never again be
 * misread as "governs only this machine." There's exactly one Supabase
 * project (pgwoitbdiyubjugwufhk) shared by every environment, so this is
 * always the same answer, everywhere this module runs. */
function describeTarget() {
  const base = process.env.SUPABASE_URL || '(SUPABASE_URL not set)';
  return `Supabase ops_flags row key='${OPS_FLAG_KEY}' at ${base} — the SAME row read by api/cron-tc-reply-approval.js and api/cron-auto-reply-veto-check.js in production. There is no separate local/prod switch.`;
}

module.exports = {
  OPS_FLAG_KEY,
  isAutoReplyEnabled,
  getState,
  enableAutoReply,
  disableAutoReply,
  describeTarget,
  // Exposed for tests that want to build their own mock sbFetch without
  // reaching into module internals.
  envSbFetch,
};
