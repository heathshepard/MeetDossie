// api/cron-regression-suite.js
//
// Daily regression suite — Vercel cron entry.
//
// Runs the API + DB + cron-health tiers of the suite. Playwright/UI tier
// runs on Heath's PC via a scheduled task (Vercel serverless has no
// Chromium binary).
//
// This endpoint MUST NOT depend on Anthropic or any external LLM. That is
// why the runner logic uses pure fetch + Supabase REST and imports zero
// Anthropic SDKs.
//
// Schedule: `0 9 * * *` = 04:00 CT / 09:00 UTC (once daily, while Heath sleeps)
// Manual trigger: curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/cron-regression-suite
//
// Auth: x-vercel-cron header OR Authorization: Bearer <CRON_SECRET>
//
// Locked 2026-07-11 (Heath approved after scan-in silently broken 7+ days).

// Scheduled-Telegram kill switch (Atlas 2026-08-16). Gates unattended pushes
// to Heath behind TELEGRAM_CRON_NOTIFICATIONS. Two-way chat is unaffected.
//
// 'cron-regression-suite' sits in the gate's ALWAYS_ALLOW floor as of
// 2026-09-17 (backlog B3) — it was NOT there before, so every alert this job
// produced was silently eaten, including a real PASS→FAIL regression on
// 2026-09-10. It earns that floor only because the alert policy below is now
// delta-based rather than "RED every day"; see regression-alert-policy.js.
const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-regression-suite');
const { wasSuppressed } = telegramGate;

const {
  summarize,
  computeDeltas,
  decideAlert,
  reminderHours,
} = require('./_lib/regression-alert-policy.js');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

// Contract-safety tier (2026-09-17). TREC 20-18 golden/broken fixtures, the
// deployed rules-file integrity tripwire, and the ¶5A(2) deadline rollover —
// run in-process against the DEPLOYED api/_lib copies, not the repo. Until
// now the only thing watching them was a path-gated GitHub workflow, so a gate
// nobody runs could rot silently. See api/_lib/contract-safety-checks.js.
const { runContractSafetyChecks } = require('./_lib/contract-safety-checks.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = process.env.REGRESSION_BASE_URL || 'https://meetdossie.com';

const APIS = [
  ['api.health.core',                '/api/health',                           { expectStatus: (s) => s === 200 || s === 503 }],
  ['api.health.config',              '/api/config',                           { expectStatus: (s) => s < 500 }],
  ['api.health.transactions',        '/api/transactions',                     { expectStatus: (s) => s === 401 || s === 200 || s === 403 || s === 405 }],
  ['api.health.documents',           '/api/documents',                        { expectStatus: (s) => s === 401 || s === 200 || s === 403 || s === 405 }],
  ['api.health.action_items',        '/api/action-items',                     { expectStatus: (s) => s === 401 || s === 200 || s === 403 || s === 405 }],
  ['api.health.chat',                '/api/chat',                             { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.founding_count',      '/api/founding-count',                   { expectStatus: 200 }],
  ['api.health.notify_founding',     '/api/notify-founding-application',      { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.get_scan_upload_url', '/api/get-scan-upload-url',              { method: 'POST', body: '{}', expectStatus: (s) => s === 401 || s === 400 || s === 403 || s === 405 }],
  ['api.health.get_document_upload_url', '/api/get-document-upload-url',      { method: 'POST', body: '{}', expectStatus: (s) => s === 401 || s === 400 || s === 403 || s === 405 }],
  ['api.health.scan_contract',       '/api/scan-contract',                    { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.extract_form_fields', '/api/extract-form-fields',              { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.fill_form',           '/api/fill-form',                        { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.fill_form_via_docuseal', '/api/fill-form-via-docuseal',        { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.draft_amendment',     '/api/draft-amendment',                  { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.generate_card',       '/api/generate-card',                    { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.generate_broll',      '/api/generate-broll',                   { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  // Endpoint closed 2026-08-13 — founding membership is closed, no valid Stripe
  // price to sell. Expect 410 Gone now, not a live checkout session.
  ['api.health.create_checkout_session', '/api/create-checkout-session',      { method: 'POST', body: '{}', expectStatus: (s) => s === 410 }],
  ['api.health.stripe_webhook',      '/api/stripe-webhook',                   { expectStatus: (s) => s === 405 || s === 400 || s === 403 }],
  ['api.health.audit_env_vars',      '/api/audit-env-vars',                   { expectStatus: (s) => s === 401 || s === 403 || s === 405 }],
];

const CRONS = [
  ['cron-alert-health',                0.5],
  ['cron-publish-approved',            1.5],
  ['cron-staging-watcher',             0.5],
  ['cron-send-outbound-emails',        0.5],
  ['cron-agent-queue-tick',            0.5],
  ['cron-pull-post-analytics',         30],
  ['cron-platform-health-checker',     4],
  ['cron-followup-check',              1],
  ['cron-morning-brief',               30],
  ['cron-morning-ops-digest',          30],
  ['cron-daily-platform-health',       30],
  ['cron-autonomous-loop',             30],
  ['cron-dossie-sign-completion-loop', 1.5],
  ['cron-deadline-reminders',          30],
  ['cron-email-digest',                30],
  ['cron-pipeline-health',             30],
  ['cron-self-improvement-daily',      30],
  ['cron-dossie-full-diagnostic',      30],
  ['cron-codebase-facts-indexer',      8],
  ['cron-verify-zernio-deliveries',    1.5],
  ['cron-inbox-scan',                  2],
];

const BUDGET = 5000;

async function probe(url, opts = {}) {
  const { method = 'GET', headers = {}, body, expectStatus } = opts;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), BUDGET);
  const start = Date.now();
  try {
    const finalHeaders = Object.assign({}, headers);
    if (body && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json';
    const res = await fetch(url, { method, headers: finalHeaders, body, signal: ctl.signal });
    const ms = Date.now() - start;
    let ok = res.ok;
    if (expectStatus !== undefined) {
      if (Array.isArray(expectStatus)) ok = expectStatus.includes(res.status);
      else if (typeof expectStatus === 'function') ok = !!expectStatus(res.status);
      else ok = res.status === expectStatus;
    }
    let text = '';
    try { text = await res.text(); } catch {}
    return { ok, status: res.status, ms, body: text.slice(0, 400) };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - start, error: err.message };
  } finally {
    clearTimeout(t);
  }
}

async function sb(urlPath, init = {}) {
  const headers = Object.assign({
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  }, init.headers || {});
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, Object.assign({}, init, { headers }));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data, headers: res.headers };
}

async function sbCount(table, filter = '') {
  const url = `/rest/v1/${table}?select=id${filter ? '&' + filter : ''}&limit=1`;
  const res = await fetch(`${SUPABASE_URL}${url}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const range = res.headers.get('content-range') || '';
  const total = parseInt(range.split('/')[1] || '0', 10);
  return { ok: res.ok, status: res.status, count: Number.isFinite(total) ? total : 0 };
}

async function runApiTests() {
  const rows = [];
  for (const [id, urlPath, opts] of APIS) {
    const r = await probe(`${BASE_URL}${urlPath}`, opts);
    rows.push({
      id,
      category: 'api',
      tier: 'api',
      verdict: r.ok && r.ms < BUDGET ? 'PASS' : 'FAIL',
      response_ms: r.ms,
      error: r.ok ? null : `status=${r.status} ${r.error || (r.body || '').slice(0, 200)}`,
      detail: { status: r.status },
    });
  }

  // Founding invariant
  try {
    const r = await probe(`${BASE_URL}/api/founding-count`);
    const j = JSON.parse(r.body);
    const taken = Number(j.spots_taken ?? j.spotsTaken ?? j.taken);
    const remaining = Number(j.spots_remaining ?? j.spotsRemaining ?? j.remaining);
    const ok = Number.isFinite(taken) && Number.isFinite(remaining) && taken + remaining === 25;
    rows.push({
      id: 'api.health.founding_count_ratio', category: 'api', tier: 'api',
      verdict: ok ? 'PASS' : 'FAIL',
      response_ms: r.ms,
      error: ok ? null : `invariant broken: taken=${taken} remaining=${remaining}`,
      detail: { taken, remaining },
    });
  } catch (e) {
    rows.push({ id: 'api.health.founding_count_ratio', category: 'api', tier: 'api', verdict: 'FAIL', response_ms: 0, error: e.message });
  }

  return rows;
}

async function runCronTests() {
  const rows = [];
  for (const [name, maxHours] of CRONS) {
    const { data, ok } = await sb(`/rest/v1/cron_runs?cron_name=eq.${encodeURIComponent(name)}&select=last_run,last_status&limit=1`);
    if (!ok || !Array.isArray(data) || data.length === 0) {
      rows.push({ id: `cron.${name}`, category: 'cron', tier: 'cron', verdict: 'FAIL', response_ms: 0, error: 'no cron_runs row' });
      continue;
    }
    const row = data[0];
    const ageHours = row.last_run ? (Date.now() - new Date(row.last_run).getTime()) / 3600000 : Infinity;
    const stale = ageHours > maxHours;
    const badStatus = row.last_status && row.last_status !== 'ok' && row.last_status !== 'success';
    if (stale || badStatus) {
      rows.push({
        id: `cron.${name}`, category: 'cron', tier: 'cron',
        verdict: 'FAIL', response_ms: 0,
        error: stale ? `stale: ${ageHours.toFixed(1)}h ago (max ${maxHours}h)` : `bad status: ${row.last_status}`,
        detail: { age_hours: ageHours, last_status: row.last_status },
      });
    } else {
      rows.push({
        id: `cron.${name}`, category: 'cron', tier: 'cron',
        verdict: 'PASS', response_ms: 0,
        detail: { age_hours: ageHours, last_status: row.last_status },
      });
    }
  }
  return rows;
}

async function runDbTests() {
  const rows = [];

  // cron_runs freshness
  {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const c = await sbCount('cron_runs', `last_run=gte.${since}`);
    rows.push({
      id: 'db.freshness.cron_runs', category: 'db', tier: 'db',
      verdict: c.count >= 20 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count >= 20 ? null : `only ${c.count} crons ran in 24h`,
      detail: { count: c.count },
    });
  }

  // audit_logs freshness
  {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const c = await sbCount('audit_logs', `created_at=gte.${since}`);
    rows.push({
      id: 'db.freshness.audit_logs', category: 'db', tier: 'db',
      verdict: c.count >= 1 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count >= 1 ? null : 'no audit_logs in 7d',
      detail: { count: c.count },
    });
  }

  // founding seats — subscriptions uses plan='founding'
  {
    const c = await sbCount('subscriptions', `plan=eq.founding&status=eq.active`);
    rows.push({
      id: 'db.invariant.founding_seats', category: 'db', tier: 'db',
      verdict: c.count <= 25 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count <= 25 ? null : `founding cohort > 25: ${c.count}`,
      detail: { count: c.count },
    });
  }

  // content_calendar populated
  {
    const c = await sbCount('content_calendar');
    rows.push({
      id: 'db.content.calendar_populated', category: 'db', tier: 'db',
      verdict: c.count >= 25 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count >= 25 ? null : `only ${c.count} rows`,
      detail: { count: c.count },
    });
  }

  // posting_schedule populated
  {
    const c = await sbCount('posting_schedule');
    rows.push({
      id: 'db.content.posting_schedule_populated', category: 'db', tier: 'db',
      verdict: c.count >= 30 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count >= 30 ? null : `only ${c.count} rows`,
      detail: { count: c.count },
    });
  }

  // social_posts recent
  {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const c = await sbCount('social_posts', `created_at=gte.${since}`);
    rows.push({
      id: 'db.content.social_posts_recent', category: 'db', tier: 'db',
      verdict: c.count >= 1 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count >= 1 ? null : 'no social_posts in 24h',
      detail: { count: c.count },
    });
  }

  // Zernio platform health
  {
    const { data, ok } = await sb(`/rest/v1/platform_health_state?select=platform,last_probe_ok`);
    const healthy = ok && Array.isArray(data) ? data.filter(r => r.last_probe_ok === true).length : 0;
    const total = ok && Array.isArray(data) ? data.length : 0;
    rows.push({
      id: 'db.content.zernio_health', category: 'db', tier: 'db',
      verdict: healthy >= 3 ? 'PASS' : 'FAIL', response_ms: 0,
      error: healthy >= 3 ? null : `only ${healthy}/${total} platforms healthy`,
      detail: { healthy, total },
    });
  }

  // morning brief recency
  {
    const since = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    const c = await sbCount('morning_brief_email_log', `created_at=gte.${since}`);
    rows.push({
      id: 'db.email.morning_brief_recent', category: 'db', tier: 'db',
      verdict: c.count >= 1 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count >= 1 ? null : 'no morning_brief_email_log in 30h',
      detail: { count: c.count },
    });
  }

  // outbound_email_queue not stuck
  {
    const cutoff = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const c = await sbCount('outbound_email_queue', `status=eq.pending&created_at=lt.${cutoff}`);
    rows.push({
      id: 'db.email.outbound_queue_healthy', category: 'db', tier: 'db',
      verdict: c.count === 0 ? 'PASS' : 'FAIL', response_ms: 0,
      error: c.count === 0 ? null : `${c.count} stuck emails (>2h pending)`,
      detail: { count: c.count },
    });
  }

  // testimonial-draft freshness window (2026-09-10 incident: the first
  // cron-request-testimonial-draft.js run had no closing_date floor and
  // drafted 39 stale "ask for a testimonial" action items for deals closed
  // months earlier. Query is now floored to 14 days -- this invariant
  // catches a regression of that floor without needing to re-run the cron.
  {
    const TESTIMONIAL_WINDOW_DAYS = 14;
    const aiR = await sb(`/rest/v1/action_items?action_type=eq.testimonial_request&select=id,transaction_id`);
    const items = aiR.ok && Array.isArray(aiR.data) ? aiR.data : [];
    let staleCount = 0;
    let detail = {};
    if (items.length > 0) {
      const txIds = Array.from(new Set(items.map(i => i.transaction_id).filter(Boolean)));
      const filter = txIds.map(id => `"${id}"`).join(',');
      const txR = await sb(`/rest/v1/transactions?id=in.(${filter})&select=id,closing_date`);
      const txById = new Map((txR.ok && Array.isArray(txR.data) ? txR.data : []).map(t => [String(t.id), t.closing_date]));
      const floor = new Date(Date.now() - TESTIMONIAL_WINDOW_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const staleIds = [];
      for (const item of items) {
        const cd = txById.get(String(item.transaction_id));
        if (!cd || cd < floor) { staleCount++; staleIds.push(item.transaction_id); }
      }
      detail = { stale_ids: staleIds.slice(0, 10), floor };
    }
    rows.push({
      id: 'db.testimonial.no_stale_drafts', category: 'db', tier: 'db',
      verdict: staleCount === 0 ? 'PASS' : 'FAIL', response_ms: 0,
      error: staleCount === 0 ? null : `${staleCount} testimonial_request action_items reference a transaction closed >${TESTIMONIAL_WINDOW_DAYS}d ago`,
      detail: Object.assign({ stale_count: staleCount, total_checked: items.length }, detail),
    });
  }

  // critical incidents recent
  {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data } = await sb(`/rest/v1/customer_experience_incidents?select=id&severity=eq.critical&created_at=gte.${since}`);
    const count = Array.isArray(data) ? data.length : 0;
    rows.push({
      id: 'db.fillform.no_recent_critical_incidents', category: 'db', tier: 'db',
      verdict: count === 0 ? 'PASS' : 'FAIL', response_ms: 0,
      error: count === 0 ? null : `${count} critical incidents in 24h`,
      detail: { count },
    });
  }

  return rows;
}

// summarize() / computeDeltas() / decideAlert() live in
// api/_lib/regression-alert-policy.js so the alert decision is a pure,
// unit-testable function instead of inline branches nobody can exercise.

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Returns { sent, suppressed, reason }.
//
// `sent` means a human can actually read this message. It is NOT `res.ok`:
// telegram-gate returns a well-formed fake 200 for a suppressed send, so the
// old `return { sent: res.ok }` reported success for a message that was never
// delivered. Anything that records "Heath was alerted" MUST distinguish those
// — that confusion is what made the 2026-08-17 video_library incident invisible
// for three weeks. See the CONTRACT block in api/_lib/telegram-gate.js.
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, suppressed: false, reason: 'no telegram config' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    let body = null;
    try { body = await res.json(); } catch { /* non-JSON error page */ }
    if (wasSuppressed(body)) {
      console.warn('[cron-regression-suite] alert SUPPRESSED by telegram-gate — NOT delivered');
      return { sent: false, suppressed: true, reason: 'suppressed_by_telegram_gate' };
    }
    if (!res.ok) {
      return { sent: false, suppressed: false, reason: `telegram ${res.status}` };
    }
    return { sent: true, suppressed: false, reason: 'delivered' };
  } catch (e) {
    return { sent: false, suppressed: false, reason: e.message };
  }
}

// Age in hours of the most recent run that ACTUALLY delivered an alert.
// null = never (or unreadable), which the policy treats as "due for a
// reminder" so a fresh deploy announces the standing failure set once.
//
// This is the reason the alert_sent write-back below has to be honest: it is
// now load-bearing input, not decoration. Before 2026-09-17 the column was
// written `false` before the send was even attempted and never patched, so it
// described nothing.
async function hoursSinceLastDeliveredAlert() {
  try {
    const { ok, data } = await sb(
      '/rest/v1/regression_runs?source=eq.vercel-cron&alert_sent=is.true&order=run_at.desc&limit=1&select=run_at'
    );
    const runAt = ok && Array.isArray(data) && data[0] ? data[0].run_at : null;
    if (!runAt) return null;
    const hours = (Date.now() - new Date(runAt).getTime()) / 3600000;
    return Number.isFinite(hours) ? hours : null;
  } catch {
    return null;
  }
}

async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const started = Date.now();
  const results = [];
  results.push(...(await runApiTests()));
  results.push(...(await runCronTests()));
  results.push(...(await runDbTests()));
  // Synchronous, no network, ~6ms for the whole tier. Wrapped anyway so a
  // throw inside contract-safety can never cost us the API/DB/cron results.
  try {
    results.push(...runContractSafetyChecks());
  } catch (e) {
    results.push({
      id: 'contract.tier.runner',
      category: 'contract',
      tier: 'contract',
      verdict: 'FAIL',
      response_ms: 0,
      error: `contract-safety tier threw: ${e.message}`,
    });
  }
  const duration_ms = Date.now() - started;

  const sum = summarize(results);

  // Fetch previous run for delta
  let previous = [];
  try {
    const { data } = await sb(`/rest/v1/regression_runs?source=eq.vercel-cron&order=run_at.desc&limit=1&select=results`);
    previous = Array.isArray(data) && data[0]?.results ? data[0].results : [];
  } catch {}
  const deltas = computeDeltas(results, previous);

  // Insert new row. return=representation (not minimal) so we get the row id
  // back and can patch the REAL alert outcome onto it once the send resolves.
  const row = {
    run_at: new Date().toISOString(),
    source: 'vercel-cron',
    base_url: BASE_URL,
    total_tests: sum.total,
    passed: sum.passed,
    failed: sum.failed,
    skipped: sum.skipped,
    duration_ms,
    results,
    deltas: [
      ...deltas.regressions.map(r => ({ id: r.id, previous_verdict: 'PASS', current_verdict: 'FAIL' })),
      ...deltas.recoveries.map(r => ({ id: r.id, previous_verdict: 'FAIL', current_verdict: 'PASS' })),
    ],
    // Provisional. Patched below with what actually happened — never left as
    // the pre-send guess. See hoursSinceLastDeliveredAlert().
    alert_sent: false,
    notes: 'alert: pending',
  };
  const inserted = await sb('/rest/v1/regression_runs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  const rowId =
    inserted.ok && Array.isArray(inserted.data) && inserted.data[0] ? inserted.data[0].id : null;
  if (!rowId) {
    console.warn('[cron-regression-suite] could not read back inserted row id — alert_sent will not be patched');
  }

  // ---------------------------------------------------------------------
  // Alert policy — delta-based, not "RED every day". See
  // api/_lib/regression-alert-policy.js for the full rationale.
  // ---------------------------------------------------------------------
  const prevSum = summarize(previous);
  const prevWasGreen = previous.length > 0 && prevSum.failed === 0;
  const sinceLastAlert = await hoursSinceLastDeliveredAlert();

  const decision = decideAlert({
    sum,
    deltas,
    prevWasGreen,
    hadPrevious: previous.length > 0,
    hoursSinceLastAlert: sinceLastAlert,
  });
  const severity = decision.severity;

  const header = `${severity === 'GREEN' ? '✅' : severity === 'YELLOW' ? '⚠️' : '🚨'} <b>Regression Suite — ${severity}</b>\n${sum.passed}/${sum.total} passed · ${sum.failed} failed · ${sum.skipped} skipped\n<i>${BASE_URL}</i> · vercel-cron`;
  const buildBody = () => {
    const parts = [header];
    if (decision.isReminder) {
      // A reminder must be actionable, not a nag: name the standing failures,
      // since by definition nothing changed and there are no deltas to show.
      const failing = results.filter(r => r.verdict === 'FAIL');
      parts.push(
        `<b>Still failing — unchanged since the last alert.</b>\n` +
        failing.slice(0, 15).map(r => `• <code>${esc(r.id)}</code> — ${esc((r.error || '').slice(0, 120))}`).join('\n') +
        (failing.length > 15 ? `\n…and ${failing.length - 15} more` : '') +
        `\n\n<i>Next reminder in ${reminderHours()}h unless the failure set changes.</i>`
      );
      return parts.join('\n\n');
    }
    if (deltas.regressions.length > 0) {
      parts.push('<b>Regressions (PASS → FAIL):</b>\n' + deltas.regressions.slice(0, 15).map(r => `• <code>${esc(r.id)}</code> — ${esc((r.error || '').slice(0, 120))}`).join('\n'));
    }
    if (deltas.recoveries.length > 0) {
      parts.push('<b>Recoveries (FAIL → PASS):</b>\n' + deltas.recoveries.slice(0, 10).map(r => `• <code>${esc(r.id)}</code>`).join('\n'));
    }
    if (deltas.newTests.length > 0) {
      parts.push('<b>New failing:</b>\n' + deltas.newTests.slice(0, 10).map(r => `• <code>${esc(r.id)}</code>`).join('\n'));
    }
    return parts.join('\n\n');
  };

  let alertSent = false;
  let alertOutcome = `not attempted (${decision.kind}: ${decision.reason})`;
  if (decision.alert) {
    const r = await sendTelegram(buildBody());
    alertSent = !!r.sent;
    alertOutcome = `${decision.kind}: ${r.reason}`;
  }

  // Write back the TRUTH. A suppressed or failed send leaves alert_sent=false
  // AND says why in notes, so "did Heath actually see this?" is answerable
  // from the table rather than only from a long-gone HTTP response.
  if (rowId) {
    const patch = await sb(`/rest/v1/regression_runs?id=eq.${rowId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ alert_sent: alertSent, notes: `alert: ${alertOutcome}`.slice(0, 500) }),
    });
    if (!patch.ok) {
      console.warn(`[cron-regression-suite] alert_sent write-back FAILED (status ${patch.status}) for run ${rowId} — row still reads alert_sent=false, notes="alert: pending"`);
    }
  }

  return res.status(200).json({
    ok: true,
    severity,
    sum,
    deltas: {
      regressions: deltas.regressions.length,
      recoveries: deltas.recoveries.length,
      new_failing: deltas.newTests.length,
    },
    duration_ms,
    alert_decision: {
      alert: decision.alert,
      kind: decision.kind,
      reason: decision.reason,
      is_reminder: decision.isReminder,
      hours_since_last_alert: sinceLastAlert,
    },
    alert_sent: alertSent,
    alert_outcome: alertOutcome,
    run_id: rowId,
  });
}

module.exports = withTelemetry('cron-regression-suite', handler);
