#!/usr/bin/env node
'use strict';

/**
 * Regression test for the DAILY 5-GROUP-POST pipeline
 * (api/_lib/daily-group5-post-generator.js + api/cron-daily-group5-posts.js +
 * api/group5-post-callback.js + api/telegram-webhook.js gp5_* +
 * scripts/fb-group5-post-queue.js + scripts/_lib/group-post-content-gate.js +
 * scripts/_lib/group-post-dedup.js + scripts/_lib/group-post-watchlist.js +
 * supabase/migrations/20260909_group_post5_daily.sql).
 *
 * Heath's decision 2026-09-09, verbatim: "people can post more than once a
 * day. 5 groups 1 post to each group per day is fone" (5/day, one per
 * group), and "do the posts like 20 minutes apart" (18-24 min varied).
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 * Same Facebook profile as the comment-opportunity pipeline — one shadowban
 * ends the whole distribution strategy. So:
 *   1. APPROVAL GATE: nothing may ever post without Heath's explicit Approve
 *      or edit-reply. The queue must only select pipeline='daily5'
 *      status='approved' rows.
 *   2. CAPS: the dedicated 'facebook_group_post' budget (5/day = exactly
 *      one per target group) blocks posting; over-cap approved rows stay
 *      queued, never dropped.
 *   3. SPACING: 18-24 min varied gap (floor 18 + jitter), never metronomic
 *      20:00; at most ONE post per run, ever.
 *   4. NO SAME-GROUP DUPLICATE IN 30 DAYS: exact-hash match, near-duplicate
 *      word-overlap match, and same-hook-type-reused-in-group all block.
 *   5. DFW HARD NO-PROMO: a promotional/product-adjacent body is blocked in
 *      CODE (not a prompt suggestion) for dfw_network_collab, unconditionally.
 *   6. CIRCUIT BREAKER: SHARED with the comment pipeline (one FB profile) —
 *      a halt set by either pipeline stops both.
 *   7. WATCHLIST HANDOFF: a confirmed post registers in comment_watchlist
 *      (direction='heath_own_post', source_table='group_posts') so the
 *      guest-thread watcher catches replies.
 *   8. SUPPRESSION LIES: a telegram-gate-suppressed send must NOT stamp
 *      telegram_sent_at / leave the row anywhere but 'draft' for retry.
 *
 * All against in-memory mocks — ZERO production access, no browser, no
 * Telegram, no Claude, no child_process.
 *
 * Run manually:
 *   node scripts/regression-group-post-pipeline.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

// ─── In-memory PostgREST mock (function-level, no HTTP) ──────────────────────

const db = {
  group_posts: [],
  comment_watchlist: [],
  comment_caps_state: [],
};

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  if (expr.startsWith('gte.')) {
    const v = decodeURIComponent(expr.slice(4));
    return row[key] != null && String(row[key]) >= v;
  }
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  return true;
}

let nextId = 1;
async function mockSbFetch(urlPath, init = {}) {
  const [pathname, qs] = urlPath.split('?');
  const table = pathname.replace('/rest/v1/', '');
  const rows = db[table];
  if (!rows) return { ok: false, status: 404, data: null };
  const q = {};
  for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
  const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
  let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
  if (q.order) {
    const [col, dir] = q.order.split('.');
    matched = [...matched].sort((a, b) => {
      const av = a[col]; const bv = b[col];
      const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return cmp * (dir === 'desc' ? -1 : 1);
    });
  }
  if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));

  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET') return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
  if (method === 'POST') {
    const payload = JSON.parse(init.body);
    const arr = Array.isArray(payload) ? payload : [payload];
    const inserted = [];
    for (const r of arr) {
      const row = { id: `id-${nextId++}`, ...r };
      rows.push(row);
      inserted.push(row);
    }
    return { ok: true, status: 201, data: inserted };
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(init.body);
    for (const r of matched) {
      const real = rows.find((x) => x.id === r.id) || r;
      Object.assign(real, patch);
    }
    const wantsRep = String((init.headers || {}).Prefer || '').includes('return=representation');
    return { ok: true, status: wantsRep ? 200 : 204, data: wantsRep ? matched.map((r) => ({ ...rows.find((x) => x.id === r.id) })) : null };
  }
  return { ok: false, status: 405, data: null };
}

function makeHaltState() {
  let entry = null;
  return {
    isHalted: () => entry !== null,
    setHalt: (reason, detail) => { entry = { reason, ...detail }; return entry; },
    getHalt: () => entry,
    clearHalt: () => { entry = null; },
  };
}

const quietLog = { log: () => {}, warn: () => {}, error: () => {} };

// ─── Load modules under test ─────────────────────────────────────────────────

const gate = require(path.join(__dirname, '_lib', 'group-post-content-gate.js'));
const dedup = require(path.join(__dirname, '_lib', 'group-post-dedup.js'));
const watchlistLib = require(path.join(__dirname, '_lib', 'group-post-watchlist.js'));
const caps = require(path.join(__dirname, '_lib', 'comment-caps.js'));
const gen = require(path.join(__dirname, '..', 'api', '_lib', 'daily-group5-post-generator.js'));
const queue = require(path.join(__dirname, 'fb-group5-post-queue.js'));
const cb = require(path.join(__dirname, '..', 'api', 'group5-post-callback.js'));
const telegramGate = require(path.join(__dirname, '..', 'api', '_lib', 'telegram-gate.js'));

async function main() {
  // ── Gate allowlist ─────────────────────────────────────────────────────────
  assert.ok(telegramGate.ALWAYS_ALLOW.has('cron-daily-group5-posts'),
    'cron-daily-group5-posts must be in telegram-gate ALWAYS_ALLOW — a gated notification silently stalls approvals');

  // ── Caps config: 5/day, 18-min floor ───────────────────────────────────────
  assert.strictEqual(caps.PLATFORM_DAILY_CAPS.facebook_group_post, 5,
    'facebook_group_post budget must be exactly 5/day (one per target group, Heath 2026-09-09)');
  assert.strictEqual(caps.MIN_GAP_MINUTES.facebook_group_post, 18,
    'facebook_group_post spacing floor must be 18 min (18-24 varied, Heath: "20 minutes apart")');

  // ── 5. DFW HARD NO-PROMO: code-level, not a prompt suggestion ─────────────
  const dfwPromo = gate.checkGroupContentGate('dfw_network_collab', 'Check out Dossie, sign up at meetdossie.com/signup today!', null);
  assert.strictEqual(dfwPromo.allowed, false, 'DFW blocks a promotional body');
  assert.strictEqual(dfwPromo.policy, 'hard_no_promo', 'DFW policy is hard_no_promo');
  assert.ok(gate.ALWAYS_NO_PROMO.has('dfw_network_collab'), 'DFW is in the never-flippable set');

  const dfwClean = gate.checkGroupContentGate('dfw_network_collab', 'Anyone else seeing appraisals come in low this quarter? Curious what you are all doing about it.', null);
  assert.strictEqual(dfwClean.allowed, true, 'DFW allows a genuinely value-only post');

  // Other 4 groups ALSO default to value-only today (Sage's explicit
  // recommendation, 2026-09-09 — none of the 5 groups are confirmed-safe
  // for product-adjacent content yet), even though their policy key differs
  // from DFW's hard-coded never-flip.
  for (const key of ['tc_admins', 'tc_vas', 'kw_re_group', 'tx_re_agents']) {
    const blocked = gate.checkGroupContentGate(key, 'I built Dossie to handle this — meetdossie.com/signup', null);
    assert.strictEqual(blocked.allowed, false, `${key} also blocks promo content today (value_only default)`);
    assert.strictEqual(blocked.policy, 'value_only', `${key} policy is value_only (not hard_no_promo — flippable later per-group)`);
  }
  // Unknown group key fails SAFE (strictest policy), never fails open.
  const unknown = gate.checkGroupContentGate('some_new_group_never_configured', 'Check out Dossie', null);
  assert.strictEqual(unknown.allowed, false, 'an unconfigured group key fails safe (blocked), never fails open');

  // A bare URL blocks even without a banned phrase.
  const urlBlock = gate.checkGroupContentGate('kw_re_group', 'Found this great resource: https://example.com/thing', null);
  assert.strictEqual(urlBlock.allowed, false, 'a bare URL is blocked as a promo signal even without a banned term');

  // ── 4. NO SAME-GROUP DUPLICATE WITHIN 30 DAYS ──────────────────────────────
  const recent = [
    { group_key: 'kw_re_group', post_body: 'Anyone else dread tracking the option period? I miscalculated once and it almost cost my client $2500.', hook_type: 'ask_advice', created_at: new Date(Date.now() - 5 * 86400000).toISOString() },
  ];
  const exactDup = dedup.checkDuplicate(
    'Anyone else dread tracking the option period? I miscalculated once and it almost cost my client $2500.',
    'ask_advice', recent,
  );
  assert.strictEqual(exactDup.duplicate, true, 'exact-body repeat is a duplicate');
  assert.strictEqual(exactDup.reason, 'exact_body_match', 'exact match reason is exact_body_match');

  const nearDup = dedup.checkDuplicate(
    'Anyone else dread tracking the option period? I once miscalculated it and it nearly cost my client twenty five hundred dollars.',
    'ask_advice', recent,
  );
  assert.strictEqual(nearDup.duplicate, true, 'near-duplicate wording with high word-overlap is still blocked');

  const hookReuse = dedup.checkDuplicate(
    'Totally different words about a totally different topic involving lenders and appraisals this quarter in my market.',
    'ask_advice', recent,
  );
  assert.strictEqual(hookReuse.duplicate, true, 'same hook_type reused in the same group within 30 days is blocked even with different wording');
  assert.ok(hookReuse.reason.startsWith('hook_reused'), 'reason names the hook reuse');

  const genuinelyFresh = dedup.checkDuplicate(
    'Totally different words about a totally different topic involving lenders and appraisals this quarter in my market.',
    'contrarian', recent,
  );
  assert.strictEqual(genuinelyFresh.duplicate, false, 'different content AND different hook_type is not a duplicate');

  // Outside the 30-day window: no longer counted.
  const stale = [{ group_key: 'kw_re_group', post_body: 'Same exact text here for the stale check case only.', hook_type: 'ask_advice', created_at: new Date(Date.now() - 45 * 86400000).toISOString() }];
  const windowed = dedup.withinDedupeWindow(stale, 'kw_re_group', new Date());
  assert.strictEqual(windowed.length, 0, 'a post older than 30 days drops out of the dedupe window');

  // Different group: same body is fine (dedupe is per-group, not global).
  const otherGroupDup = dedup.checkDuplicate(
    'Anyone else dread tracking the option period? I miscalculated once and it almost cost my client $2500.',
    'ask_advice', dedup.withinDedupeWindow(recent, 'tc_admins', new Date()),
  );
  assert.strictEqual(otherGroupDup.duplicate, false, 'dedupe is per-group — the same body in a DIFFERENT group is not blocked');

  // ── 7. WATCHLIST HANDOFF (extracted helper) ───────────────────────────────
  db.comment_watchlist.length = 0;
  const wRes = await watchlistLib.registerGroupPostWatch(
    mockSbFetch,
    { group_name: 'DFW Realtors', post_body: 'Anyone else seeing appraisals come in low?' },
    'gp5-post-id-1',
    'https://www.facebook.com/groups/531847711158328/posts/999/',
  );
  assert.strictEqual(wRes.ok, true, 'watchlist registration succeeds');
  assert.strictEqual(db.comment_watchlist.length, 1, 'one watchlist row created');
  const watch = db.comment_watchlist[0];
  assert.strictEqual(watch.direction, 'heath_own_post', 'watch direction is heath_own_post for a group post');
  assert.strictEqual(watch.source_table, 'group_posts', 'watch provenance is group_posts');
  assert.strictEqual(watch.source_id, 'gp5-post-id-1', 'watch links back to the group_posts row');
  assert.strictEqual(watch.thread_url, 'https://www.facebook.com/groups/531847711158328/posts/999/', 'watch thread_url is the posted URL');

  // fb-group-poster.js calls this same helper on every confirmed post —
  // verify the call site was actually refactored to use it (not still inlined).
  const posterSrc = fs.readFileSync(path.join(__dirname, 'fb-group-poster.js'), 'utf8');
  assert.ok(posterSrc.includes("require('./_lib/group-post-watchlist')"), 'fb-group-poster.js uses the extracted watchlist helper');
  assert.ok(posterSrc.includes('registerGroupPostWatch('), 'fb-group-poster.js calls registerGroupPostWatch on a confirmed post');

  // ── Generator integration: 5 formats, gate + dedup enforced end-to-end ────
  db.group_posts.length = 0;
  const groups = gen.loadTargetGroups();
  assert.strictEqual(groups.length, 5, 'exactly 5 target groups loaded from comment-hunt-groups.json');
  assert.deepStrictEqual(
    groups.map((g) => g.key).sort(),
    ['dfw_network_collab', 'kw_re_group', 'tc_admins', 'tc_vas', 'tx_re_agents'].sort(),
    'target groups match comment-hunt-groups.json exactly',
  );

  // Distinct low-overlap bodies per call -- a real Claude call against 3
  // scaffold variants per format produces genuinely different text, not
  // "Fresh genuine question number N" with one word swapped. Using
  // near-identical mock bodies here used to sail through because nothing
  // compared across groups; now that CROSS-GROUP dedup is real (the actual
  // 2026-09-11 bug fix), the mock has to behave like real generation does.
  const CLEAN_BODIES = [
    'Anyone else had a seller flat refuse every repair after inspection even the ones that will come right back up with the next buyer, curious how common that stance is these days.',
    'Had a closing slide at the very end over a documentation gap, a septic record nobody chased down early, curious what paperwork gap has bitten other people lately.',
    'Escalation clauses get pitched as a guaranteed win and they are not, they make sense with a real ceiling and real discipline, they backfire when someone uses one to avoid picking a number.',
    'Genuine question on how thoroughly folks actually read a seller disclosure notice before writing an offer versus after the contract is already executed, what is the real habit not the textbook answer.',
    'Curious what everyone actually does for multiple offer communication once you know there is competition, a deadline and highest and best call versus just letting it play out quietly.',
  ];
  let genCalls = 0;
  const cleanGenerate = async () => {
    const body = CLEAN_BODIES[genCalls % CLEAN_BODIES.length];
    genCalls++;
    return { post_body: body };
  };
  const sentMessages = [];
  const okSend = async (text, kb) => { sentMessages.push({ text, kb }); return { ok: true, status: 200, data: { ok: true, result: { message_id: 1000 + sentMessages.length } } }; };

  const result1 = await gen.runDailyGroup5PostGeneration({
    sbFetch: mockSbFetch, generate: cleanGenerate, send: okSend,
    loadPainLines: async () => [], log: () => {},
  });
  assert.strictEqual(result1.drafted, 5, 'one draft generated per group (5 total)');
  assert.strictEqual(result1.notified, 5, 'all 5 sent to Telegram');
  assert.strictEqual(db.group_posts.filter((r) => r.pipeline === 'daily5').length, 5, '5 daily5 rows in group_posts');
  assert.ok(db.group_posts.every((r) => r.status === 'draft'), 'every generated row starts status=draft, never auto-approved');
  const groupKeysUsed = db.group_posts.map((r) => r.group_key).sort();
  assert.deepStrictEqual(groupKeysUsed, groups.map((g) => g.key).sort(), 'exactly one post per group, no group skipped or doubled');
  // Real sample output 2026-09-09 caught this: without cross-group format
  // tracking, 2 of 5 groups landed on the SAME format in the same run
  // ('resource_giveaway' twice, 'contrarian' twice) — "one idea rewritten
  // five ways", the exact failure this pipeline exists to avoid. At exactly
  // 5 formats / 5 groups, every hook_type in a single day's run must be distinct.
  const hookTypesUsed = db.group_posts.filter((r) => r.pipeline === 'daily5').map((r) => r.hook_type);
  assert.strictEqual(new Set(hookTypesUsed).size, 5, `all 5 daily posts use a DIFFERENT format in the same run, got: ${hookTypesUsed.join(', ')}`);
  assert.strictEqual(sentMessages.length, 5, 'exactly 5 Telegram approval messages sent');
  for (const msg of sentMessages) {
    const buttons = msg.kb.inline_keyboard[0].map((b) => b.text).join(',');
    assert.strictEqual(buttons, 'Approve,Edit,Skip', 'buttons are exactly Approve / Edit / Skip');
  }

  // ── DFW's row specifically never carries a banned term (belt + suspenders
  //    on top of the pure content-gate unit test above) ──────────────────────
  const dfwRow = db.group_posts.find((r) => r.group_key === 'dfw_network_collab');
  assert.ok(dfwRow, 'DFW row exists');
  const dfwGateCheck = gate.checkGroupContentGate('dfw_network_collab', dfwRow.post_body, null);
  assert.strictEqual(dfwGateCheck.allowed, true, 'the ACTUAL generated DFW post body passes its own hard gate');

  // ── A generator that keeps returning promotional content gets skipped,
  //    never inserted, after the retry ────────────────────────────────────────
  db.group_posts.length = 0;
  let promoGenCalls = 0;
  const promoGenerate = async () => { promoGenCalls++; return { post_body: 'I built Dossie to handle this — meetdossie.com/signup' }; };
  const result2 = await gen.runDailyGroup5PostGeneration({
    sbFetch: mockSbFetch, generate: promoGenerate, send: okSend,
    loadPainLines: async () => [], log: () => {},
  });
  assert.strictEqual(result2.drafted, 0, 'nothing drafted when every attempt is promotional');
  assert.strictEqual(result2.skipped, 5, 'all 5 groups skipped rather than posting blocked content');
  assert.strictEqual(promoGenCalls, 15, 'exactly TWO retries per group (3 attempts x 5 groups, bumped from 2 on 2026-09-11 for the extra dedup layers), never an unbounded retry loop');
  assert.strictEqual(db.group_posts.length, 0, 'zero rows inserted — a blocked draft is never written to the DB at all');

  // ── A generator that keeps returning the same duplicate body also gets
  //    skipped after the retry (dedup enforcement, integration-level) ────────
  db.group_posts.length = 0;
  db.group_posts.push({
    id: 'seed-1', group_key: 'kw_re_group', pipeline: 'daily5',
    post_body: 'Repeat body for the integration-level dedupe check across two runs today.',
    hook_type: 'ask_advice', created_at: new Date().toISOString(),
  });
  let dupGenCalls = 0;
  const dupGenerate = async () => { dupGenCalls++; return { post_body: 'Repeat body for the integration-level dedupe check across two runs today.' }; };
  const result3 = await gen.runDailyGroup5PostGeneration({
    sbFetch: mockSbFetch, generate: dupGenerate, send: okSend,
    loadPainLines: async () => [], log: () => {},
    groups: groups.filter((g) => g.key === 'kw_re_group'),
  });
  assert.strictEqual(result3.drafted, 0, 'duplicate body for kw_re_group never gets drafted');
  assert.strictEqual(result3.skipped, 1, 'kw_re_group skipped for today rather than repeating a body');

  // ── CROSS-GROUP DEDUPE (2026-09-11 bug): a near-verbatim body posted to
  //    one group yesterday must block a different group TODAY, not just the
  //    same group. Real-world case: the exact same "contrarian" scaffold got
  //    posted to tc_vas on 9/10 and kw_re_group on 9/11, one word-swap apart,
  //    because dedupe only ever compared within a single group. ────────────
  db.group_posts.length = 0;
  db.group_posts.push({
    id: 'seed-crossgroup-1', group_key: 'tc_vas', pipeline: 'daily5',
    post_body: 'Waiving the option period gets talked about like a character flag, either you are bold or you are an idiot.',
    hook_type: 'contrarian:option_period_waiver',
    created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), // "yesterday"
  });
  let crossGenCalls = 0;
  const crossGroupNearDupThenClean = async () => {
    crossGenCalls++;
    if (crossGenCalls === 1) {
      // Near-verbatim (word-overlap-catchable) repeat of yesterday's OTHER
      // group's post -- layer 2 (cross-group string dedupe) must block this
      // without needing the semantic check at all.
      return { post_body: 'Waiving the option period gets talked about like a character flag, either you are bold or you are reckless.' };
    }
    // Genuinely different topic -- must succeed.
    return { post_body: 'Had a closing slide at the very end over a documentation gap, a septic record nobody chased down early, curious what paperwork gap has bitten other people lately.' };
  };
  const result3b = await gen.runDailyGroup5PostGeneration({
    sbFetch: mockSbFetch, generate: crossGroupNearDupThenClean, send: okSend,
    loadPainLines: async () => [], log: () => {},
    groups: groups.filter((g) => g.key === 'kw_re_group'),
    checkSemanticDup: null, // isolate layer 2 (string dedupe) from layer 3 (semantic)
  });
  assert.strictEqual(result3b.drafted, 1, 'kw_re_group still gets a post once it lands on genuinely different content');
  assert.strictEqual(crossGenCalls, 2, 'attempt 1 (cross-group near-dup) blocked, attempt 2 (distinct topic) succeeded');
  const crossRow = db.group_posts.find((r) => r.group_key === 'kw_re_group');
  assert.ok(crossRow, 'kw_re_group row was inserted');
  assert.ok(!/character flag/.test(crossRow.post_body), 'the near-duplicate attempt never made it into the DB');

  // ── SEMANTIC near-duplicate (2026-09-11 bug, paraphrase case): word-overlap
  //    alone measurably misses this exact pair (Jaccard 0.53, below the 0.55
  //    threshold) -- confirmed against the real two posts Heath flagged. The
  //    semantic layer (LLM judgment, mocked here -- zero network access in
  //    regressions) is what has to catch it. ─────────────────────────────────
  db.group_posts.length = 0;
  db.group_posts.push({
    id: 'seed-semantic-1', group_key: 'tc_vas', pipeline: 'daily5',
    post_body: 'Waiving the option period gets talked about like it is a character flag, either you are bold or you are an idiot. It is neither by default.',
    hook_type: 'contrarian:option_period_waiver',
    created_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
  });
  let semGenCalls = 0;
  const semanticParaphraseThenClean = async () => {
    semGenCalls++;
    if (semGenCalls === 1) {
      // Same core claim, different enough wording that layer 2's
      // word-overlap check alone would NOT catch it (see contrarian ratio
      // 0.53 computed against the real Heath-flagged pair).
      return { post_body: 'People treat waiving the option period as a personality trait, either you are the bold buyer or the reckless one, when really it just depends on who is doing it.' };
    }
    return { post_body: 'Escalation clauses get pitched as a guaranteed win and they are not, they make sense with a real ceiling and real discipline, they backfire when someone avoids picking a number.' };
  };
  let semanticCheckCalls = 0;
  const mockSemanticDup = async (newBody, recentBodies) => {
    semanticCheckCalls++;
    // Simulate what the real Haiku judge call returns: flag the paraphrase,
    // clear the genuinely different topic.
    const isParaphrase = /personality trait/.test(newBody) && recentBodies.some((b) => /character flag/.test(b));
    return { duplicate: isParaphrase, reason: isParaphrase ? 'same core claim, reworded' : null };
  };
  const result3c = await gen.runDailyGroup5PostGeneration({
    sbFetch: mockSbFetch, generate: semanticParaphraseThenClean, send: okSend,
    loadPainLines: async () => [], log: () => {},
    groups: groups.filter((g) => g.key === 'kw_re_group'),
    checkSemanticDup: mockSemanticDup,
  });
  assert.ok(semanticCheckCalls >= 1, 'semantic dedup check actually ran');
  assert.strictEqual(result3c.drafted, 1, 'kw_re_group still lands a post once the paraphrase is rejected and a real new topic is drafted');
  assert.strictEqual(semGenCalls, 2, 'attempt 1 (semantic paraphrase) blocked, attempt 2 (distinct topic) succeeded');
  const semRow = db.group_posts.find((r) => r.group_key === 'kw_re_group');
  assert.ok(!/personality trait/.test(semRow.post_body), 'the semantic-duplicate paraphrase never made it into the DB');

  // ── 8. SUPPRESSION LIES: a suppressed send must not stamp telegram_sent_at ─
  db.group_posts.length = 0;
  const SUPPRESSED_PAYLOAD = { ok: true, delivered: false, suppressed: true, suppressed_by: 'telegram-gate', result: { message_id: 0, date: 0 } };
  const suppressedSend = async () => ({ ok: true, status: 200, data: SUPPRESSED_PAYLOAD });
  const result4 = await gen.runDailyGroup5PostGeneration({
    sbFetch: mockSbFetch, generate: cleanGenerate, send: suppressedSend,
    loadPainLines: async () => [], log: () => {},
    groups: groups.filter((g) => g.key === 'tc_admins'),
  });
  assert.strictEqual(result4.drafted, 1, 'row is drafted even though the send is suppressed');
  assert.strictEqual(result4.notified, 0, 'suppressed send counts 0 notified');
  const suppressedRow = db.group_posts.find((r) => r.group_key === 'tc_admins');
  assert.strictEqual(suppressedRow.status, 'draft', 'row stays draft on a suppressed send');
  assert.strictEqual(suppressedRow.telegram_sent_at, undefined, 'telegram_sent_at NOT stamped on suppressed send');

  // Retry pass picks it up and delivers.
  const retryResult = await gen.retryPendingNotifications({
    sbFetch: mockSbFetch, send: okSend, telegramToken: 't', telegramChatId: '1', log: () => {},
  });
  assert.strictEqual(retryResult.notified, 1, 'retry pass delivers the previously-suppressed draft');
  assert.ok(suppressedRow.telegram_sent_at, 'telegram_sent_at stamped after successful retry');

  // ── Callback: gp5_approve / gp5_edit / gp5_skip ────────────────────────────
  db.group_posts.length = 0;
  const draftRow = { id: 'cb-row-1', pipeline: 'daily5', group_key: 'kw_re_group', group_name: 'KW RE Group', post_body: 'Draft body for callback test.', status: 'draft', created_at: new Date().toISOString() };
  db.group_posts.push(draftRow);

  const calls = { answer: [], edit: [], send: [] };
  const cbDeps = (over = {}) => ({
    answerCallback: async (id, text) => calls.answer.push({ id, text }),
    editMessage: async (chatId, messageId, text) => calls.edit.push({ chatId, messageId, text }),
    sendMessage: async (chatId, text) => calls.send.push({ chatId, text }),
    editPromptText: '✏️ Editing group post cb-row-1. Reply with revised text.',
    callbackId: 'cbid1', chatId: '1', messageId: '2', originalMessageText: 'orig',
    ...over,
  });

  // Approve: guard on status=draft, real fetch used via mockSbFetch (monkeypatch)
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url).replace(process.env.SUPABASE_URL, '');
    return { ok: true, status: 200, text: async () => JSON.stringify((await mockSbFetch(u, init)).data) };
  };
  try {
    const approveRes = await cb.handleGroup5PostCallback('gp5_approve', 'cb-row-1', cbDeps());
    assert.strictEqual(approveRes.ok, true, 'approve succeeds on a draft row');
    assert.strictEqual(draftRow.status, 'approved', 'row flips to approved');
    assert.ok(draftRow.approved_at, 'approved_at stamped');

    // Double-tap: already approved, guarded.
    const doubleApprove = await cb.handleGroup5PostCallback('gp5_approve', 'cb-row-1', cbDeps());
    assert.strictEqual(doubleApprove.ok, false, 'double-approve is rejected');
    assert.strictEqual(doubleApprove.reason, 'already_handled', 'double-approve reason is already_handled');

    // Skip on a non-draft row also rejected.
    const skipOnApproved = await cb.handleGroup5PostCallback('gp5_skip', 'cb-row-1', cbDeps());
    assert.strictEqual(skipOnApproved.ok, false, 'skip on an already-approved row is rejected');

    // Fresh draft row: skip works.
    const draftRow2 = { id: 'cb-row-2', pipeline: 'daily5', group_key: 'tc_admins', group_name: 'TC Admins', post_body: 'Second draft.', status: 'draft', created_at: new Date().toISOString() };
    db.group_posts.push(draftRow2);
    const skipRes = await cb.handleGroup5PostCallback('gp5_skip', 'cb-row-2', cbDeps());
    assert.strictEqual(skipRes.ok, true, 'skip succeeds on a draft row');
    assert.strictEqual(draftRow2.status, 'skipped', 'row flips to skipped');

    // Edit prompts a force-reply, does not change status.
    const draftRow3 = { id: 'cb-row-3', pipeline: 'daily5', group_key: 'tx_re_agents', group_name: 'TX RE Agents', post_body: 'Third draft.', status: 'draft', created_at: new Date().toISOString() };
    db.group_posts.push(draftRow3);
    const editRes = await cb.handleGroup5PostCallback('gp5_edit', 'cb-row-3', cbDeps());
    assert.strictEqual(editRes.ok, true, 'edit prompt succeeds');
    assert.strictEqual(draftRow3.status, 'draft', 'edit does NOT change status by itself — only a reply-with-text approves');
    assert.strictEqual(calls.send.length, 1, 'edit sends exactly one force-reply prompt');
  } finally {
    global.fetch = originalFetch;
  }

  // ── 1/2/3/6. QUEUE: approval gate, cap, spacing, one-per-run, shared halt ──
  // Each phase resets the DB to exactly the rows it needs — no shared state
  // carried between phases (that ambiguity caused a real failure while
  // authoring this suite: two 'approved' rows tie-broken by approved_at
  // ordering in a way the test itself hadn't tracked).
  let haltState = makeHaltState();

  // 1. Approval gate: draft/skipped rows are never eligible.
  db.group_posts.length = 0;
  db.comment_caps_state.length = 0;
  let spawnCalls = 0;
  const neverSpawn = async () => { spawnCalls++; return { exitCode: 0 }; };
  db.group_posts.push({ id: 'q-1', pipeline: 'daily5', status: 'draft', group_name: 'A', post_body: 'x' });
  db.group_posts.push({ id: 'q-2', pipeline: 'daily5', status: 'skipped', group_name: 'B', post_body: 'x' });
  const q1 = await queue.runGroup5PostQueue({ sbFetch: mockSbFetch, caps, spawnPoster: neverSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes: 18 });
  assert.strictEqual(spawnCalls, 0, 'poster NEVER called for draft/skipped rows — approval gate holds');
  assert.strictEqual(q1.posted, 0, 'nothing posted without approval');

  // 2. Cap enforcement: facebook_group_post daily cap blocks, row stays queued.
  db.group_posts.length = 0;
  db.comment_caps_state.length = 0;
  const todayKey = new Date().toISOString().slice(0, 10);
  db.comment_caps_state.push({ id: 'cap-1', platform: 'facebook_group_post', day: todayKey, count: caps.PLATFORM_DAILY_CAPS.facebook_group_post });
  const approvedRow = { id: 'q-3', pipeline: 'daily5', status: 'approved', group_name: 'DFW', post_body: 'x', approved_at: new Date().toISOString() };
  db.group_posts.push(approvedRow);
  spawnCalls = 0;
  const q2 = await queue.runGroup5PostQueue({ sbFetch: mockSbFetch, caps, spawnPoster: neverSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes: 18 });
  assert.strictEqual(spawnCalls, 0, 'cap hit: poster never called');
  assert.strictEqual(q2.queuedForCap, 1, 'the approved row stays queued at the cap');
  assert.strictEqual(approvedRow.status, 'approved', 'over-cap row remains approved, not dropped or failed');

  // 3. Spacing: inside the 18-24 min gap -> silent queue.
  db.group_posts.length = 0;
  db.comment_caps_state.length = 0;
  db.group_posts.push({ id: 'q-4', pipeline: 'daily5', status: 'posted', posted_at: new Date(Date.now() - 5 * 60000).toISOString(), group_name: 'Prior' });
  db.group_posts.push({ id: 'q-5', pipeline: 'daily5', status: 'approved', group_name: 'Second', post_body: 'y', approved_at: new Date(Date.now() - 1000).toISOString() });
  spawnCalls = 0;
  const q3 = await queue.runGroup5PostQueue({ sbFetch: mockSbFetch, caps, spawnPoster: neverSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes: 18 });
  assert.strictEqual(spawnCalls, 0, '5 min since last post < 18-min floor: nothing posts');
  assert.strictEqual(q3.queuedForCap, 1, 'approved row silently queued behind the spacing gap');

  // Gap elapsed: exactly ONE posts, watchlist handoff fires on success.
  db.group_posts.find((r) => r.id === 'q-4').posted_at = new Date(Date.now() - 25 * 60000).toISOString();
  let successSpawnCalls = 0;
  const successSpawn = async (postId) => {
    successSpawnCalls++;
    // Simulate fb-group-poster.js's real effect: markPosted + watchlist handoff.
    const row = db.group_posts.find((r) => r.id === postId);
    row.status = 'posted';
    row.posted_at = new Date().toISOString();
    row.post_url = `https://www.facebook.com/groups/x/posts/${postId}/`;
    await watchlistLib.registerGroupPostWatch(mockSbFetch, row, postId, row.post_url);
    return { exitCode: 0 };
  };
  const watchBefore = db.comment_watchlist.length;
  const q4 = await queue.runGroup5PostQueue({ sbFetch: mockSbFetch, caps, spawnPoster: successSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes: 18 });
  assert.strictEqual(successSpawnCalls, 1, 'exactly ONE group post per run');
  assert.strictEqual(q4.posted, 1, 'one posted');
  assert.strictEqual(db.group_posts.find((r) => r.id === 'q-5').status, 'posted', 'the approved row is the one that posted');
  assert.strictEqual(db.comment_caps_state.length, 1, 'cap counter row created');
  assert.strictEqual(db.comment_caps_state[0].count, 1, 'cap incremented exactly once');
  assert.strictEqual(db.comment_watchlist.length, watchBefore + 1, 'the successful post registered in comment_watchlist via the shared handoff');

  // 6. Failure -> HALT, never silently retried by the queue itself. Fresh
  //    DB state with the last real post far enough in the past that only
  //    the failure path (not the spacing gap) is under test here.
  db.group_posts.length = 0;
  db.comment_caps_state.length = 0;
  db.group_posts.push({ id: 'q-6', pipeline: 'daily5', status: 'posted', posted_at: new Date(Date.now() - 60 * 60000).toISOString(), group_name: 'Old' });
  db.group_posts.push({ id: 'q-7', pipeline: 'daily5', status: 'approved', group_name: 'Third', post_body: 'z', approved_at: new Date(Date.now() - 500).toISOString() });
  const failingSpawn = async (postId) => {
    const row = db.group_posts.find((r) => r.id === postId);
    row.status = 'approved'; // fb-group-poster.js's markFailed reset behavior
    return { exitCode: 1, error: 'could not find the post input box' };
  };
  const notifications = [];
  const q5 = await queue.runGroup5PostQueue({
    sbFetch: mockSbFetch, caps, spawnPoster: failingSpawn,
    notify: async (t) => notifications.push(t), log: quietLog, haltState, gapMinutes: 18,
  });
  assert.strictEqual(q5.failed, 1, 'failed run counted');
  assert.strictEqual(q5.halted, true, 'a posting failure HALTS the pipeline — never silently retried');
  assert.ok(haltState.isHalted(), 'halt state is set');
  assert.ok(notifications.some((t) => /HALTED/i.test(t)), 'Heath alerted about the halt');
  assert.strictEqual(db.group_posts.find((r) => r.id === 'q-7').status, 'approved', 'the failed row reverts to approved, not lost or terminal-failed');

  // ── 6. Halt is SHARED with the comment pipeline's file-based breaker ──────
  // Prove the queue module imports the SAME halt module path as
  // fb-comment-opp-poster.js (not a private copy).
  const queueSrc = fs.readFileSync(path.join(__dirname, 'fb-group5-post-queue.js'), 'utf8');
  assert.ok(queueSrc.includes("require('./_lib/comment-hunt-halt')"), 'queue-runner imports the SHARED halt module, not a private one');
  const posterSrc2 = fs.readFileSync(path.join(__dirname, 'fb-comment-opp-poster.js'), 'utf8');
  assert.ok(posterSrc2.includes("require('./_lib/comment-hunt-halt')"), 'comment poster uses the same halt module path — confirms sharing');

  // Halted pipeline posts NOTHING even with approved rows waiting.
  db.group_posts.push({ id: 'q-8', pipeline: 'daily5', status: 'approved', group_name: 'Fourth', post_body: 'w', approved_at: new Date().toISOString() });
  spawnCalls = 0;
  const q6 = await queue.runGroup5PostQueue({ sbFetch: mockSbFetch, caps, spawnPoster: neverSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes: 18 });
  assert.strictEqual(q6.halted, true, 'run reports halted');
  assert.strictEqual(spawnCalls, 0, 'halted pipeline never calls the poster');

  // ── Static guards ─────────────────────────────────────────────────────────
  const webhookSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'telegram-webhook.js'), 'utf8');
  assert.ok(webhookSrc.includes('gp5_approve|gp5_edit|gp5_skip'), 'webhook handles gp5_* callbacks');
  assert.ok(webhookSrc.includes('GP5_EDIT_PROMPT_PREFIX'), 'webhook has the group5 edit-reply flow');
  assert.ok(webhookSrc.includes("require('../scripts/_lib/group-post-content-gate')"), 'webhook re-checks the content gate on an edit reply, not just on generation');
  const capsSrc = fs.readFileSync(path.join(__dirname, '_lib', 'comment-caps.js'), 'utf8');
  assert.ok(/facebook_group_post:\s*5/.test(capsSrc), 'facebook_group_post ceiling is the single config value in comment-caps.js');
  const cmdSrc = fs.readFileSync(path.join(__dirname, 'run-tc-discovery-harvest.cmd'), 'utf8');
  assert.ok(cmdSrc.includes('fb-group5-post-queue.js'), 'the queue runner is wired into the existing Windows Task Scheduler tick');
  const migrationSrc = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'migrations', '20260909_group_post5_daily.sql'), 'utf8');
  assert.ok(migrationSrc.includes("pipeline"), 'migration adds the pipeline column');
  assert.ok(migrationSrc.includes('content_hash'), 'migration adds the content_hash dedupe column');
  const vercelJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.ok(vercelJson.crons.some((c) => c.path === '/api/cron-daily-group5-posts'), 'cron is registered in vercel.json');

  console.log('PASS: daily 5-group-post pipeline (approval gate, 5/day cap, 18-24 varied spacing, one-per-run, per-group 30-day dedupe x3 layers, DFW hard no-promo gate, shared circuit breaker, watchlist handoff, suppression-lies contract, gp5_ callbacks)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
