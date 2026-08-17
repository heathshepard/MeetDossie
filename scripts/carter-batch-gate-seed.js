'use strict';
// scripts/carter-batch-gate-seed.js
//
// Carter, 2026-08-17 — seeds/cleans up ONE synthetic outbound_email_queue row
// that reproduces the batch-gated state (metadata.requires_approval=true,
// approval_status='pending_approval') that produced the raw
// "Approve failed: not_yet_batch_approved" toast Heath hit. Addressed to
// Heath's own inbox, marked [TEST], never actually sends (batch-gated blocks
// send, and cleanup marks it 'skipped'). No customer/prospect data touched.
//
// Usage:
//   node scripts/carter-batch-gate-seed.js seed    -> inserts the test row, prints its id
//   node scripts/carter-batch-gate-seed.js cleanup -> deletes any [TEST] rows this script created

const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_SUBJECT = '[TEST] Carter batch-gate verification 2026-08-17';
const TEST_BATCH_ID = 'TEST-CARTER-BATCHGATE-2026-08-17';

function sbHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function seed() {
  const now = new Date();
  // Backdated so it sorts FIRST in the endpoint's order=created_at.asc&limit=25
  // query (oldest-first) — otherwise a brand-new row loses to older real rows
  // and never appears in the top 25 fetched by /api/jarvis-pending-approvals.
  // Must stay within the endpoint's 7-day freshness window (older rows get
  // bucketed into stale_items, which the UI never renders) — one minute
  // before the oldest real pending row works and is still plenty fresh.
  const backdated = new Date('2026-08-17T03:21:00.000Z');
  const row = {
    to_email: 'heath.shepard@kw.com',
    from_email: 'heath@meetdossie.com',
    subject: TEST_SUBJECT,
    body_text: 'Carter verification row — reproduces the batch-approval-gated state. Safe to reject/delete.',
    body_html: '<p>Carter verification row — reproduces the batch-approval-gated state. Safe to reject/delete.</p>',
    status: 'pending',
    created_at: backdated.toISOString(),
    metadata: {
      send_after: now.toISOString(),
      campaign: 'carter-test',
      batch: TEST_BATCH_ID,
      queued_by: 'carter-batch-gate-seed',
      requires_approval: true,
      approval_status: 'pending_approval',
    },
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/outbound_email_queue`, {
    method: 'POST',
    headers: { ...sbHeaders(), Prefer: 'return=representation' },
    body: JSON.stringify([row]),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`seed insert failed: ${res.status} ${text.slice(0, 300)}`);
  const inserted = JSON.parse(text);
  console.log('SEEDED id:', inserted[0].id);
  return inserted[0].id;
}

async function cleanup() {
  const q = encodeURIComponent(TEST_SUBJECT);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/outbound_email_queue?subject=eq.${q}`, {
    method: 'DELETE',
    headers: sbHeaders(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`cleanup delete failed: ${res.status} ${text.slice(0, 300)}`);
  console.log('CLEANED UP rows with subject:', TEST_SUBJECT);
}

(async () => {
  const mode = process.argv[2];
  if (mode === 'seed') await seed();
  else if (mode === 'cleanup') await cleanup();
  else { console.error('Usage: node scripts/carter-batch-gate-seed.js seed|cleanup'); process.exit(1); }
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
