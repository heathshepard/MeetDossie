'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyFile, classifyFiles } = require('./auto-merge-risk-gate.js');

test('e-sign / contract paths HOLD', () => {
  const paths = [
    'api/esign-create.js',
    'api/_lib/esign-role-resolver.js',
    'api/_assets/esign-field-maps.json',
    'scripts/esign-role-maps/resale.json',
    'api/_lib/docuseal-webhook-verify.js',
    'api/docuseal-webhook.js',
    'api/_lib/signature-verifier.js',
    'api/fill-form.js',
    'api/fill-form-via-docuseal.js',
  ];
  for (const p of paths) {
    const c = classifyFile(p);
    assert.equal(c.decision, 'hold', `expected HOLD for ${p}`);
    assert.equal(c.category, 'esign_contract', `expected esign_contract category for ${p}`);
  }
});

test('outbound client communication HOLDs, social/group posting does not', () => {
  assert.equal(classifyFile('api/_lib/dm-link.js').decision, 'hold');
  assert.equal(classifyFile('api/notify-sales-lead.js').decision, 'hold');
  assert.equal(classifyFile('api/cron-send-outbound-emails.js').decision, 'hold');
  assert.equal(classifyFile('scripts/kw-mail.py').decision, 'hold');

  // social/cron infra is exactly what Heath wants flowing — must NOT hold
  assert.equal(classifyFile('api/cron-post-videos.js').decision, 'clear');
  assert.equal(classifyFile('api/_lib/zernio-post-status.js').decision, 'clear');
  assert.equal(classifyFile('scripts/fb-group-poster.js').decision, 'clear');
});

test('payments / billing HOLDs', () => {
  assert.equal(classifyFile('api/create-checkout-session.js').decision, 'hold');
  assert.equal(classifyFile('api/_lib/subscription-status-map.js').decision, 'hold');
  assert.equal(classifyFile('api/stripe-webhook.js').decision, 'hold');
});

test('auth / RLS / migrations HOLD', () => {
  assert.equal(classifyFile('supabase/migrations/20260928_add_col.sql').decision, 'hold');
  assert.equal(classifyFile('api/admin-migrate-ops-flags.js').decision, 'hold');
  assert.equal(classifyFile('api/_lib/youtube-oauth.js').decision, 'hold');
});

test('vercel.json HOLDs', () => {
  assert.equal(classifyFile('vercel.json').decision, 'hold');
  assert.equal(classifyFile('vercel.json').category, 'cron_config');
});

test('gate cannot approve changes to itself', () => {
  assert.equal(classifyFile('.github/workflows/staging-auto-merge-gate.yml').decision, 'hold');
  assert.equal(classifyFile('api/_lib/auto-merge-risk-gate.js').decision, 'hold');
  assert.equal(classifyFile('scripts/auto-merge-test-suite.js').decision, 'hold');
});

test('ordinary cron/lib/script infra CLEARs', () => {
  const paths = [
    'api/cron-dispatch-daily-0800.js',
    'api/_lib/social-goals.js',
    'api/_lib/ops-policy.js',
    'scripts/regression-social-goals-pacing.js',
    'docs/PIPELINE.md',
    'CLAUDE.md',
  ];
  for (const p of paths) {
    assert.equal(classifyFile(p).decision, 'clear', `expected CLEAR for ${p}`);
  }
});

test('unrecognized path fails closed to HOLD', () => {
  const c = classifyFile('some/brand-new/top-level/dir/thing.js');
  assert.equal(c.decision, 'hold');
  assert.equal(c.category, 'unclassified');
});

test('classifyFiles aggregates: any single hold holds the whole set', () => {
  const result = classifyFiles(['api/cron-dispatch-daily-0800.js', 'api/esign-create.js']);
  assert.equal(result.decision, 'hold');
  assert.equal(result.holds.length, 1);
  assert.equal(result.cleared.length, 1);
});

test('classifyFiles: empty changeset is clear (no-op merge, nothing to hold)', () => {
  const result = classifyFiles([]);
  assert.equal(result.decision, 'clear');
  assert.equal(result.total, 0);
});

test('classifyFiles: all-clear changeset', () => {
  const result = classifyFiles(['api/cron-dispatch-daily-0800.js', 'scripts/regression-social-goals-pacing.js']);
  assert.equal(result.decision, 'clear');
  assert.equal(result.holds.length, 0);
  assert.equal(result.cleared.length, 2);
});
