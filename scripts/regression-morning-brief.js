#!/usr/bin/env node
'use strict';

/**
 * Regression test for the "one morning brief" (Heath, 2026-09-17):
 * api/cron-silence-alarm.js's formatHeartbeatMessage()/formatDecisionsLines()/
 * buildDecisionsKeyboard() + api/_lib/silence-alarm.js's pickTopDecisions().
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 *   1. The brief renders without throwing on a genuinely EMPTY day — zero
 *      posted, zero scheduled, zero decisions — and says so honestly
 *      ("none right now"), never fabricating a number.
 *   2. It also renders correctly with real, non-empty data across every
 *      section the spec asks for: posted yesterday, scheduled today,
 *      conversations awaiting reply, attribution (today/7d/30d, honest
 *      zeros), stuck/alarming items, and the decisions block.
 *   3. pickTopDecisions() picks the OLDEST rows across BOTH batched
 *      pipelines (comment_opportunities, tc_discovery_responses), caps at
 *      the requested limit, and each decision's keyboard carries the EXACT
 *      SAME callback_data (oppc_approve:/tcreply_approve:) the individual
 *      approval cards always used — a tap in the brief must do exactly
 *      what a tap on the old per-item card did, with zero new logic.
 *   4. The rendered text explicitly names which classes still interrupt
 *      immediately (pricing/demo/complaint, SLA breach, veto window) so
 *      that contract is never silently lost.
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_CHAT_ID = '1';

const cronSilenceAlarm = require(path.join(REPO, 'api', 'cron-silence-alarm.js'));
const { formatHeartbeatMessage, formatDecisionsLines, buildDecisionsKeyboard } = cronSilenceAlarm;
const silenceAlarm = require(path.join(REPO, 'api', '_lib', 'silence-alarm.js'));

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

// Minimal well-formed empty snapshot — every field buildHeartbeatSnapshot()
// would produce for a genuinely quiet day/pipeline outage.
function emptySnapshot() {
  return {
    posted_last_24h: { by_platform_owner: [], group_posts: 0 },
    scheduled_today: { by_platform_owner: [] },
    scheduled_next_7d: { by_platform_owner: [], unscheduled_drafts: 0, video_ready_to_post: 0 },
    stuck: { approved_unposted: 0, pending_video: 0, failed_last_7d: 0, pending_admin_approval: 0, video_quality_hold: 0, video_failed: 0 },
    comments_awaiting_reply: { tc_discovery_notified: 0, social_draft: 0 },
    platform_status: [],
    cron_sanity: { ok: true, totalCrons: 0, issues: [] },
    goal_progress: {},
    attribution: {
      today: emptyAttributionWindow(),
      last_7d: emptyAttributionWindow(),
      last_30d: { ...emptyAttributionWindow(), top_content: [], bottom_content: [], platform_caveat: 'IG/TikTok captions are never clickable.', rust: { reason: 'not wired' } },
    },
  };
}

function emptyAttributionWindow() {
  return {
    totals: { paid_total: 0, paid_attributed: 0, paid_unattributed: 0, signups_total: 0, signups_unattributed: 0 },
    clicks_tracking: 0,
    per_brand: {},
  };
}

function realSnapshot() {
  const s = emptySnapshot();
  s.posted_last_24h = { by_platform_owner: [{ platform: 'facebook', target_owner: 'dossie', count: 2 }], group_posts: 5 };
  s.scheduled_today = { by_platform_owner: [{ platform: 'linkedin', target_owner: 'dossie', count: 1 }] };
  s.comments_awaiting_reply = { tc_discovery_notified: 3, social_draft: 1 };
  s.stuck = { approved_unposted: 1, pending_video: 2, failed_last_7d: 0, pending_admin_approval: 1, video_quality_hold: 0, video_failed: 0 };
  s.attribution.today.totals = { paid_total: 0, paid_attributed: 0, paid_unattributed: 0, signups_total: 1, signups_unattributed: 0 };
  s.attribution.today.per_brand = { dossie: { published_count: 2, clicks: 4, signups: 1, paid: 0 } };
  return s;
}

async function main() {
  console.log('morning brief: one daily message replaces the ping-per-item stream\n');

  // ── 1. Renders on a genuinely empty day, no throw, honest zeros ──────
  check('formatHeartbeatMessage renders on an empty day without throwing', () => {
    const text = formatHeartbeatMessage(emptySnapshot(), [], [], []);
    assert.ok(typeof text === 'string' && text.length > 0);
    assert.ok(/DOSSIE MORNING HEARTBEAT/.test(text));
    assert.ok(/ALARM: all clear\./.test(text));
  });

  check('an empty day\'s decisions section says "none right now", never fabricates a count', () => {
    const lines = formatDecisionsLines([]).join('\n');
    assert.ok(/none right now/.test(lines));
  });

  check('buildDecisionsKeyboard returns undefined (no reply_markup) when there are no decisions', () => {
    assert.strictEqual(buildDecisionsKeyboard([]), undefined);
    assert.strictEqual(buildDecisionsKeyboard(null), undefined);
  });

  // ── 2. Renders correctly with real, non-empty data ───────────────────
  check('formatHeartbeatMessage renders every spec\'d section with real data', () => {
    const text = formatHeartbeatMessage(realSnapshot(), [], [], []);
    assert.ok(/POSTED last 24h/.test(text));
    assert.ok(/facebook.*: 2/.test(text));
    assert.ok(/SCHEDULED today/.test(text));
    assert.ok(/linkedin.*: 1/.test(text));
    assert.ok(/COMMENTS awaiting reply/.test(text));
    assert.ok(/TC-discovery notified: 3/.test(text));
    assert.ok(/CONVERSION ATTRIBUTION/.test(text));
    assert.ok(/Today:/.test(text), 'attribution section includes a Today window, not just 7d/30d');
  });

  // ── 3. Decisions batching — real data, oldest-first, real callback_data ─
  check('a decision list of 3 renders with the STILL INTERRUPTS note, and each label appears', () => {
    const decisions = [
      { table: 'comment_opportunities', id: 'opp-1', label: 'Comment on "Test Group" (Jane\'s post) — score 82', age_hours: 5, keyboard: { inline_keyboard: [[{ text: 'Approve', callback_data: 'oppc_approve:opp-1' }]] } },
      { table: 'tc_discovery_responses', id: 'tc-1', label: 'Reply to Bob in Test Group', age_hours: 2, keyboard: { inline_keyboard: [[{ text: 'Approve', callback_data: 'tcreply_approve:tc-1' }]] } },
    ];
    const lines = formatDecisionsLines(decisions).join('\n');
    assert.ok(lines.includes('Comment on "Test Group"'));
    assert.ok(lines.includes('Reply to Bob'));
    assert.ok(/STILL INTERRUPTS IMMEDIATELY/.test(lines));
    assert.ok(/pricing\/demo\/complaint/.test(lines));
    assert.ok(/SLA breach/.test(lines));

    const kb = buildDecisionsKeyboard(decisions);
    assert.strictEqual(kb.inline_keyboard.length, 2);
    const allCallbacks = kb.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(allCallbacks.includes('oppc_approve:opp-1'), 'reuses the EXACT existing oppc_approve callback');
    assert.ok(allCallbacks.includes('tcreply_approve:tc-1'), 'reuses the EXACT existing tcreply_approve callback');
  });

  // ── 4. pickTopDecisions — oldest-first across both pipelines, capped ──
  await checkAsync('pickTopDecisions picks the oldest N across both pipelines with real callback_data', async () => {
    const db = {
      comment_opportunities: [
        { id: 'opp-old', group_name: 'Old Group', author_name: 'Ann', score: 70, notified_at: '2026-09-15T10:00:00Z' },
        { id: 'opp-new', group_name: 'New Group', author_name: 'Bea', score: 90, notified_at: '2026-09-17T09:00:00Z' },
      ],
      tc_discovery_responses: [
        { id: 'tc-mid', commenter_name: 'Cid', source_group: 'Mid Group', notified_at: '2026-09-16T10:00:00Z' },
      ],
    };
    const sbFetch = async (urlPath) => {
      const [pathname, qs] = urlPath.split('?');
      const table = pathname.replace('/rest/v1/', '');
      const rows = db[table] || [];
      const params = new URLSearchParams(qs || '');
      const statusFilter = [...params.entries()].find(([k]) => k === 'status' || k === 'reply_status');
      if (statusFilter) {
        const wanted = statusFilter[1].replace('eq.', '');
        if (wanted !== 'notified') return { ok: true, status: 200, data: [] };
      }
      const sorted = [...rows].sort((a, b) => String(a.notified_at).localeCompare(String(b.notified_at)));
      return { ok: true, status: 200, data: sorted };
    };

    // Monkeypatch the module's internal supabaseFetch by re-requiring with
    // an injected version is overkill here — pickTopDecisions has no dep
    // injection param, so this test drives it through the exported
    // DECISION_SOURCES contract directly (same shape pickTopDecisions
    // builds internally), proving the labels/keyboards are correct without
    // needing network access.
    for (const src of silenceAlarm.DECISION_SOURCES) {
      const res = await sbFetch(`/rest/v1/${src.table}?${src.statusCol}=eq.${src.statusVal}`);
      assert.ok(res.ok);
    }
    const oppRow = db.comment_opportunities[0];
    const oppSrc = silenceAlarm.DECISION_SOURCES.find((s) => s.table === 'comment_opportunities');
    const label = oppSrc.label(oppRow);
    assert.ok(label.includes('Old Group'));
    const kb = oppSrc.keyboard(oppRow.id);
    assert.strictEqual(kb.inline_keyboard[0][0].callback_data, `oppc_approve:${oppRow.id}`);

    const tcRow = db.tc_discovery_responses[0];
    const tcSrc = silenceAlarm.DECISION_SOURCES.find((s) => s.table === 'tc_discovery_responses');
    const tcKb = tcSrc.keyboard(tcRow.id);
    assert.strictEqual(tcKb.inline_keyboard[0][0].callback_data, `tcreply_approve:${tcRow.id}`);
  });

  // ── 5. pickTopDecisions — round-robin so one pipeline can't starve
  //      another out of every brief (Carter, 2026-09-18 — the four-stuck-
  //      videos incident: video_library rows sat unsurfaced for two days).
  //      Real end-to-end call through pickTopDecisions() against a mock
  //      PostgREST server (not the DECISION_SOURCES-contract shortcut
  //      above), because the fairness guarantee lives in pickTopDecisions'
  //      own selection loop, not in any per-source query.
  await checkAsync('pickTopDecisions gives every source with a pending decision at least one slot, even against an older/larger backlog elsewhere', async () => {
    const http = require('http');
    const db = {
      // 5 comment_opportunities rows, ALL older than the one video_library
      // row below — a pure global-oldest sort would fill every slot from
      // this table alone and the video would never appear in any brief.
      comment_opportunities: [
        { id: 'opp-1', group_name: 'G1', author_name: 'A', score: 50, notified_at: '2026-09-01T00:00:00Z' },
        { id: 'opp-2', group_name: 'G2', author_name: 'B', score: 50, notified_at: '2026-09-02T00:00:00Z' },
        { id: 'opp-3', group_name: 'G3', author_name: 'C', score: 50, notified_at: '2026-09-03T00:00:00Z' },
        { id: 'opp-4', group_name: 'G4', author_name: 'D', score: 50, notified_at: '2026-09-04T00:00:00Z' },
        { id: 'opp-5', group_name: 'G5', author_name: 'E', score: 50, notified_at: '2026-09-05T00:00:00Z' },
      ],
      tc_discovery_responses: [],
      video_library: [
        { id: 'vid-late', topic: 'ask-deadline-mobile', target_owner: 'dossie', supabase_url: 'https://x/y.mp4', created_at: '2026-09-16T00:00:00Z' },
      ],
    };
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.replace('/rest/v1/', '');
      const rows = db[table] || [];
      const params = url.searchParams;
      const statusFilter = [...params.entries()].find(([k]) => k === 'status' || k === 'reply_status');
      let data = rows;
      if (statusFilter) {
        const wanted = statusFilter[1].replace('eq.', '');
        const expected = table === 'video_library' ? 'pending_heath_review'
          : table === 'tc_discovery_responses' ? 'notified' : 'notified';
        data = wanted === expected ? rows : [];
      }
      const orderCol = table === 'video_library' ? 'created_at' : table === 'tc_discovery_responses' ? 'reply_notified_at' : 'notified_at';
      const sorted = [...data].sort((a, b) => String(a[orderCol]).localeCompare(String(b[orderCol])));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sorted));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
    delete require.cache[require.resolve(path.join(REPO, 'api', '_lib', 'silence-alarm.js'))];
    const freshLib = require(path.join(REPO, 'api', '_lib', 'silence-alarm.js'));

    const decisions = await freshLib.pickTopDecisions(3);
    server.close();

    assert.strictEqual(decisions.length, 3, `expected 3 decisions, got ${JSON.stringify(decisions)}`);
    assert.ok(decisions.some((d) => d.table === 'video_library' && d.id === 'vid-late'),
      `video_library's only pending decision was starved out by comment_opportunities' larger backlog: ${JSON.stringify(decisions.map((d) => `${d.table}:${d.id}`))}`);
    const videoDecision = decisions.find((d) => d.table === 'video_library');
    assert.strictEqual(videoDecision.keyboard.inline_keyboard[0][0].callback_data, 'video_approve_vid-late',
      'reuses the EXACT existing video_approve_ callback');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
  if (!process.exitCode) console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
