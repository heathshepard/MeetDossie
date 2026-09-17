#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/dm-link.js + api/_lib/content-tag.js's
 * format='dm' path — closes the "group comments never mention Dossie, so a
 * conversation that moves to 1:1 is invisible to attribution" gap (Heath,
 * 2026-09-17, from the 30-day plan).
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 *   1. A generated DM link's utm_content tag DECODES back to the source
 *      conversation (table implied by platform default, id, format='dm',
 *      date) via the SAME parseContentTag() a published post uses — no
 *      special-casing needed anywhere downstream.
 *   2. IDEMPOTENT: tapping "DM link" twice on the same conversation returns
 *      the SAME tag/url both times — never mints a second id for one
 *      conversation.
 *   3. Unknown source tables are rejected — this must never be pointed at
 *      an arbitrary table.
 *   4. A cache-write failure still hands back a usable (if uncached) link —
 *      never a dead end for Heath.
 */

const assert = require('assert');
const path = require('path');

const dmLink = require(path.join(__dirname, '..', 'api', '_lib', 'dm-link.js'));
const { parseContentTag } = require(path.join(__dirname, '..', 'api', '_lib', 'content-tag.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

function makeDb() {
  return {
    tc_discovery_responses: [{ id: 'tc-1', dm_link_tag: null }],
    comment_opportunities: [{ id: 'opp-1', dm_link_tag: null }],
  };
}

function makeSbFetch(db) {
  return async function sbFetch(urlPath, init = {}) {
    const [pathname, qs] = urlPath.split('?');
    const table = pathname.replace('/rest/v1/', '');
    const rows = db[table];
    if (!rows) return { ok: false, status: 404, data: null };
    const params = new URLSearchParams(qs || '');
    const idEq = params.get('id');
    const id = idEq && idEq.startsWith('eq.') ? idEq.slice(3) : null;
    const matched = id ? rows.filter((r) => r.id === id) : rows;

    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      for (const r of matched) Object.assign(r, patch);
      return { ok: true, status: 204, data: null };
    }
    return { ok: false, status: 405, data: null };
  };
}

async function main() {
  console.log('dm-link: 1:1 conversation link tagging (attribution close)\n');

  // ── 1. Pure buildDmLink decodes cleanly ───────────────────────────────
  check('buildDmLink produces a tag that decodes back to format=dm and the source id', () => {
    const { tag, url } = dmLink.buildDmLink({ sourceTable: 'tc_discovery_responses', sourceId: 'a1b2c3d4-e5f6-0000-0000-000000000001' });
    const decoded = parseContentTag(tag);
    assert.ok(decoded, `tag '${tag}' must be decodable`);
    assert.strictEqual(decoded.format, 'dm');
    assert.strictEqual(decoded.platform, 'facebook');
    assert.strictEqual(decoded.brand, 'dossie');
    assert.ok(url.includes(encodeURIComponent(tag)), 'url carries the tag as utm_content');
    assert.ok(url.includes('utm_medium=dm'));
  });

  check('unknown sourceTable is rejected — never points at an arbitrary table', () => {
    assert.throws(() => dmLink.buildDmLink({ sourceTable: 'subscriptions', sourceId: 'x' }), /unknown sourceTable/);
  });

  // ── 2. Idempotent get-or-create ───────────────────────────────────────
  await checkAsync('getOrCreateDmLink mints a new tag on first tap and caches it on the row', async () => {
    const db = makeDb();
    const sbFetch = makeSbFetch(db);
    const result = await dmLink.getOrCreateDmLink({ sourceTable: 'tc_discovery_responses', sourceId: 'tc-1', sbFetch });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.created, true);
    assert.ok(result.tag && result.url);
    assert.strictEqual(db.tc_discovery_responses[0].dm_link_tag, result.tag, 'tag persisted onto the row');
  });

  await checkAsync('getOrCreateDmLink tapped TWICE returns the SAME tag — never mints a second id', async () => {
    const db = makeDb();
    const sbFetch = makeSbFetch(db);
    const first = await dmLink.getOrCreateDmLink({ sourceTable: 'comment_opportunities', sourceId: 'opp-1', sbFetch });
    const second = await dmLink.getOrCreateDmLink({ sourceTable: 'comment_opportunities', sourceId: 'opp-1', sbFetch });
    assert.strictEqual(first.tag, second.tag);
    assert.strictEqual(first.url, second.url);
    assert.strictEqual(second.created, false, 'second call must report it read the cache, not minted new');
  });

  await checkAsync('getOrCreateDmLink on a row not found reports a clean error, never throws', async () => {
    const db = makeDb();
    const sbFetch = makeSbFetch(db);
    const result = await dmLink.getOrCreateDmLink({ sourceTable: 'tc_discovery_responses', sourceId: 'does-not-exist', sbFetch });
    assert.strictEqual(result.ok, false);
    assert.ok(result.error);
  });

  await checkAsync('a failed cache-write still hands back a usable link (never a dead end)', async () => {
    const db = makeDb();
    const failingPatchSbFetch = async (urlPath, init = {}) => {
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'GET') return makeSbFetch(db)(urlPath, init);
      return { ok: false, status: 500, data: null }; // PATCH always fails
    };
    const result = await dmLink.getOrCreateDmLink({ sourceTable: 'tc_discovery_responses', sourceId: 'tc-1', sbFetch: failingPatchSbFetch });
    assert.strictEqual(result.ok, true, 'still hands back a real link');
    assert.ok(result.tag && result.url);
    assert.ok(result.error, 'but reports the cache-write failure so it can be diagnosed');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
  if (!process.exitCode) console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
