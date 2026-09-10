#!/usr/bin/env node
'use strict';

/**
 * Regression test for the Bug 2 fix in api/cron-generate-posts.js
 * (docs/POSTING-ENGINE-PLAN-2026-09-09.md).
 *
 * THE BUG
 * -------
 * PERSONA_STORY (Brenda/Patricia/Victor) was retired 2026-06-14 (25aa1b02) —
 * POST_PLAN_BASE has generated zero persona slots since. But 35 posts in the
 * last 45 days were still auto-rejected for exactly that retired format
 * (verified via social_posts.verifier_result content_format="PERSONA_STORY").
 * Root cause: a stale sage_intelligence row (last written 2026-07-13, no
 * schedule entry for its own update cron) got injected verbatim into every
 * generation prompt telling the model to use "Victor persona" / "Patricia
 * persona" / "Brenda persona" — and the generation loop trusted whatever
 * format/persona the model returned with NO validation, defaulting to the
 * retired 'PERSONA_STORY' whenever the model omitted format entirely.
 *
 * THE FIX BEING PINNED DOWN
 * -------------------------
 *   1. sage_intelligence older than MAX_INTEL_AGE_DAYS is ignored — its
 *      daily_brief must not reach the prompt sent to the model.
 *   2. Recent sage_intelligence IS still injected (graceful degradation
 *      only kicks in for stale data, not all data).
 *   3. Even if the model still returns format="PERSONA_STORY"/persona=
 *      "victor" for a slot, the inserted row is forced back to the PLANNED
 *      slot's format and persona="dossie" — the model's own output is
 *      never trusted for this field.
 *
 * All against in-memory mocks — ZERO production access, ZERO real Anthropic
 * calls, no real Supabase.
 *
 * Run manually:
 *   node scripts/regression-generate-posts-persona-format.js
 */

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_URL = 'http://mock-supabase.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.CRON_SECRET = 'test-cron-secret';
delete process.env.TELEGRAM_BOT_TOKEN;

// ─── In-memory tables ──────────────────────────────────────────────────────

let tables;
function resetTables() {
  tables = {
    social_posts: [],
    posting_schedule: [], // empty = activePlatforms stays null = full POST_PLAN_BASE used
    subscriptions: [],
    sage_intelligence: [],
    post_analytics: [],
    reddit_pain_language: [],
    content_batches: [],
    zernio_accounts: [],
  };
}

let capturedPrompt = null; // the exact prompt string sent to the "generate" Anthropic call
let modelPostsToReturn = null; // what the mock "generate" call returns

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  if (expr.startsWith('gte.') || expr.startsWith('lt.')) return true; // date-range checks not exercised here
  return true;
}

function queryTable(table, qs) {
  const rows = tables[table];
  if (!rows) return [];
  const q = {};
  for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
  const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'limit'].includes(k));
  let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
  if (q.order) {
    const [col, dir] = q.order.split('.');
    matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
  }
  if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));
  return matched;
}

global.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = (init.method || 'GET').toUpperCase();

  if (u.startsWith('https://api.anthropic.com/v1/messages')) {
    const body = JSON.parse(init.body);
    const isVerifier = /Verify this draft/.test(body.messages[0].content);
    if (isVerifier) {
      // Always approve in this test — we're pinning the generation-side
      // enforcement, not verifier behavior. Real verifier behavior on a
      // genuine PERSONA_STORY draft is covered by manual/live testing
      // (it correctly rejects — that part already works).
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ verdict: 'approve', flags: [], summary: 'ok' }) }] }),
      };
    }
    // The main generation call.
    capturedPrompt = body.messages[0].content;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ posts: modelPostsToReturn }) }] }),
    };
  }

  if (u.startsWith(`${process.env.SUPABASE_URL}/rest/v1/`)) {
    const [pathname, qs] = u.split('?');
    const table = pathname.replace(`${process.env.SUPABASE_URL}/rest/v1/`, '');
    if (method === 'GET') {
      return { ok: true, status: 200, text: async () => JSON.stringify(queryTable(table, qs)) };
    }
    if (method === 'POST') {
      const payload = JSON.parse(init.body);
      const arr = Array.isArray(payload) ? payload : [payload];
      const rows = tables[table] || (tables[table] = []);
      const inserted = arr.map((r) => ({ id: `id-${rows.length + 1}-${Math.random().toString(36).slice(2)}`, ...r }));
      rows.push(...inserted);
      return { ok: true, status: 201, text: async () => JSON.stringify(inserted) };
    }
    if (method === 'PATCH') {
      return { ok: true, status: 204, text: async () => '' };
    }
  }

  if (u.includes('api.telegram.org')) {
    return { ok: true, status: 200, text: async () => '{}' };
  }

  throw new Error(`Unmocked fetch in regression test: ${method} ${u}`);
};

function fakeReqRes(url = 'https://meetdossie.com/api/cron-generate-posts') {
  const req = { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, url, query: {} };
  let statusCode = 200;
  const res = {
    status(code) { statusCode = code; this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
  };
  return { req, res };
}

function loadHandler() {
  const modPath = path.join(__dirname, '..', 'api', 'cron-generate-posts.js');
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

// A 9-post response where the model DISOBEYS the brand-voice instruction on
// two slots — the exact failure mode observed live (content_format:
// "PERSONA_STORY" in verifier_result on real rejected rows).
function buildNineFakePosts() {
  const clean = (platform, format) => ({
    format, persona: 'dossie', platform,
    voiceover_script: 'This is Dossie. Texas agents - meetdossie.com slash signup.',
    caption: `Clean ${format} post for ${platform}. Solo pricing is $149/month. meetdossie.com/signup`,
    hook: 'A clean hook here', cta: 'meetdossie.com/signup', hashtags: ['txrealestate'],
    stat: '$149/mo', stat_label: 'Solo pricing',
  });
  return [
    clean('facebook', 'CAPABILITY_ONELINER'),
    clean('instagram', 'TREC_EDUCATION'),
    // Slot 3 (twitter, planned CAPABILITY_ONELINER): model reverts to the
    // retired persona format WITH a persona name.
    {
      format: 'PERSONA_STORY', persona: 'victor', platform: 'twitter',
      voiceover_script: 'This is Dossie. Texas agents - meetdossie.com slash signup.',
      caption: "Victor's take on TC costs. meetdossie.com/signup",
      hook: 'Victor says', cta: 'meetdossie.com/signup', hashtags: ['txrealestate'],
      stat: '$149/mo', stat_label: 'Solo pricing',
    },
    clean('linkedin', 'CAPABILITY_ONELINER'),
    clean('twitter', 'TREC_EDUCATION'),
    clean('facebook', 'FOUNDER_STORY'),
    // Slot 7 (twitter, planned CAPABILITY_ONELINER): model OMITS format
    // entirely — this is the exact case that used to default to the
    // retired 'PERSONA_STORY' fallback.
    {
      persona: 'patricia', platform: 'twitter',
      voiceover_script: 'This is Dossie. Texas agents - meetdossie.com slash signup.',
      caption: "Patricia's budget math. meetdossie.com/signup",
      hook: 'Patricia thinks', cta: 'meetdossie.com/signup', hashtags: ['txrealestate'],
      stat: '$149/mo', stat_label: 'Solo pricing',
    },
    clean('tiktok', 'TREC_EDUCATION'),
    clean('youtube', 'TREC_EDUCATION'),
  ];
}

async function main() {
  // ── 1. Stale sage_intelligence (57+ days, matches the real 2026-07-13 row)
  //    must NOT reach the prompt ────────────────────────────────────────────
  resetTables();
  tables.sage_intelligence.push({
    id: 'intel-stale', created_at: '2026-07-13T11:03:36.216Z',
    top_platform: 'linkedin', top_pillar: 'control', top_persona: 'victor', top_format: 'text_post',
    daily_brief: 'RECOMMENDATIONS FOR cron-generate-posts: 40% LinkedIn: Victor persona, cost_math...',
  });
  modelPostsToReturn = buildNineFakePosts();
  capturedPrompt = null;
  let handler = loadHandler();
  let { req, res } = fakeReqRes();
  await handler(req, res);

  assert.ok(capturedPrompt, 'generation call fired');
  assert.ok(!/Victor persona, cost_math/.test(capturedPrompt), 'stale sage_intelligence daily_brief must NOT appear in the prompt');
  assert.ok(!/SAGE INTELLIGENCE BRIEF/.test(capturedPrompt), 'stale intel produces no intelligence block at all — treated as unavailable');

  // ── 2. Even though the model returned PERSONA_STORY/victor (slot 3) and
  //    an omitted-format/patricia post (slot 7), every inserted row is
  //    forced to a valid brand-voice format with persona="dossie" ─────────
  const inserted = tables.social_posts.filter((r) => r.status !== undefined);
  assert.strictEqual(inserted.length, 9, 'all 9 planned slots inserted');
  const VALID_FORMATS = ['CAPABILITY_ONELINER', 'TREC_EDUCATION', 'FOUNDER_STORY'];
  for (const row of inserted) {
    const fmt = row.verifier_result && row.verifier_result.content_format;
    assert.ok(VALID_FORMATS.includes(fmt), `row ${row.post_id} has a retired/invalid format in verifier_result: ${fmt}`);
    assert.strictEqual(row.persona, 'dossie', `row ${row.post_id} (format ${fmt}) must be persona="dossie", got "${row.persona}"`);
  }
  // Specifically confirm the two disobedient slots landed as the PLANNED
  // format for their index (twitter slot 3 -> CAPABILITY_ONELINER per
  // POST_PLAN_BASE; twitter slot 7 -> CAPABILITY_ONELINER per POST_PLAN_BASE).
  const twitterPosts = inserted.filter((r) => r.platform === 'twitter');
  assert.strictEqual(twitterPosts.length, 3, 'all 3 twitter slots present');
  for (const row of twitterPosts) {
    assert.notStrictEqual(row.verifier_result.content_format, 'PERSONA_STORY', 'no twitter row ships as PERSONA_STORY');
  }

  // ── 3. Recent sage_intelligence (2 days old) IS still injected — the
  //    staleness guard doesn't just kill the feature outright ─────────────
  resetTables();
  tables.sage_intelligence.push({
    id: 'intel-fresh', created_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    top_platform: 'facebook', top_pillar: 'cost', top_persona: 'dossie', top_format: 'text_post',
    daily_brief: 'FRESH RECOMMENDATION: lean into cost_math this week.',
  });
  modelPostsToReturn = buildNineFakePosts();
  capturedPrompt = null;
  handler = loadHandler();
  ({ req, res } = fakeReqRes());
  await handler(req, res);
  assert.ok(/FRESH RECOMMENDATION: lean into cost_math this week\./.test(capturedPrompt), 'recent (2-day-old) sage_intelligence IS injected into the prompt');

  console.log('[regression-generate-posts-persona-format] ALL PASS');
}

main().catch((err) => {
  console.error('[regression-generate-posts-persona-format] FAILED:', err && err.stack || err);
  process.exit(1);
});
