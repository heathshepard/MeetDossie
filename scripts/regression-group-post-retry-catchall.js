#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/group-post-retry-catchall.js
 * (retryPendingLegacyGroupPostNotifications).
 *
 * THE BUG (found via the first real silence-alarm firing, 2026-09-16)
 * ---------------------------------------------------------------------
 * api/cron-retry-unsent-approvals.js only ever retried group_posts drafts
 * whose `pipeline` column was exactly 'daily5' or 'listing-groups'. Any
 * draft with pipeline NULL (or any other value) fell outside both queries
 * and was retried by NOTHING, forever -- confirmed live: 10 drafts stuck
 * back to 2026-07-09 (Keller Williams REALTORs), all with telegram_sent_at
 * still null.
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. A stale draft with pipeline=NULL gets picked up and delivered by the
 *      catch-all, stamping telegram_sent_at.
 *   2. A stale draft with a KNOWN pipeline ('daily5'/'listing-groups') is
 *      explicitly excluded -- the catch-all must never double-send a row
 *      already owned by one of the two named retries.
 *   3. A draft younger than RETRY_AFTER_MINUTES is left alone (not retried
 *      yet).
 *   4. On the 3rd consecutive failed attempt, a final-failure alert fires
 *      (bounded retry, not "retry forever with no signal").
 *
 * Real in-memory PostgREST mock over HTTP — ZERO production access, no
 * Telegram, no real DB.
 *
 * Run manually:
 *   node scripts/regression-group-post-retry-catchall.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  return true;
}

function startMockSupabase(seedRows) {
  let group_posts = seedRows.map((r) => ({ ...r }));
  const telegram_send_log = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();

      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'limit'].includes(k));

      if (table === 'telegram_send_log') {
        if (req.method === 'POST') {
          let body = {};
          try { body = JSON.parse(raw); } catch { /* noop */ }
          telegram_send_log.push(body);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end('{}');
          return;
        }
      }

      if (table !== 'group_posts') { res.writeHead(404); res.end('{}'); return; }

      let matched = group_posts.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
      if (q.order) {
        const [col, dir] = q.order.split('.');
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
      }

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
        return;
      }

      if (req.method === 'PATCH') {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* noop */ }
        const idFilter = filters.find(([k]) => k === 'id');
        const id = idFilter ? decodeURIComponent(idFilter[1].slice(3)) : null;
        const row = group_posts.find((r) => r.id === id);
        if (row) Object.assign(row, body);
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(405);
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        rows: () => group_posts,
        sendLog: () => telegram_send_log,
      });
    });
  });
}

async function main() {
  const { retryPendingLegacyGroupPostNotifications } = require(path.join(REPO, 'api', '_lib', 'group-post-retry-catchall.js'));

  const OLD = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago -> past RETRY_AFTER_MINUTES=30
  const RECENT = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago -> too fresh

  // ── 1. pipeline=NULL stale draft gets picked up and delivered ──────────
  {
    const mock = await startMockSupabase([
      {
        id: 'row-null-pipeline', group_name: 'Keller Williams REALTORs', category: 'kw',
        post_body: 'Old draft, no pipeline column ever set.', pipeline: null,
        status: 'draft', telegram_sent_at: null, telegram_send_attempts: 0, created_at: OLD,
      },
    ]);
    const sbFetch = async (urlPath, init) => {
      const res = await fetch(`${mock.url}${urlPath}`, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
      return { ok: res.ok, status: res.status, data };
    };
    const sent = [];
    const okSend = async (text, kb) => {
      sent.push({ text, kb });
      return { ok: true, status: 200, data: { ok: true, result: { message_id: 4242 } } };
    };
    const result = await retryPendingLegacyGroupPostNotifications({
      sbFetch, send: okSend, telegramToken: 't', telegramChatId: '1', log: () => {},
    });
    assert.strictEqual(result.retried, 1, 'catch-all considered exactly the 1 pipeline=NULL row');
    assert.strictEqual(result.notified, 1, 'catch-all delivered the pipeline=NULL row');
    const row = mock.rows().find((r) => r.id === 'row-null-pipeline');
    assert.ok(row.telegram_sent_at, 'telegram_sent_at stamped after delivery');
    assert.strictEqual(sent.length, 1, 'exactly one Telegram send attempted');
    assert.ok(sent[0].kb.inline_keyboard[0][0].callback_data.startsWith('group_approve_'), 'keyboard uses the still-parsed group_approve_<id> shape');
    mock.close();
    console.log('  PASS: pipeline=NULL stale draft delivered by catch-all');
  }

  // ── 2. Known-pipeline rows are excluded — no double-send ───────────────
  {
    const mock = await startMockSupabase([
      {
        id: 'row-daily5', group_name: 'DFW Network', category: 'x',
        post_body: 'daily5 draft.', pipeline: 'daily5',
        status: 'draft', telegram_sent_at: null, telegram_send_attempts: 0, created_at: OLD,
      },
      {
        id: 'row-listing', group_name: 'Listing Group', category: 'x',
        post_body: 'listing-groups draft.', pipeline: 'listing-groups',
        status: 'draft', telegram_sent_at: null, telegram_send_attempts: 0, created_at: OLD,
      },
    ]);
    const sbFetch = async (urlPath, init) => {
      const res = await fetch(`${mock.url}${urlPath}`, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
      return { ok: res.ok, status: res.status, data };
    };
    const okSend = async () => ({ ok: true, status: 200, data: { ok: true, result: { message_id: 1 } } });
    const result = await retryPendingLegacyGroupPostNotifications({
      sbFetch, send: okSend, telegramToken: 't', telegramChatId: '1', log: () => {},
    });
    assert.strictEqual(result.retried, 0, 'catch-all must not touch rows already owned by a named-pipeline retry');
    assert.strictEqual(result.notified, 0, 'nothing sent for known-pipeline rows');
    mock.close();
    console.log('  PASS: known-pipeline rows excluded from the catch-all (no double-send)');
  }

  // ── 3. Too-fresh draft is left alone ────────────────────────────────────
  {
    const mock = await startMockSupabase([
      {
        id: 'row-fresh', group_name: 'Fresh Group', category: 'x',
        post_body: 'Just created.', pipeline: null,
        status: 'draft', telegram_sent_at: null, telegram_send_attempts: 0, created_at: RECENT,
      },
    ]);
    const sbFetch = async (urlPath, init) => {
      const res = await fetch(`${mock.url}${urlPath}`, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
      return { ok: res.ok, status: res.status, data };
    };
    const okSend = async () => ({ ok: true, status: 200, data: { ok: true, result: { message_id: 1 } } });
    const result = await retryPendingLegacyGroupPostNotifications({
      sbFetch, send: okSend, telegramToken: 't', telegramChatId: '1', log: () => {},
    });
    assert.strictEqual(result.retried, 0, 'a draft younger than RETRY_AFTER_MINUTES is not yet eligible');
    mock.close();
    console.log('  PASS: fresh draft (< 30 min) not retried yet');
  }

  // ── 4. Bounded retry: 3rd failure fires a final alert ───────────────────
  {
    const mock = await startMockSupabase([
      {
        id: 'row-always-fails', group_name: 'Broken Group', category: 'x',
        post_body: 'Will never deliver.', pipeline: null,
        status: 'draft', telegram_sent_at: null, telegram_send_attempts: 2, created_at: OLD,
      },
    ]);
    const sbFetch = async (urlPath, init) => {
      const res = await fetch(`${mock.url}${urlPath}`, init);
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* noop */ }
      return { ok: res.ok, status: res.status, data };
    };
    const failSend = async () => ({ ok: false, status: 500, data: { description: 'mock outage' } });

    const originalFetch = global.fetch;
    let finalAlertSent = false;
    global.fetch = async (url, init) => {
      const u = String(url);
      if (u.startsWith('https://api.telegram.org/')) {
        finalAlertSent = true;
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }) };
      }
      return originalFetch(url, init);
    };
    try {
      const result = await retryPendingLegacyGroupPostNotifications({
        sbFetch, send: failSend, telegramToken: 't', telegramChatId: '1', log: () => {},
      });
      assert.strictEqual(result.retried, 1, 'the 3rd-attempt row was considered');
      assert.strictEqual(result.notified, 0, 'still not delivered (send keeps failing)');
      assert.ok(finalAlertSent, 'a final-failure alert fired on the 3rd failed attempt');
      const row = mock.rows().find((r) => r.id === 'row-always-fails');
      assert.strictEqual(row.telegram_send_attempts, 3, 'attempt counter reached MAX_ATTEMPTS');
    } finally {
      global.fetch = originalFetch;
      mock.close();
    }
    console.log('  PASS: bounded retry fires a final alert at MAX_ATTEMPTS, does not retry forever');
  }

  console.log('\nALL PASS — scripts/regression-group-post-retry-catchall.js');
}

main().catch((err) => {
  console.error('\nFAIL:', err && err.message);
  console.error(err && err.stack);
  process.exit(1);
});
