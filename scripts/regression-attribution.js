#!/usr/bin/env node
'use strict';

/**
 * Regression test for end-to-end conversion attribution
 * (api/_lib/content-tag.js + api/_lib/attribution.js).
 *
 * Heath, 2026-09-17: "which post produced a signup" was impossible to
 * answer. This pins down the join chain that closes it:
 *
 *   1. E2E: a tagged social_posts row -> a PostHog click on the same tag
 *      -> a founding_applications signup carrying that tag in last_touch
 *      -> a subscriptions row (paid) carrying the SAME tag -> the summary
 *      resolves all four to one content_tag, one brand.
 *   2. An UNTAGGED post/outcome is never silently dropped: it's counted in
 *      the "total" bucket AND flagged in "unattributed" — never invisible.
 *
 * In-memory PostgREST-shaped mock + a mock PostHog HogQL runner, injected
 * via getAttributionSummary()'s dependency parameters. ZERO production
 * access, no real Supabase, no real PostHog call.
 *
 * Run manually:
 *   node scripts/regression-attribution.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { getAttributionSummary, effectiveTag } = require(path.join(REPO, 'api/_lib/attribution.js'));
const { buildContentTag, parseContentTag, tagOutboundLinks } = require(path.join(REPO, 'api/_lib/content-tag.js'));

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  return true;
}

function makeMockSupabaseFetch(seed) {
  const db = {
    social_posts: (seed.social_posts || []).map((r) => ({ ...r })),
    founding_applications: (seed.founding_applications || []).map((r) => ({ ...r })),
    subscriptions: (seed.subscriptions || []).map((r) => ({ ...r })),
  };
  return async function mockSupabaseFetch(pathAndQuery) {
    const [tablePath, queryString] = pathAndQuery.replace('/rest/v1/', '').split('?');
    const rows = db[tablePath];
    if (!rows) return { ok: false, status: 404, data: null };
    const params = new URLSearchParams(queryString || '');
    const filters = [...params.entries()].filter(([k]) => !['select', 'order', 'limit'].includes(k));
    const matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
    return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
  };
}

// Mock HogQL runner: returns a fixed clicks-by-tag map regardless of the
// actual query text (dependency-injected, so attribution.js's real query
// string is never exercised against a live PostHog project here).
function makeMockHogqlRunner(clicksByTag) {
  return async function mockRunHogQL() {
    return {
      ok: true,
      results: Object.entries(clicksByTag).map(([tag, clicks]) => [tag, clicks]),
      columns: ['content_tag', 'clicks'],
    };
  };
}

function makeMockHogqlFailure(error) {
  return async function mockRunHogQL() {
    return { ok: false, error, results: [], columns: [] };
  };
}

async function run() {
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => { pass++; console.log(`  PASS  ${name}`); })
      .catch((err) => { fail++; console.log(`  FAIL  ${name}\n        ${err.message}`); });
  }

  const now = new Date().toISOString();
  const TAG = buildContentTag({
    brand: 'dossie', platform: 'facebook', format: 'video',
    contentId: 'a1b2c3d4-0000-0000-0000-000000000000', postedAt: now,
  });
  const UNTAGGED_TAG = null;

  console.log('\n=== 1. END-TO-END: tagged post -> click -> signup -> paid, one tag resolves all four ===');
  await check('parseContentTag round-trips the real tag', () => {
    const parsed = parseContentTag(TAG);
    assert.ok(parsed, 'tag should parse');
    assert.strictEqual(parsed.brand, 'dossie');
    assert.strictEqual(parsed.platform, 'facebook');
  });

  await check('tagOutboundLinks stamps a bare (no-scheme) meetdossie.com link', () => {
    const { text, linked } = tagOutboundLinks('Sign up at meetdossie.com/signup today', {
      domain: 'meetdossie.com', brand: 'dossie', platform: 'facebook', format: 'video',
      contentId: 'a1b2c3d4', postedAt: now,
    });
    assert.strictEqual(linked, true, 'a bare-domain link (no https://) must still be tagged — the exact bug this replaced');
    assert.ok(/utm_content=/.test(text));
  });

  const e2eSupabaseFetch = makeMockSupabaseFetch({
    social_posts: [
      { id: 'a1b2c3d4-real-uuid', platform: 'facebook', target_owner: 'dossie', content_tag: TAG, posted_at: now,
        hook: 'test hook', hook_type: 'curiosity', cta_type: 'soft', hook_variant: 'A' },
    ],
    founding_applications: [
      { id: 'app-1', status: 'pending', created_at: now, first_touch: { content_tag: TAG }, last_touch: { content_tag: TAG } },
    ],
    subscriptions: [
      { id: 'sub-1', plan: 'solo', status: 'pending_onboarding', created_at: now, first_touch: { content_tag: TAG }, last_touch: { content_tag: TAG } },
    ],
  });
  const e2eHogql = makeMockHogqlRunner({ [TAG]: 42 });

  const e2eSummary = await getAttributionSummary({ days: 30, supabaseFetch: e2eSupabaseFetch, hogqlRunner: e2eHogql });

  await check('summary resolves clicks for the tag', () => {
    const row = e2eSummary.top_content.find((c) => c.content_tag === TAG);
    assert.ok(row, 'tag should appear in top_content');
    assert.strictEqual(row.clicks, 42);
  });
  await check('summary resolves signups for the SAME tag', () => {
    const row = e2eSummary.top_content.find((c) => c.content_tag === TAG);
    assert.strictEqual(row.signups, 1);
  });
  await check('summary resolves paid for the SAME tag', () => {
    const row = e2eSummary.top_content.find((c) => c.content_tag === TAG);
    assert.strictEqual(row.paid, 1);
  });
  await check('the resolved brand matches the tag (dossie)', () => {
    const row = e2eSummary.top_content.find((c) => c.content_tag === TAG);
    assert.strictEqual(row.brand, 'dossie');
    assert.strictEqual(e2eSummary.per_brand.dossie.paid, 1);
    assert.strictEqual(e2eSummary.per_brand.dossie.signups, 1);
  });
  await check('hook_type/cta_type backfilled from social_posts onto the same row', () => {
    const row = e2eSummary.top_content.find((c) => c.content_tag === TAG);
    assert.strictEqual(row.hook_type, 'curiosity');
    assert.strictEqual(row.cta_type, 'soft');
  });
  await check('rust is reported as not-available, never a fabricated zero', () => {
    assert.strictEqual(e2eSummary.rust.supported, false);
    assert.ok(/separate Supabase project/i.test(e2eSummary.rust.reason));
  });

  console.log('\n=== 2. UNTAGGED outcomes are reported as unattributed, never silently dropped ===');
  const untaggedSupabaseFetch = makeMockSupabaseFetch({
    social_posts: [],
    founding_applications: [
      { id: 'app-untagged', status: 'pending', created_at: now, first_touch: null, last_touch: null },
      { id: 'app-tagged', status: 'pending', created_at: now, first_touch: { content_tag: TAG }, last_touch: { content_tag: TAG } },
    ],
    subscriptions: [
      { id: 'sub-untagged', plan: 'solo', status: 'active', created_at: now, first_touch: null, last_touch: null },
    ],
  });
  const untaggedHogql = makeMockHogqlRunner({});
  const untaggedSummary = await getAttributionSummary({ days: 30, supabaseFetch: untaggedSupabaseFetch, hogqlRunner: untaggedHogql });

  await check('untagged signup counted in total, NOT dropped', () => {
    assert.strictEqual(untaggedSummary.totals.signups_total, 2, 'both rows (tagged + untagged) must be in the total');
  });
  await check('untagged signup flagged in unattributed bucket', () => {
    assert.strictEqual(untaggedSummary.totals.signups_unattributed, 1);
  });
  await check('untagged paid counted in total, NOT dropped', () => {
    assert.strictEqual(untaggedSummary.totals.paid_total, 1);
  });
  await check('untagged paid flagged in unattributed bucket, never guessed a tag', () => {
    assert.strictEqual(untaggedSummary.totals.paid_unattributed, 1);
    assert.strictEqual(untaggedSummary.totals.paid_attributed, 0);
  });
  await check('effectiveTag() returns null (not a guess) for a row with no touch data', () => {
    assert.strictEqual(effectiveTag({ first_touch: null, last_touch: null }), null);
  });
  await check('a malformed/foreign tag never parses into a fake brand', () => {
    assert.strictEqual(parseContentTag('not-a-real-tag'), null);
    assert.strictEqual(parseContentTag(''), null);
    assert.strictEqual(parseContentTag(null), null);
  });

  console.log('\n=== 3. PostHog outage surfaces as an explicit error, never a silent 0 ===');
  const outageSupabaseFetch = makeMockSupabaseFetch({ social_posts: [], founding_applications: [], subscriptions: [] });
  const outageSummary = await getAttributionSummary({ days: 7, supabaseFetch: outageSupabaseFetch, hogqlRunner: makeMockHogqlFailure('PostHog 500') });
  await check('clicks_tracking reports the real failure, not "ok"', () => {
    assert.ok(/FAILED/.test(outageSummary.clicks_tracking));
    assert.ok(/PostHog 500/.test(outageSummary.clicks_tracking));
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
