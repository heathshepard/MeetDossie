// scripts/daily-regression-suite/_lib/api-tests.mjs
//
// Category 3 — API health probes. Pure fetch, no browser. Runs in both
// Vercel serverless (cron) and local runner.
//
// Assertion pattern: every endpoint returns either 2xx (public) or 401/400/405
// (auth/method-gated). Anything 5xx = FAIL. Timeout > 5s = FAIL.

import { probe, mkTest } from './http.mjs';

const BUDGET = 5000;

// Every entry: [id, path, opts]
const ENDPOINTS = [
  ['api.health.core',                '/api/health',                           { expectStatus: (s) => s === 200 || s === 503 }],
  ['api.health.config',              '/api/config',                           { expectStatus: (s) => s < 500 }],
  ['api.health.transactions',        '/api/transactions',                     { expectStatus: (s) => s === 401 || s === 200 || s === 403 || s === 405 }],
  ['api.health.documents',           '/api/documents',                        { expectStatus: (s) => s === 401 || s === 200 || s === 403 || s === 405 }],
  ['api.health.action_items',        '/api/action-items',                     { expectStatus: (s) => s === 401 || s === 200 || s === 403 || s === 405 }],
  ['api.health.chat',                '/api/chat',                             { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.founding_count',      '/api/founding-count',                   { expectStatus: 200 }],
  ['api.health.notify_founding',     '/api/notify-founding-application',      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.get_scan_upload_url', '/api/get-scan-upload-url',              { expectStatus: (s) => s === 401 || s === 403 || s === 405 }],
  ['api.health.get_document_upload_url', '/api/get-document-upload-url',      { expectStatus: (s) => s === 401 || s === 403 || s === 405 }],
  ['api.health.scan_contract',       '/api/scan-contract',                    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.extract_form_fields', '/api/extract-form-fields',              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.fill_form',           '/api/fill-form',                        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.fill_form_via_docuseal', '/api/fill-form-via-docuseal',        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.draft_amendment',     '/api/draft-amendment',                  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.generate_card',       '/api/generate-card',                    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.generate_broll',      '/api/generate-broll',                   { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 401 || s === 403 || s === 405 }],
  ['api.health.create_checkout_session', '/api/create-checkout-session',      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', expectStatus: (s) => s === 400 || s === 200 || s === 401 || s === 403 || s === 405 }],
  ['api.health.stripe_webhook',      '/api/stripe-webhook',                   { expectStatus: (s) => s === 405 || s === 400 || s === 403 }],
  ['api.health.audit_env_vars',      '/api/audit-env-vars',                   { expectStatus: (s) => s === 401 || s === 403 || s === 405 }],
];

function mk(id, path, opts) {
  return mkTest(id, 'api', 'api', async (ctx) => {
    const r = await probe(`${ctx.cfg.base}${path}`, { timeoutMs: BUDGET, ...opts });
    return {
      verdict: r.ok && r.ms < BUDGET ? 'PASS' : 'FAIL',
      response_ms: r.ms,
      error: r.ok ? null : `status=${r.status} ${r.error || (r.body || '').slice(0, 200)}`,
      detail: { status: r.status },
    };
  });
}

export function apiTests() {
  const tests = ENDPOINTS.map(([id, path, opts]) => mk(id, path, opts));

  // Founding count invariant — taken + remaining = 25
  tests.push(mkTest('api.health.founding_count_ratio', 'api', 'api', async (ctx) => {
    const r = await probe(`${ctx.cfg.base}/api/founding-count`, { timeoutMs: BUDGET });
    if (!r.ok) return { verdict: 'FAIL', response_ms: r.ms, error: `founding-count fetch failed: ${r.status}` };
    try {
      const j = JSON.parse(r.body);
      const taken = Number(j.spots_taken ?? j.spotsTaken ?? j.taken);
      const remaining = Number(j.spots_remaining ?? j.spotsRemaining ?? j.remaining);
      if (Number.isFinite(taken) && Number.isFinite(remaining) && taken + remaining === 25) {
        return { verdict: 'PASS', response_ms: r.ms, detail: { taken, remaining } };
      }
      return { verdict: 'FAIL', response_ms: r.ms, error: `invariant broken: taken=${taken} remaining=${remaining}` };
    } catch (e) {
      return { verdict: 'FAIL', response_ms: r.ms, error: `parse fail: ${e.message}` };
    }
  }));

  return tests;
}
