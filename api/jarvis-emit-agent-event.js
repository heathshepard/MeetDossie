// Vercel Serverless Function: /api/jarvis-emit-agent-event
// =========================================================================
// Thin write-only helper for the Jarvis Agent Ledger (DoD ADDENDUM 2026-06-21).
//
// Cole / Jarvis / any orchestrator calls this before AND after spawning an
// agent so the PWA's Agent Status panel + Activity Log show what's running
// in real time.
//
// POST /api/jarvis-emit-agent-event
//   Body:
//     {
//       agent_name: "atlas" | "carter" | "hadley" | "pierce" | "sage"
//                 | "ridge" | "quinn" | "sterling" | "jarvis",
//       event_type: "spawned" | "progress" | "completed" | "failed" | "heartbeat",
//       task_title?: string,        // short summary, truncated to 100 chars
//       prompt?: string,            // full prompt text (kept short on spawn,
//                                   // detailed in modal)
//       summary?: string,           // 1-line current task
//       status?: "spawned"|"working"|"completed"|"failed",
//       started_at?: iso8601,       // omit for now() on spawn
//       completed_at?: iso8601,     // set on completed|failed
//       result_summary?: string,    // final report
//       commit_sha?: string,
//       files_touched?: string[],
//       screenshot_paths?: string[],
//       apv_status?: "not_run" | "pass" | "fail",
//       token_cost_cents?: number,
//       tenant_id?: uuid            // optional override; defaults to caller's
//                                   // tenant via jarvis_users
//     }
//
// Auth: REQUIRED Bearer Supabase JWT. The tenant is resolved from
// jarvis_users.auth_user_id; cross-tenant writes are blocked.
//
// Returns:
//   200 { ok: true, event: { id, ... } }
//   400 on validation error
//   401 on auth failure
//   403 if user has no Jarvis tenant
//
// Owner: Atlas (Tier 2 build, 2026-06-21).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_AGENTS = new Set([
  'atlas', 'carter', 'hadley', 'pierce', 'sage',
  'ridge', 'quinn', 'sterling', 'jarvis',
]);
const VALID_EVENT_TYPES = new Set([
  'spawned', 'progress', 'completed', 'failed', 'heartbeat',
]);
const VALID_STATUSES = new Set(['spawned', 'working', 'completed', 'failed']);
const VALID_APV = new Set(['not_run', 'pass', 'fail']);

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPost(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`sbPost ${path} -> ${res.status} ${errBody.slice(0, 200)}`);
  }
  return res.json();
}

async function resolveTenantId(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return rows[0].tenant_id;
}

function truncate(s, n) {
  if (s == null) return null;
  const str = String(s);
  return str.length > n ? str.slice(0, n) : str;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const body = req.body || {};
  const {
    agent_name,
    event_type,
    task_title,
    prompt,
    summary,
    status,
    started_at,
    completed_at,
    result_summary,
    commit_sha,
    files_touched,
    screenshot_paths,
    apv_status,
    token_cost_cents,
    details,
  } = body;

  if (!agent_name || !VALID_AGENTS.has(agent_name)) {
    return res.status(400).json({ ok: false, error: 'invalid_agent_name', valid: Array.from(VALID_AGENTS) });
  }
  if (!event_type || !VALID_EVENT_TYPES.has(event_type)) {
    return res.status(400).json({ ok: false, error: 'invalid_event_type', valid: Array.from(VALID_EVENT_TYPES) });
  }
  if (status != null && !VALID_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, error: 'invalid_status', valid: Array.from(VALID_STATUSES) });
  }
  if (apv_status != null && !VALID_APV.has(apv_status)) {
    return res.status(400).json({ ok: false, error: 'invalid_apv_status', valid: Array.from(VALID_APV) });
  }

  // Resolve tenant from the JWT user (NEVER trust client-supplied tenant_id).
  let tenantId;
  try {
    tenantId = await resolveTenantId(authUser.userId);
  } catch (err) {
    console.error('[jarvis-emit-agent-event] tenant resolve:', err.message);
    return res.status(500).json({ ok: false, error: 'tenant_lookup_failed' });
  }
  if (!tenantId) {
    return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });
  }

  // Build the insert row. Only set fields the caller provided so we don't
  // overwrite previous rows' values with nulls when emitting a progress event.
  const row = {
    tenant_id: tenantId,
    agent_name,
    event_type,
    summary: truncate(summary, 500),
  };
  if (task_title != null) row.task_title = truncate(task_title, 100);
  if (prompt != null) row.prompt = String(prompt);
  if (status != null) row.status = status;
  // Infer status from event_type if not explicitly set.
  if (status == null) {
    if (event_type === 'spawned') row.status = 'spawned';
    else if (event_type === 'progress' || event_type === 'heartbeat') row.status = 'working';
    else if (event_type === 'completed') row.status = 'completed';
    else if (event_type === 'failed') row.status = 'failed';
  }
  if (started_at != null) row.started_at = started_at;
  else if (event_type === 'spawned') row.started_at = new Date().toISOString();
  if (completed_at != null) row.completed_at = completed_at;
  else if (event_type === 'completed' || event_type === 'failed') row.completed_at = new Date().toISOString();
  if (result_summary != null) row.result_summary = String(result_summary);
  if (commit_sha != null) row.commit_sha = truncate(commit_sha, 64);
  if (Array.isArray(files_touched)) row.files_touched = files_touched;
  if (Array.isArray(screenshot_paths)) row.screenshot_paths = screenshot_paths;
  if (apv_status != null) row.apv_status = apv_status;
  if (Number.isFinite(token_cost_cents)) row.token_cost_cents = Math.max(0, Math.floor(token_cost_cents));
  if (details && typeof details === 'object') row.details = details;

  try {
    const inserted = await sbPost('jarvis_agent_events', row);
    return res.status(200).json({ ok: true, event: inserted[0] });
  } catch (err) {
    console.error('[jarvis-emit-agent-event] insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'insert_failed', detail: err.message });
  }
}
