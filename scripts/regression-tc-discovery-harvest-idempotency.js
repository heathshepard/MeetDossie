#!/usr/bin/env node
'use strict';

/**
 * Regression test for the TC discovery response-capture layer
 * (scripts/harvest-tc-discovery-responses.js +
 * supabase/migrations/20260907_tc_discovery_responses.sql).
 *
 * THE RISK BEING PINNED DOWN
 * --------------------------
 * ~48 campaign posts (docs/TC-DISCOVERY-CAMPAIGN.md, Sep 8-21) get their
 * comment threads re-harvested on a +24h / +72h / every-3-days cadence. If
 * the harvester is not idempotent, every re-harvest duplicates every
 * previously captured comment and the table becomes garbage precisely as it
 * accumulates the campaign's entire value. And if comment_text is ever
 * cleaned/trimmed, the verbatim-language doctrine is broken.
 *
 * TESTS (all against a local mock PostgREST — ZERO production access; the
 * mock URL is set before the module loads so a pre-fix tree can't phone
 * production either):
 *   1. IDEMPOTENCY: upserting the identical comment set twice inserts rows
 *      only once; the second pass bumps last_seen_at on the existing rows
 *      and inserts nothing.
 *   2. Re-harvest with 1 new comment inserts exactly that 1 row.
 *   3. VERBATIM: stored comment_text is byte-identical to the scraped text
 *      (leading/trailing whitespace and inner newlines preserved).
 *   4. Cadence math: not due before +24h; due at +24h (pass 1); due at +72h
 *      (pass 2); then every 3 days from last_harvested_at; never after the
 *      45-day window.
 *   5. Question inference: explicit discovery_question_id wins; body-snippet
 *      fallback maps variant-A/B copy to the right Q id; unknown body → null.
 *   6. recordHarvestPass touches ONLY harvest metadata on group_posts
 *      (last_harvested_at + harvest_count).
 *   7. READ-ONLY static guard: the harvester source contains no
 *      keyboard.type / .fill( / composer "Post" button interaction.
 *
 * Run manually:
 *   node scripts/regression-tc-discovery-harvest-idempotency.js
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
// Mirrors the DB's generated column:
// md5(btrim(regexp_replace(comment_text, '\s+', ' ', 'g')))
const normHash = (s) => md5(String(s).replace(/\s+/g, ' ').trim());

// ─── Mock PostgREST ───────────────────────────────────────────────────────────

const db = {
  tc_discovery_responses: [],
  group_posts: [],
};
let nextId = 1;

function parseQuery(url) {
  const q = new URL(url, 'http://x').searchParams;
  const out = {};
  for (const [k, v] of q.entries()) out[k] = v;
  return out;
}

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === expr.slice(3);
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  return true;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const [pathname] = req.url.split('?');
    const table = pathname.replace('/rest/v1/', '');
    const q = parseQuery(req.url);
    const rows = db[table];
    if (!rows) { res.writeHead(404); res.end('{}'); return; }

    const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
    const matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(matched));
    } else if (req.method === 'POST') {
      const payload = JSON.parse(body);
      const arr = Array.isArray(payload) ? payload : [payload];
      const conflictCols = (q.on_conflict || '').split(',').filter(Boolean);
      for (const r of arr) {
        const row = { id: String(nextId++), ...r };
        if (table === 'tc_discovery_responses') row.comment_hash = normHash(row.comment_text);
        const dupe = conflictCols.length > 0 && rows.some((ex) => conflictCols.every((c) => ex[c] === row[c]));
        if (!dupe) rows.push(row);
      }
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end('[]');
    } else if (req.method === 'PATCH') {
      const patch = JSON.parse(body);
      for (const r of matched) Object.assign(r, patch);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(405); res.end();
    }
  });
});

// ─── The tests ────────────────────────────────────────────────────────────────

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Point the harvester at the mock BEFORE it loads (its .env.local loader
  // only fills unset vars, so these stick — and a pre-fix tree can't reach
  // production through them either).
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';

  const harvester = require(path.join(__dirname, 'harvest-tc-discovery-responses.js'));
  const { isDue, inferQuestionId, upsertComments, recordHarvestPass } = harvester;

  const post = {
    id: 'post-uuid-1',
    group_name: 'DFW Realtors - Network & Collaborate',
    post_url: 'https://www.facebook.com/groups/531847711158328/posts/1792845771725176/',
    post_body: 'Curious what other agents have run into - if you have used a TC before, what is the ONE thing that drove you the most crazy about the experience?',
    posted_at: '2026-09-07T21:00:54.232+00:00',
    discovery_question_id: null,
    last_harvested_at: null,
    harvest_count: 0,
  };
  db.group_posts.push({ ...post });

  const verbatim = '  Communication, 100%.\nMy last TC went DARK for 9 days mid-option period...  ';
  const comments1 = [
    { author: 'Jane Agent', text: verbatim, permalink: 'https://www.facebook.com/groups/x/posts/1/?comment_id=11', atRaw: '2h', at: null },
    { author: 'Bob Broker', text: 'Timelines. Every time.', permalink: null, atRaw: '1h', at: null },
  ];

  // 1. First harvest inserts both
  const r1 = await upsertComments(post, comments1, '2026-09-08T21:30:00Z');
  assert.strictEqual(r1.inserted, 2, 'first pass inserts 2');
  assert.strictEqual(db.tc_discovery_responses.length, 2, 'table has 2 rows');

  // 1b. IDEMPOTENCY: identical second harvest inserts nothing, bumps last_seen_at
  const r2 = await upsertComments(post, comments1, '2026-09-10T21:30:00Z');
  assert.strictEqual(r2.inserted, 0, 'second pass inserts 0 (idempotent)');
  assert.strictEqual(r2.seen, 2, 'second pass marks both as seen');
  assert.strictEqual(db.tc_discovery_responses.length, 2, 'STILL 2 rows after re-harvest — no duplicates');
  assert.ok(db.tc_discovery_responses.every((r) => r.last_seen_at === '2026-09-10T21:30:00Z'), 'last_seen_at bumped');

  // 2. Re-harvest with one new comment inserts exactly one
  const comments2 = [...comments1, { author: 'Cara TC', text: 'Chasing signatures caps me at 12 files.', permalink: null, atRaw: '5m', at: null }];
  const r3 = await upsertComments(post, comments2, '2026-09-13T21:30:00Z');
  assert.strictEqual(r3.inserted, 1, 'third pass inserts only the new comment');
  assert.strictEqual(db.tc_discovery_responses.length, 3, '3 rows total');

  // 2b. FB DOUBLE-RENDER: the live DOM renders every comment twice with
  // whitespace-only differences (verified 2026-09-07, Q2 DFW post: "me." + 3
  // spaces vs 1). Whitespace variants of an already-stored comment — and a
  // same-comment_id second rendering — must NOT create new rows.
  const wsVariants = [
    { author: 'Jane Agent', text: verbatim.replace(/\n/g, ' \n').replace(/  +/g, '   '), permalink: null, atRaw: '2h', at: null },
    { author: 'Bob Broker', text: 'Timelines.   Every time.', permalink: 'https://x/?comment_id=999', atRaw: '1h', at: null },
    { author: 'Bob Broker', text: 'Timelines.  Every time.', permalink: 'https://y/?comment_id=999', atRaw: '1h', at: null },
  ];
  const r4 = await upsertComments(post, wsVariants, '2026-09-14T21:30:00Z');
  assert.strictEqual(r4.inserted, 0, 'whitespace-variant re-renders insert nothing');
  assert.strictEqual(db.tc_discovery_responses.length, 3, 'STILL 3 rows — double-render dedupe holds');

  // 3. VERBATIM: byte-identical, whitespace and newlines intact
  const stored = db.tc_discovery_responses.find((r) => r.commenter_name === 'Jane Agent');
  assert.strictEqual(stored.comment_text, verbatim, 'comment_text stored VERBATIM (untrimmed, newlines intact)');
  assert.strictEqual(stored.question_id, 'Q2', 'question inferred from body snippet');
  assert.strictEqual(stored.theme ?? null, null, 'classification left null at write time');

  // 4. Cadence math
  const t0 = Date.parse(post.posted_at);
  assert.strictEqual(isDue({ ...post, harvest_count: 0 }, t0 + 23 * 3600e3), false, 'not due before +24h');
  assert.strictEqual(isDue({ ...post, harvest_count: 0 }, t0 + 25 * 3600e3), true, 'due at +24h');
  assert.strictEqual(isDue({ ...post, harvest_count: 1 }, t0 + 48 * 3600e3), false, 'pass 2 not due at +48h');
  assert.strictEqual(isDue({ ...post, harvest_count: 1 }, t0 + 73 * 3600e3), true, 'pass 2 due at +72h');
  const lastIso = new Date(t0 + 5 * 86400e3).toISOString();
  assert.strictEqual(isDue({ ...post, harvest_count: 2, last_harvested_at: lastIso }, t0 + 6 * 86400e3), false, 'every-3-days: not due 1d after last');
  assert.strictEqual(isDue({ ...post, harvest_count: 2, last_harvested_at: lastIso }, t0 + 8.1 * 86400e3), true, 'every-3-days: due 3d after last');
  assert.strictEqual(isDue({ ...post, harvest_count: 5 }, t0 + 50 * 86400e3), false, 'never due after 45-day window');
  assert.strictEqual(isDue({ ...post, post_url: null }, t0 + 25 * 3600e3), false, 'no permalink, never due');

  // 5. Question inference
  assert.strictEqual(inferQuestionId({ discovery_question_id: 'Q13', post_body: 'whatever' }), 'Q13', 'explicit id wins');
  assert.strictEqual(inferQuestionId({ post_body: 'For the agents using a TC - what do y\'all actually pay? Per file, flat monthly?' }), 'Q6', 'Q6 variant A');
  assert.strictEqual(inferQuestionId({ post_body: 'What would it actually take for you to leave a TC you have used for a while?' }), 'Q8', 'Q8 variant B');
  assert.strictEqual(inferQuestionId({ post_body: 'Totally unrelated post about open houses' }), null, 'unknown body → null, never guessed');

  // 6. recordHarvestPass touches only harvest metadata
  const before = JSON.parse(JSON.stringify(db.group_posts[0]));
  await recordHarvestPass(db.group_posts[0], '2026-09-08T21:31:00Z');
  const after = db.group_posts[0];
  assert.strictEqual(after.last_harvested_at, '2026-09-08T21:31:00Z');
  assert.strictEqual(after.harvest_count, 1);
  for (const k of Object.keys(before)) {
    if (k === 'last_harvested_at' || k === 'harvest_count') continue;
    assert.deepStrictEqual(after[k], before[k], `group_posts.${k} untouched by harvest`);
  }

  // 7. Read-only static guard on the harvester source
  const src = fs.readFileSync(path.join(__dirname, 'harvest-tc-discovery-responses.js'), 'utf8');
  for (const forbidden of ['keyboard.type', '.fill(', "name: 'Post'", 'aria-label="Post"', "'Reply'", '"Like"']) {
    assert.ok(!src.includes(forbidden), `harvester source must not contain ${forbidden} (read-only guarantee)`);
  }

  console.log('PASS: tc-discovery harvest idempotency + verbatim + cadence + read-only (7 groups, all assertions green)');
}

main()
  .then(() => { server.close(); process.exit(0); })
  .catch((err) => { server.close(); console.error('FAIL:', err.message); process.exit(1); });
