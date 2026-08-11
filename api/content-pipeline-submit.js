'use strict';

// api/content-pipeline-submit.js
//
// Single write endpoint used by BOTH halves of the nightly content pipeline's
// agent-side work:
//
//   1. The generation agent (hadley for guide/answer, carter for feature,
//      spawned by scripts/agent-queue-poller.js) POSTs the finished page
//      (or a BLOCKED failure) here when done researching/writing.
//      Allowed: researching -> pending_review | failed
//
//   2. The promotion agent (atlas, spawned the same way after Heath taps
//      Approve in Telegram) POSTs confirmation here once it has actually
//      written the JSON into marketing/<type>-data/, run the build script,
//      and pushed the commit.
//      Allowed: approved -> promoted | failed
//
// Any other status transition is rejected (409) -- 'approved'/'rejected' can
// ONLY be set by a human tap via api/telegram-webhook.js's cpage_approve_/
// cpage_reject_ handlers, never by an agent directly. This is the guardrail
// that keeps "Heath approves every morning" true even though agents write
// everything else.
//
// Auth: Authorization: Bearer ${CRON_SECRET} (same token already in the
// poller's environment -- see docs/CONTENT-PIPELINE.md).
//
// Owner: Atlas, 2026-08-11 (SV-ENG-NIGHTLY-CONTENT-PIPELINE)

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const REQUIRED_FIELDS_BY_TYPE = {
  guide: ['slug', 'title', 'meta_description', 'body_html', 'faq'],
  answer: ['slug', 'title', 'meta_description', 'body_html'],
  feature: ['slug', 'title', 'meta_description', 'intro_html', 'steps', 'image'],
};

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => { buf += chunk; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function validatePagePayload(pageType, jsonData) {
  const required = REQUIRED_FIELDS_BY_TYPE[pageType];
  if (!required) return `unknown_page_type:${pageType}`;
  if (!jsonData || typeof jsonData !== 'object') return 'json_data_missing_or_not_object';
  for (const field of required) {
    if (jsonData[field] === undefined || jsonData[field] === null || jsonData[field] === '') {
      return `json_data_missing_field:${field}`;
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }

  const id = String(body.content_pipeline_id || '').trim();
  const status = String(body.status || '').trim();

  if (!id) return res.status(400).json({ ok: false, error: 'content_pipeline_id_required' });
  if (!['pending_review', 'failed', 'promoted'].includes(status)) {
    return res.status(400).json({ ok: false, error: `invalid_status:${status}`, allowed: ['pending_review', 'failed', 'promoted'] });
  }

  const { data: rows, ok: loadOk } = await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(id)}&limit=1`);
  if (!loadOk || !Array.isArray(rows) || rows.length === 0) {
    return res.status(404).json({ ok: false, error: 'row_not_found' });
  }
  const row = rows[0];

  // Enforce the two valid transition lanes -- see file header.
  const isGenerationLane = row.status === 'researching' && ['pending_review', 'failed'].includes(status);
  const isPromotionLane = row.status === 'approved' && ['promoted', 'failed'].includes(status);
  if (!isGenerationLane && !isPromotionLane) {
    return res.status(409).json({
      ok: false,
      error: 'invalid_transition',
      current_status: row.status,
      requested_status: status,
      message: 'Only researching->{pending_review,failed} and approved->{promoted,failed} are allowed here. approved/rejected can only be set by Heath via Telegram.',
    });
  }

  const patch = { updated_at: new Date().toISOString() };

  if (status === 'pending_review') {
    const jsonData = body.json_data;
    const validationError = validatePagePayload(row.page_type, jsonData);
    if (validationError) {
      return res.status(400).json({ ok: false, error: validationError });
    }
    const slug = String(body.slug || jsonData.slug || '').trim();
    if (!slug) return res.status(400).json({ ok: false, error: 'slug_required' });

    patch.status = 'pending_review';
    patch.slug = slug;
    patch.json_data = jsonData;
    patch.sources = Array.isArray(body.sources) ? body.sources.slice(0, 30) : [];
    patch.excerpt = String(body.excerpt || '').slice(0, 2000);
  } else if (status === 'failed') {
    patch.status = 'failed';
    patch.error = String(body.error || 'unspecified failure').slice(0, 4000);
  } else if (status === 'promoted') {
    patch.status = 'promoted';
    patch.promoted_at = new Date().toISOString();
    if (body.commit_sha) patch.error = null; // clear any stale error on success
  }

  const patched = await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });

  if (!patched.ok) {
    return res.status(500).json({ ok: false, error: 'patch_failed', status_code: patched.status, detail: patched.data });
  }

  return res.status(200).json({ ok: true, id, status: patch.status });
};
