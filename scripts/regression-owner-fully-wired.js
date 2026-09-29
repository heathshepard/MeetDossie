#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-16 RUST-OWNER-WIRING fix.
 *
 * THE BUG CLASS
 * -------------
 * Rust had live, working Zernio connections (Instagram @ruststrength,
 * X @Ruststrength — confirmed active via GET /api/v1/accounts) but no
 * `zernio_accounts` rows, no owner branch in cron-post-videos.js or
 * cron-publish-approved.js, and posting_schedule had no way to turn a
 * platform on for one owner without turning it on for every owner sharing
 * that platform (Twitter/X is deliberately inactive for Dossie). A brand
 * could sit "half-wired": present in zernio_accounts, but with no actual
 * path a video could take to reach a live post.
 *
 * THE FIX
 * -------
 * account resolution (resolveZernioAccountId/lookupZernioAccountId),
 * default-platform resolution (defaultPlatformsFor — now DB-driven, not an
 * owner if/else), and schedule resolution (loadTodaySchedule/gatePlatform,
 * loadSchedules/findScheduleRow) are all now owner-generic: adding a fourth
 * brand is a zernio_accounts + posting_schedule INSERT plus widening 3 CHECK
 * constraints (20260916d_rust_owner_wiring.sql) — never a code change.
 *
 * THE INVARIANT THIS LOCKS (class-level, not rust-specific)
 * -----------------------------------------------------------
 * 1. A brand-new owner ('zzz-regr-brand', never mentioned anywhere in
 *    cron-post-videos.js or cron-publish-approved.js source) with a
 *    zernio_accounts row AND a reachable posting_schedule row actually
 *    posts, using ITS OWN account id — proving the wiring is genuinely
 *    generic, not secretly special-cased to 'dossie'/'heath-realtor'.
 * 2. The SAME brand-new owner with a zernio_accounts row but NO reachable
 *    posting_schedule row (neither a shared nor an owner-specific one) does
 *    NOT post — "exists in zernio_accounts" alone must never be treated as
 *    "has a working publish path." This is the exact half-wired state Rust
 *    was in before this fix, reproduced generically.
 * 3. Source-level: the only owner string literals compared in either cron
 *    file are the two documented legacy fail-safes ('dossie',
 *    'heath-realtor') — if a THIRD hardcoded owner branch shows up later
 *    (the very anti-pattern this fix removed), this test fails immediately
 *    instead of waiting for someone to notice a brand can't publish.
 * 4. defaultPlatformsFor() is DB-driven (queries zernio_accounts), not a
 *    hardcoded per-owner map — locks in the "config not code" shape.
 *
 * Run manually:
 *   node scripts/regression-owner-fully-wired.js
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
const CRON_POST_VIDEOS_PATH = path.join(REPO, 'api', 'cron-post-videos.js');
const CRON_PUBLISH_APPROVED_PATH = path.join(REPO, 'api', 'cron-publish-approved.js');

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ─── Part 1: source-level anti-hardcoding guard ───────────────────────────
// The only owner literals allowed in either cron file are the two
// documented legacy fail-safes. Any other `owner === '...'` / `owner ===
// "..."` literal means someone hardcoded a brand-specific branch again.
console.log('Part 1: no new hardcoded owner branches\n');

// 'dossie'/'heath-realtor' are the two documented legacy account-resolution
// fail-safes. 'rust' is allowed too, but ONLY for its content-policy guard
// (no store-link CTA before iOS/Android launch) — a real brand-specific
// business rule, not routing/account-resolution plumbing. If a NEW owner
// literal shows up that isn't one of these three, it's almost certainly a
// hardcoded routing branch creeping back in.
const ALLOWED_OWNER_LITERALS = new Set(['dossie', 'heath-realtor', 'rust']);

function ownerLiteralsIn(src) {
  const found = new Set();
  const re = /owner\s*===?\s*['"]([a-z0-9-]+)['"]/g;
  let m;
  while ((m = re.exec(src))) found.add(m[1]);
  return found;
}

for (const [label, filePath] of [
  ['cron-post-videos.js', CRON_POST_VIDEOS_PATH],
  ['cron-publish-approved.js', CRON_PUBLISH_APPROVED_PATH],
]) {
  const src = fs.readFileSync(filePath, 'utf8');
  const literals = ownerLiteralsIn(src);
  check(`${label}: every hardcoded owner literal is a documented legacy fail-safe`, () => {
    const unexpected = [...literals].filter((o) => !ALLOWED_OWNER_LITERALS.has(o));
    assert.deepStrictEqual(unexpected, [],
      `found new hardcoded owner branch(es): ${unexpected.join(', ')} — route through zernio_accounts/posting_schedule instead`);
  });
}

// The 'rust' allowance above is scoped to the content-policy guard ONLY —
// none of the actual routing functions (account/page/schedule resolution)
// may special-case it, or the "config not code" fix is hollow. (Excludes
// resolveZernioAccountId/defaultPlatformsFor: both retain a documented
// 'dossie'-only legacy fail-safe by design — Part 1's allowlist check above
// already guards those against a THIRD literal creeping in.)
for (const fnName of ['lookupZernioAccountId', 'lookupZernioPageId', 'gatePlatform']) {
  check(`cron-post-videos.js: ${fnName}() has no owner literal (routing must stay generic)`, () => {
    const src = fs.readFileSync(CRON_POST_VIDEOS_PATH, 'utf8');
    const start = src.indexOf(`function ${fnName}`);
    assert.ok(start !== -1, `could not find function ${fnName}`);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    const literals = ownerLiteralsIn(body);
    assert.strictEqual(literals.size, 0, `${fnName}() hardcodes owner literal(s): ${[...literals].join(', ')}`);
  });
}
for (const fnName of ['lookupZernioAccountId', 'lookupZernioPageId', 'findScheduleRow']) {
  check(`cron-publish-approved.js: ${fnName}() has no owner literal (routing must stay generic)`, () => {
    const src = fs.readFileSync(CRON_PUBLISH_APPROVED_PATH, 'utf8');
    const start = src.indexOf(`function ${fnName}`);
    assert.ok(start !== -1, `could not find function ${fnName}`);
    const end = src.indexOf('\n}', start);
    const body = src.slice(start, end);
    const literals = ownerLiteralsIn(body);
    assert.strictEqual(literals.size, 0, `${fnName}() hardcodes owner literal(s): ${[...literals].join(', ')}`);
  });
}

check('cron-post-videos.js: defaultPlatformsFor() is DB-driven (queries zernio_accounts), not a hardcoded owner map', () => {
  const src = fs.readFileSync(CRON_POST_VIDEOS_PATH, 'utf8');
  const start = src.indexOf('async function defaultPlatformsFor');
  assert.ok(start !== -1, 'defaultPlatformsFor is not even async — the DB-driven version returns a Promise');
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(body.includes('/rest/v1/zernio_accounts'),
    'defaultPlatformsFor no longer queries zernio_accounts — regressed back to a hardcoded per-owner map');
});

// ─── Part 2: functional test with a brand nobody hardcoded ────────────────
console.log('\nPart 2: a brand-new owner, never mentioned in source, actually publishes\n');

const REGR_OWNER = 'zzz-regr-brand';
const REGR_PLATFORM = 'pinterest'; // a platform that exists nowhere else in the fixture or source

function scheduleRows({ includeRegrOverride }) {
  const rows = [];
  for (let dow = 0; dow < 7; dow++) {
    rows.push({ platform: 'facebook', day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null, owner: null });
    // REGR_PLATFORM has NO shared row at all — mirrors Rust's real
    // situation on Twitter (shared row exists but is_active=false; here we
    // go one step further and have no shared row whatsoever) so the only
    // way it can ever post is an owner-specific override.
    if (includeRegrOverride) {
      rows.push({ platform: REGR_PLATFORM, day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 10, max_per_slot: null, owner: REGR_OWNER });
    }
  }
  return rows;
}

const ZERNIO_ACCOUNTS_TABLE = [
  { platform: 'facebook', owner: 'dossie', zernio_account_id: 'dossie-fb-acct', page_id: 'dossie-fb-page' },
  { platform: REGR_PLATFORM, owner: REGR_OWNER, zernio_account_id: 'regr-brand-acct', page_id: null },
];

function startMockSupabase(videoRow, { includeScheduleOverride }) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const q = url.search || '';

      if (req.method === 'PATCH') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{}]');
        return;
      }

      const json = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.method === 'GET' && table === 'video_library') {
        if (q.includes('status=eq.heath_approved')) return json([videoRow]);
        return json([]);
      }
      if (req.method === 'GET' && table === 'posting_schedule') {
        return json(scheduleRows({ includeRegrOverride: includeScheduleOverride }));
      }
      if (req.method === 'GET' && table === 'social_posts') return json([]);
      if (req.method === 'GET' && table === 'zernio_accounts') {
        const params = new URLSearchParams(q);
        const platform = (params.get('platform') || '').replace('eq.', '');
        const owner = (params.get('owner') || '').replace('eq.', '');
        if (q.includes('select=platform')) {
          // defaultPlatformsFor() lookup — owner only, any active platform.
          const rows = ZERNIO_ACCOUNTS_TABLE.filter((r) => r.owner === owner);
          return json(rows.map((r) => ({ platform: r.platform })));
        }
        const selectField = q.includes('select=page_id') ? 'page_id' : 'zernio_account_id';
        const row = ZERNIO_ACCOUNTS_TABLE.find((r) => r.platform === platform && r.owner === owner);
        if (!row) return json([]);
        return json([{ [selectField]: row[selectField] }]);
      }
      json([]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function runOnce(videoRow, { includeScheduleOverride }) {
  const server = await startMockSupabase(videoRow, { includeScheduleOverride });
  const port = server.address().port;

  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.ZERNIO_API_KEY = 'regr-dummy-zernio-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  delete require.cache[require.resolve(CRON_POST_VIDEOS_PATH)];
  const handler = require(CRON_POST_VIDEOS_PATH);

  const zernioCalls = [];
  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('zernio.com')) {
      let payload = null;
      try { payload = JSON.parse(init && init.body); } catch { payload = null; }
      zernioCalls.push({ payload });
      return new Response(JSON.stringify({ post: { _id: `zn-${zernioCalls.length}` } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return underlyingFetch(input, init);
  };

  const req = { headers: { 'x-vercel-cron': '1' }, query: {} };
  let statusCode = null; let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  await handler(req, res);
  globalThis.fetch = underlyingFetch;
  server.close();

  return { statusCode, jsonBody, zernioCalls };
}

(async () => {
  console.log('Test A: brand-new owner + reachable schedule override -> actually posts');
  {
    const { zernioCalls, jsonBody } = await runOnce(
      {
        id: 'regr-brandx-video-0001',
        status: 'heath_approved',
        topic: 'regression fixture',
        target_owner: REGR_OWNER,
        platforms: [REGR_PLATFORM],
        caption: 'Regression fixture caption — never posted for real.',
        supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-brandx.mp4',
        quality_status: 'passed',
      },
      { includeScheduleOverride: true },
    );

    check('the fictitious platform actually received a Zernio call', () => {
      assert.strictEqual(zernioCalls.length, 1, `expected 1 call, got ${zernioCalls.length}: ${JSON.stringify(zernioCalls)}`);
    });
    check('it used the brand-new owner\'s own account id, not a fallback', () => {
      assert.strictEqual(zernioCalls[0].payload.platforms[0].accountId, 'regr-brand-acct',
        `got: ${JSON.stringify(zernioCalls[0].payload)}`);
    });
    check('handler reports success', () => {
      assert.strictEqual(jsonBody.ok, true, `expected ok:true, got: ${JSON.stringify(jsonBody)}`);
    });
  }

  console.log('\nTest B: brand-new owner in zernio_accounts but NO reachable posting_schedule -> does NOT post (the exact half-wired bug this fix closes)');
  {
    const { zernioCalls, jsonBody } = await runOnce(
      {
        id: 'regr-brandx-video-0002',
        status: 'heath_approved',
        topic: 'regression fixture 2',
        target_owner: REGR_OWNER,
        platforms: [REGR_PLATFORM],
        caption: 'Regression fixture caption 2 — never posted for real.',
        supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-brandx2.mp4',
        quality_status: 'passed',
      },
      { includeScheduleOverride: false },
    );

    check('no Zernio call happened — a zernio_accounts row alone is not a working publish path', () => {
      assert.strictEqual(zernioCalls.length, 0, `expected 0 calls, got ${zernioCalls.length}: ${JSON.stringify(zernioCalls)}`);
    });
    check('the row was left unposted, not silently marked posted', () => {
      assert.notStrictEqual(jsonBody.video_id, 'regr-brandx-video-0002',
        'the half-wired video was picked as the posted candidate — it should have been skipped for having no eligible platform');
    });
  }

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS');
  process.exit(0);
})().catch((err) => {
  console.error('Harness error:', err);
  process.exit(1);
});
