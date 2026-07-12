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

const { withTelemetry } = require('./_lib/cron-telemetry.js');

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
  ['api.health.create_checkout_session', '/api/create-checkout-session',      { method: 'POST', body: '{}', expectStatus: (s) => s === 400 || s === 200 || s === 401 || s === 403 || s === 405 }],
  ['api.health.stripe_webhook',      '/api/stripe-webhook',                   { expectStatus: (s) => s === 405 || s === 400 || s === 403 }],
  ['api.health.audit_env_vars',      '/api/audit-env-vars',                   { expectStatus: (s) => s === 401 || s === 403 || s === 405 }],
];

const CRONS = [
  ['cron-alert-health',                0.5],
  ['cron-publish-approved',            1.5],
  ['cron-staging-watcher',             0.5],
  ['cron-send-outbound-emails',        0.5],
  ['cron-agent-queue-tick',            0.5],
  ['cron-agent-worker-tick',           0.5],
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

function summarize(results) {
  const passed = results.filter(r => r.verdict === 'PASS').length;
  const failed = results.filter(r => r.verdict === 'FAIL').length;
  const skipped = results.filter(r => r.verdict === 'SKIP').length;
  return { total: results.length, passed, failed, skipped };
}

function computeDeltas(current, previous) {
  if (!Array.isArray(previous) || previous.length === 0) return { regressions: [], recoveries: [], newTests: [], firstRun: true };
  const prev = new Map(previous.map(r => [r.id, r.verdict]));
  const regressions = [], recoveries = [], newTests = [];
  for (const c of current) {
    const p = prev.get(c.id);
    if (p === undefined) { if (c.verdict === 'FAIL') newTests.push(c); continue; }
    if (p === 'PASS' && c.verdict === 'FAIL') regressions.push({ ...c, previous_verdict: p });
    if (p === 'FAIL' && c.verdict === 'PASS') recoveries.push({ ...c, previous_verdict: p });
  }
  return { regressions, recoveries, newTests, firstRun: false };
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { sent: false, reason: 'no telegram config' };
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
    return { sent: res.ok };
  } catch (e) { return { sent: false, reason: e.message }; }
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
  const duration_ms = Date.now() - started;

  const sum = summarize(results);

  // Fetch previous run for delta
  let previous = [];
  try {
    const { data } = await sb(`/rest/v1/regression_runs?source=eq.vercel-cron&order=run_at.desc&limit=1&select=results`);
    previous = Array.isArray(data) && data[0]?.results ? data[0].results : [];
  } catch {}
  const deltas = computeDeltas(results, previous);

  // Insert new row
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
    alert_sent: false,
  };
  await sb('/rest/v1/regression_runs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });

  // Alert policy
  const failedPct = sum.total > 0 ? (sum.failed / sum.total) * 100 : 0;
  const severity = sum.failed === 0 ? 'GREEN' : failedPct <= 10 ? 'YELLOW' : 'RED';
  const hasDeltas = deltas.regressions.length + deltas.recoveries.length + deltas.newTests.length > 0;
  const prevSum = summarize(previous);
  const prevWasGreen = previous.length > 0 && prevSum.failed === 0;

  let alertSent = false;
  const header = `${severity === 'GREEN' ? '✅' : severity === 'YELLOW' ? '⚠️' : '🚨'} <b>Regression Suite — ${severity}</b>\n${sum.passed}/${sum.total} passed · ${sum.failed} failed · ${sum.skipped} skipped\n<i>${BASE_URL}</i> · vercel-cron`;
  const buildBody = () => {
    const parts = [header];
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

  if (severity === 'RED') {
    const r = await sendTelegram(buildBody());
    alertSent = !!r.sent;
  } else if (severity === 'YELLOW' && hasDeltas) {
    const r = await sendTelegram(buildBody());
    alertSent = !!r.sent;
  } else if (severity === 'GREEN' && (!prevWasGreen || deltas.recoveries.length > 0)) {
    const body = header + (deltas.recoveries.length > 0 ? `\n\n<b>Recovered:</b>\n` + deltas.recoveries.map(r => `• <code>${esc(r.id)}</code>`).join('\n') : '');
    const r = await sendTelegram(body);
    alertSent = !!r.sent;
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
    alert_sent: alertSent,
  });
}

module.exports = withTelemetry('cron-regression-suite', handler);
