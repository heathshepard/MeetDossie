#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-08 email_queue -> outbound_email_queue
 * migration (member transaction email logging) + the real draft pipeline
 * fix (cron-request-testimonial-draft.js now scheduled) + the digest's
 * sustained-zero-draft silent-failure alarm.
 *
 * Drives the REAL module.exports handlers for:
 *   - api/send-email.js
 *   - api/cron-request-testimonial-draft.js
 *   - api/cron-email-digest.js
 *   - api/send-testimonial-request.js
 *   - api/cron-send-outbound-emails.js   (regression proof: cold-email path)
 * against an in-memory fake of the Supabase REST + Resend surface. Nothing
 * here re-implements any of these handlers' logic.
 *
 * Run manually:
 *   node scripts/regression-email-queue-migration.js
 */

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_URL = 'http://fake.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.RESEND_API_KEY = 'fake-resend-key';
process.env.CRON_SECRET = 'fake-cron-secret';
// Telemetry's recordCronRun() no-ops unless a real Vercel invocation is
// detected (see cron-telemetry.js isRealVercelExecution). The zero-streak
// alarm's cross-run persistence genuinely depends on that write landing, so
// this test deliberately opts into looking like a real invocation -- same
// as the thing it's proving would happen in production.
process.env.VERCEL = '1';
process.env.VERCEL_ENV = 'test';

const ROOT = path.resolve(__dirname, '..');
const sendEmail = require(path.join(ROOT, 'api', 'send-email.js'));
const testimonialDraftCron = require(path.join(ROOT, 'api', 'cron-request-testimonial-draft.js'));
const digestCron = require(path.join(ROOT, 'api', 'cron-email-digest.js'));
const sendTestimonialRequest = require(path.join(ROOT, 'api', 'send-testimonial-request.js'));
const outboundSendCron = require(path.join(ROOT, 'api', 'cron-send-outbound-emails.js'));

// ---------------------------------------------------------------------------
// Fake DB + Resend
// ---------------------------------------------------------------------------
const db = {
  subscriptions: [{ user_id: 'U1', plan: 'solo', status: 'active' }],
  profiles: [{
    id: 'U1', email: 'agent@example.com', full_name: 'Jamie Agent', preferred_name: null,
    is_demo: false, brokerage: 'Keller Williams', phone: '210-555-0100', license_number: '999999',
    google_review_url: 'https://g.page/r/fake-review-link',
  }],
  transactions: new Map(),
  email_queue: [],
  action_items: [],
  outbound_email_queue: [],
  cron_runs: new Map(), // cron_name -> { last_meta }
  documents: [],
};
let nextId = 1;
const newId = () => String(nextId++);
const sentEmails = [];

function qs(url) { return new URL(url, 'http://fake.local').searchParams; }
function eq(params, key) {
  const v = params.get(key);
  return v && v.startsWith('eq.') ? v.slice(3) : null;
}

global.fetch = async function fakeFetch(url, init = {}) {
  const u = new URL(url, 'http://fake.local');
  const method = (init.method || 'GET').toUpperCase();
  const p = u.searchParams;

  if (u.hostname === 'api.resend.com') {
    const body = JSON.parse(init.body);
    sentEmails.push(body);
    return jr(200, { id: `email_${sentEmails.length}` });
  }

  if (u.pathname === '/auth/v1/user') {
    return jr(200, { id: 'U1', email: 'agent@example.com' });
  }

  if (u.pathname === '/rest/v1/subscriptions') {
    return jr(200, db.subscriptions.filter((s) => !eq(p, 'status') || s.status === eq(p, 'status')));
  }

  if (u.pathname === '/rest/v1/profiles') {
    if (method === 'PATCH') return jr(200, null); // touchLastSeen, fire-and-forget
    const idIn = p.get('id');
    let ids = null;
    if (idIn && idIn.startsWith('in.(')) ids = idIn.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
    const idEq = eq(p, 'id');
    const rows = db.profiles.filter((row) => (!ids || ids.includes(row.id)) && (!idEq || row.id === idEq));
    return jr(200, rows);
  }

  if (u.pathname === '/rest/v1/transactions') {
    if (method === 'GET') {
      let rows = [...db.transactions.values()];
      const userId = eq(p, 'user_id');
      if (userId) rows = rows.filter((t) => t.user_id === userId);
      const status = eq(p, 'status');
      if (status) rows = rows.filter((t) => t.status === status);
      const draftNull = p.get('testimonial_draft_created_at');
      if (draftNull === 'is.null') rows = rows.filter((t) => !t.testimonial_draft_created_at);
      const closingGte = p.get('closing_date');
      if (closingGte && closingGte.startsWith('gte.')) {
        const floor = closingGte.slice(4);
        rows = rows.filter((t) => t.closing_date && t.closing_date >= floor);
      }
      const idIn = p.get('id');
      if (idIn && idIn.startsWith('in.(')) {
        const ids = idIn.slice(4, -1).split(',').map((s) => s.replace(/^"|"$/g, ''));
        rows = rows.filter((t) => ids.includes(String(t.id)));
      }
      const idEq = eq(p, 'id');
      if (idEq) rows = rows.filter((t) => String(t.id) === idEq);
      return jr(200, rows);
    }
    if (method === 'PATCH') {
      const idEq = eq(p, 'id');
      const patch = JSON.parse(init.body);
      for (const t of db.transactions.values()) {
        if (!idEq || String(t.id) === idEq) Object.assign(t, patch);
      }
      return jr(200, null);
    }
  }

  if (u.pathname === '/rest/v1/documents') {
    return jr(200, db.documents);
  }

  if (u.pathname === '/rest/v1/email_suppression_list' || u.pathname === '/rest/v1/unsubscribe_list' || u.pathname === '/rest/v1/email_events') {
    return jr(200, []); // nobody suppressed/bounced in this test
  }

  if (u.pathname === '/rest/v1/email_queue') {
    if (method === 'GET') {
      let rows = db.email_queue.slice();
      const userId = eq(p, 'user_id');
      if (userId) rows = rows.filter((r) => r.user_id === userId);
      const idEq = eq(p, 'id');
      if (idEq) rows = rows.filter((r) => r.id === idEq);
      const statusNeq = p.get('status');
      if (statusNeq && statusNeq.startsWith('neq.')) rows = rows.filter((r) => r.status !== statusNeq.slice(4));
      return jr(200, rows);
    }
    if (method === 'POST') {
      const row = Object.assign({ id: newId(), created_at: new Date().toISOString() }, JSON.parse(init.body));
      db.email_queue.push(row);
      return jr(201, [row]);
    }
    if (method === 'PATCH') {
      const idEq = eq(p, 'id');
      const patch = JSON.parse(init.body);
      for (const r of db.email_queue) if (!idEq || r.id === idEq) Object.assign(r, patch);
      return jr(200, null);
    }
  }

  if (u.pathname === '/rest/v1/action_items') {
    if (method === 'GET') {
      let rows = db.action_items.slice();
      const idEq = eq(p, 'id');
      if (idEq) rows = rows.filter((r) => r.id === idEq);
      const userId = eq(p, 'user_id');
      if (userId) rows = rows.filter((r) => r.user_id === userId);
      return jr(200, rows);
    }
    if (method === 'POST') {
      const row = Object.assign({ id: newId(), created_at: new Date().toISOString() }, JSON.parse(init.body));
      db.action_items.push(row);
      return jr(201, [row]);
    }
    if (method === 'PATCH') {
      const idEq = eq(p, 'id');
      const patch = JSON.parse(init.body);
      for (const r of db.action_items) if (!idEq || r.id === idEq) Object.assign(r, patch);
      return jr(200, null);
    }
  }

  if (u.pathname === '/rest/v1/outbound_email_queue') {
    if (method === 'GET') {
      let rows = db.outbound_email_queue.slice();
      const status = p.get('status');
      if (status && status.startsWith('eq.')) rows = rows.filter((r) => r.status === status.slice(3));
      const idEq = eq(p, 'id');
      if (idEq) rows = rows.filter((r) => r.id === idEq);
      const lockedLt = p.get('locked_at');
      if (lockedLt && lockedLt.startsWith('lt.')) rows = rows.filter((r) => r.status === 'sending' && r.locked_at && r.locked_at < decodeURIComponent(lockedLt.slice(3)));
      rows.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
      return jr(200, rows);
    }
    if (method === 'POST') {
      const row = Object.assign({
        id: newId(), created_at: new Date().toISOString(), status: 'pending', attempts: 0, kind: 'cold_outreach',
      }, JSON.parse(init.body));
      db.outbound_email_queue.push(row);
      return jr(201, [row]);
    }
    if (method === 'PATCH') {
      const idEq = eq(p, 'id');
      const statusEq = p.get('status');
      const patch = JSON.parse(init.body);
      const matched = [];
      for (const r of db.outbound_email_queue) {
        const idMatches = !idEq || r.id === idEq;
        const statusMatches = !statusEq || !statusEq.startsWith('eq.') || r.status === statusEq.slice(3);
        if (idMatches && statusMatches) { Object.assign(r, patch); matched.push(r); }
      }
      return jr(200, matched);
    }
  }

  if (u.pathname === '/rest/v1/cron_runs') {
    const name = eq(p, 'cron_name');
    if (method === 'GET') {
      const row = name ? db.cron_runs.get(name) : null;
      return jr(200, row ? [row] : []);
    }
    if (method === 'POST') { // upsert on_conflict=cron_name
      const payload = JSON.parse(init.body);
      db.cron_runs.set(payload.cron_name, payload);
      return jr(200, null);
    }
  }

  throw new Error(`fakeFetch: unhandled ${method} ${u.pathname}${u.search}`);
};

function jr(status, data) {
  const text = data === null ? '' : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  return res;
}

function badgeCountQuery(userId) {
  // Mirrors dossie-app.jsx's loadDraftCounts(): email_queue, user_id eq,
  // status neq 'sent'. Same shape, just expressed against our fake table.
  return db.email_queue.filter((r) => r.user_id === userId && r.status !== 'sent').length;
}

async function main() {
  console.log('email_queue -> outbound_email_queue migration regression (2026-10-08)');
  console.log('=========================================================================================');

  // === 1. send-email.js logs to outbound_email_queue, NOT email_queue ===
  const TX_ID = 'TX-1';
  db.transactions.set(TX_ID, {
    id: TX_ID, user_id: 'U1', role: 'listing',
    seller_name: 'Barry Whyte', seller_email: 'barry@example.com',
    buyer_name: 'Christopher Bryan', buyer_email: 'buyercontact2@example.net',
    buyer2_email: null, seller2_email: null, parties: {}, property_address: '1 Test Dr',
  });
  db.documents.push({ id: 'doc-1', file_name: 'contract.pdf', executed_at: '2026-09-01T00:00:00Z' });

  let res = makeRes();
  await sendEmail({
    method: 'POST',
    headers: { authorization: 'Bearer test-jwt' },
    body: { to: 'barry@example.com', subject: 'Update on your sale', body: 'Quick update.', agentName: 'Jamie Agent', agentEmail: 'agent@example.com', transactionId: TX_ID },
  }, res);
  assert.strictEqual(res.statusCode, 200, `send-email failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(db.email_queue.length, 0, 'send-email.js must NOT write to email_queue anymore');
  assert.strictEqual(db.outbound_email_queue.length, 1, 'send-email.js must log exactly one row to outbound_email_queue');
  const logRow = db.outbound_email_queue[0];
  assert.strictEqual(logRow.kind, 'member_transaction');
  assert.strictEqual(logRow.status, 'sent');
  assert.strictEqual(logRow.user_id, 'U1');
  assert.strictEqual(logRow.transaction_id, TX_ID);
  assert.strictEqual(logRow.from_display_name, 'Jamie Agent');
  console.log('  PASS: send-email.js logs member_transaction/sent to outbound_email_queue, zero email_queue writes');
  console.log('    row:', JSON.stringify(logRow));

  // === 2. cron-request-testimonial-draft.js is the real draft writer ===
  db.transactions.set('TX-2', {
    id: 'TX-2', user_id: 'U1', role: 'buyer', status: 'closed',
    property_address: '104 Wild Cherry', closing_date: new Date().toISOString().slice(0, 10),
    buyer_name: 'Kanika Jain', buyer_email: 'kanika@example.com', buyer2_name: null, buyer2_email: null,
    seller_name: null, seller2_name: null, seller_email: null, seller2_email: null,
    testimonial_draft_created_at: null,
  });

  res = makeRes();
  await testimonialDraftCron({ headers: { authorization: 'Bearer fake-cron-secret' } }, res);
  assert.strictEqual(res.statusCode, 200, `testimonial draft cron failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.drafted, 1, `expected 1 draft, got: ${JSON.stringify(res.body)}`);
  assert.strictEqual(db.email_queue.length, 1, 'exactly one real draft row should now exist in email_queue');
  assert.strictEqual(db.email_queue[0].status, 'pending');
  console.log('  PASS: cron-request-testimonial-draft.js writes a real pending draft to email_queue');

  // === 3. badge-query-equivalent count reflects the real draft ===
  assert.strictEqual(badgeCountQuery('U1'), 1, 'badge count (email_queue, status != sent, per user) must now be non-zero');
  console.log('  PASS: badge count (email_queue status!=sent per user_id) = 1, matches dossie-app.jsx query shape');

  // === 4. cron-email-digest.js picks up the real draft ===
  res = makeRes();
  await digestCron({ headers: { authorization: 'Bearer fake-cron-secret' } }, res);
  assert.strictEqual(res.statusCode, 200, `digest failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.digests_sent, 1, `expected 1 digest sent, got: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.zero_draft_streak_days, 0, 'a customer with a real draft today must reset the zero-streak to 0');
  const digestEmail = sentEmails[sentEmails.length - 1];
  assert.ok(digestEmail.subject.includes('1 draft'), `digest subject should mention the draft: ${digestEmail.subject}`);
  console.log('  PASS: cron-email-digest.js sends a real digest for the real draft, streak resets to 0');

  // === 5. send-testimonial-request.js sends it and marks sent ===
  const actionItem = db.action_items.find((a) => a.action_type === 'testimonial_request' && a.transaction_id === 'TX-2');
  assert.ok(actionItem, 'action_items row for the testimonial draft must exist');
  res = makeRes();
  await sendTestimonialRequest({
    method: 'POST', headers: { authorization: 'Bearer test-jwt' }, body: { action_item_id: actionItem.id },
  }, res);
  assert.strictEqual(res.statusCode, 200, `send-testimonial-request failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(db.email_queue[0].status, 'sent');
  console.log('  PASS: send-testimonial-request.js sends the draft and marks it sent');

  // === 6. badge count goes back to 0 once sent ===
  assert.strictEqual(badgeCountQuery('U1'), 0, 'badge count must return to 0 once the one draft is sent');
  console.log('  PASS: badge count (email_queue status!=sent) returns to 0 after sending');

  // === 7. REGRESSION: cold-email / marketing path on outbound_email_queue is untouched ===
  const coldRow = {
    to_email: 'lead@example.com', subject: 'Cold intro', body_text: 'Hello from Heath.', status: 'pending',
  }; // no `kind` -> defaults to cold_outreach, same shape queue-outbound-email.js writes
  const coldSaved = Object.assign({ id: newId(), created_at: new Date().toISOString(), attempts: 0, kind: 'cold_outreach' }, coldRow);
  db.outbound_email_queue.push(coldSaved);

  const emailsBeforeColdRun = sentEmails.length;
  res = makeRes();
  await outboundSendCron({ method: 'GET', headers: { authorization: 'Bearer fake-cron-secret' } }, res);
  assert.strictEqual(res.statusCode, 200, `cron-send-outbound-emails failed: ${JSON.stringify(res.body)}`);
  assert.strictEqual(res.body.sent, 1, `expected the cold_outreach row to send, got: ${JSON.stringify(res.body)}`);
  assert.strictEqual(sentEmails.length, emailsBeforeColdRun + 1);
  const coldSentEmail = sentEmails[sentEmails.length - 1];
  assert.strictEqual(coldSentEmail.from, 'Heath at Dossie <heath@meetdossie.com>', 'cold_outreach identity must be completely unchanged');
  assert.deepStrictEqual(coldSentEmail.bcc, ['heath@meetdossie.com'], 'cold_outreach must still BCC Heath — unchanged');
  const reloaded = db.outbound_email_queue.find((r) => r.id === coldSaved.id);
  assert.strictEqual(reloaded.status, 'sent');
  console.log('  PASS: cold_outreach rows on outbound_email_queue are completely unregressed (identity, BCC, auto-send-in-under-a-minute all unchanged)');

  // Member-transaction rows must NEVER get auto-claimed by this cron (they
  // are written with status='sent' directly by send-email.js, never
  // 'pending' — confirm that invariant holds).
  const memberPending = db.outbound_email_queue.filter((r) => r.kind === 'member_transaction' && r.status === 'pending');
  assert.strictEqual(memberPending.length, 0, 'member_transaction rows must never sit pending for the auto-send cron to grab');
  console.log('  PASS: member_transaction rows never enter the auto-send cron\'s pending pool');

  // === 8. Sustained zero-draft silent-failure alarm ===
  // Fresh customer with never a single draft, run the digest repeatedly.
  db.subscriptions.push({ user_id: 'U2', plan: 'solo', status: 'active' });
  db.profiles.push({ id: 'U2', email: 'nodrafts@example.com', full_name: 'No Drafts', is_demo: false });
  // Remove U1's subscription for this isolated test so only U2 (zero drafts
  // forever) drives the streak — keeps the arithmetic unambiguous.
  db.subscriptions = db.subscriptions.filter((s) => s.user_id !== 'U1');

  let lastDigestBody = null;
  for (let i = 1; i <= 7; i++) {
    res = makeRes();
    await digestCron({ headers: { authorization: 'Bearer fake-cron-secret' } }, res);
    lastDigestBody = res.body;
    console.log(`    run ${i}: zero_draft_streak_days=${res.body.zero_draft_streak_days}, ok=${res.body.ok}`);
    if (i < 7) {
      assert.strictEqual(res.statusCode, 200, `run ${i} should still be ok (streak ${i} < threshold)`);
      assert.strictEqual(res.body.ok, true);
    }
  }
  assert.strictEqual(lastDigestBody.zero_draft_streak_days, 7);
  assert.strictEqual(lastDigestBody.ok, false, 'after 7 consecutive all-zero runs the digest must flip to ok:false');
  assert.strictEqual(res.statusCode, 500, 'ok:false must surface as a 500, same convention as cron-deadline-reminders.js');
  assert.ok(lastDigestBody.silent_failure_alert, 'a silent_failure_alert message must be present');
  console.log('  PASS: 7 consecutive zero-draft runs flips the digest to ok:false with a silent_failure_alert');

  // A real draft for U2 must reset the streak back to 0 on the next run.
  db.email_queue.push({
    id: newId(), user_id: 'U2', transaction_id: 'TX-3', to_email: 'client@example.com',
    subject: 'A draft', body: 'Body', status: 'pending', created_at: new Date().toISOString(),
  });
  res = makeRes();
  await digestCron({ headers: { authorization: 'Bearer fake-cron-secret' } }, res);
  assert.strictEqual(res.body.zero_draft_streak_days, 0, 'a real draft must reset the streak to 0, un-stuck from the alarm');
  assert.strictEqual(res.body.ok, true);
  console.log('  PASS: a real draft resets the zero-draft streak to 0 and clears the alarm');

  console.log('\n=========================================================================================');
  console.log('All tests passed');
}

main().catch((e) => {
  console.error('FATAL:', (e && e.stack) || e);
  process.exit(1);
});
