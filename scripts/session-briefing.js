'use strict';

// scripts/session-briefing.js
//
// Cole session-start snapshot. Queries live Supabase data and prints a
// clean dashboard to the terminal. Run at the top of every session.
//
// Usage:
//   node scripts/session-briefing.js
//
// Requires in .env.local:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const path = require('path');
const fs = require('fs');

// ── env loader ───────────────────────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  console.warn('[session-briefing] .env.local load failed:', e.message);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local');
  process.exit(1);
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'count=exact',
      ...(opts.headers || {}),
    },
  });
  // Supabase returns count in Content-Range header: "0-11/12"
  const countHeader = res.headers.get('content-range');
  const total = countHeader ? parseInt(countHeader.split('/')[1], 10) : null;
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { data, total, ok: res.ok, status: res.status };
}

function pad(label, value, width = 36) {
  const dots = '.'.repeat(Math.max(1, width - label.length));
  return `  ${label}${dots}${value}`;
}

function divider(char = '-', len = 50) {
  return char.repeat(len);
}

// ── queries ──────────────────────────────────────────────────────────────────
async function run() {
  const now = new Date();
  const todayISO = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const todayStart = `${todayISO}T00:00:00.000Z`;

  console.log('');
  console.log(divider('='));
  console.log('  DOSSIE SESSION BRIEFING');
  console.log(`  ${now.toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'full', timeStyle: 'short' })} CST`);
  console.log(divider('='));
  console.log('');

  const results = await Promise.allSettled([
    // 1. MRR: sum amount from active subscriptions
    sb('/subscriptions?status=eq.active&select=amount'),
    // 2. Customer count: active subscriptions
    sb('/subscriptions?status=eq.active&select=id'),
    // 3. Posts published today
    sb(`/social_posts?status=eq.posted&posted_at=gte.${todayStart}&select=id`),
    // 4. Posts in approved queue
    sb('/social_posts?status=eq.approved&select=id'),
    // 5. Posts in draft
    sb('/social_posts?status=eq.draft&select=id'),
    // 6. Open action items (all users, not completed)
    sb('/action_items?status=neq.completed&select=id'),
    // 7. Founding spots: active founding subscriptions
    sb('/subscriptions?status=eq.active&plan=eq.founding&select=id'),
  ]);

  // ── Revenue & Customers ───────────────────────────────────────────────────
  console.log('  REVENUE & CUSTOMERS');
  console.log(divider());

  const subsResult = results[0];
  let mrr = 0;
  if (subsResult.status === 'fulfilled' && subsResult.value.ok) {
    const subs = Array.isArray(subsResult.value.data) ? subsResult.value.data : [];
    mrr = subs.reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
  }
  // MRR is stored in cents if Stripe-style, or dollars.
  // CLAUDE.md shows $29/mo entries — treat as dollars directly.
  const mrrDisplay = mrr > 1000 ? `$${(mrr / 100).toFixed(2)}/mo` : `$${mrr}/mo`;
  console.log(pad('MRR', mrrDisplay));

  const custResult = results[1];
  let customerCount = '?';
  if (custResult.status === 'fulfilled') {
    const { data, total } = custResult.value;
    customerCount = total !== null ? total : (Array.isArray(data) ? data.length : '?');
  }
  console.log(pad('Active customers', String(customerCount)));

  const foundingResult = results[6];
  let foundingCount = 0;
  if (foundingResult.status === 'fulfilled') {
    const { data, total } = foundingResult.value;
    foundingCount = total !== null ? total : (Array.isArray(data) ? data.length : 0);
  }
  const spotsRemaining = Math.max(0, 50 - foundingCount);
  console.log(pad('Founding spots remaining', `${spotsRemaining} / 50`));

  console.log('');

  // ── Content Pipeline ──────────────────────────────────────────────────────
  console.log('  CONTENT PIPELINE');
  console.log(divider());

  const postedTodayResult = results[2];
  let postedToday = '?';
  if (postedTodayResult.status === 'fulfilled') {
    const { data, total } = postedTodayResult.value;
    postedToday = total !== null ? total : (Array.isArray(data) ? data.length : '?');
  }
  console.log(pad('Posts published today', String(postedToday)));

  const approvedResult = results[3];
  let approvedQueue = '?';
  if (approvedResult.status === 'fulfilled') {
    const { data, total } = approvedResult.value;
    approvedQueue = total !== null ? total : (Array.isArray(data) ? data.length : '?');
  }
  console.log(pad('Posts in approved queue', String(approvedQueue)));

  const draftResult = results[4];
  let draftCount = '?';
  if (draftResult.status === 'fulfilled') {
    const { data, total } = draftResult.value;
    draftCount = total !== null ? total : (Array.isArray(data) ? data.length : '?');
  }
  console.log(pad('Posts in draft', String(draftCount)));

  console.log('');

  // ── Product ───────────────────────────────────────────────────────────────
  console.log('  PRODUCT');
  console.log(divider());

  const actionResult = results[5];
  let openItems = '?';
  if (actionResult.status === 'fulfilled') {
    const { data, total } = actionResult.value;
    openItems = total !== null ? total : (Array.isArray(data) ? data.length : '?');
  }
  console.log(pad('Open action items (all users)', String(openItems)));

  console.log('');

  // ── Errors ────────────────────────────────────────────────────────────────
  const errors = results
    .map((r, i) => ({ i, r }))
    .filter(({ r }) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok))
    .map(({ i, r }) => {
      if (r.status === 'rejected') return `  Query #${i + 1}: ${r.reason?.message || r.reason}`;
      return `  Query #${i + 1}: HTTP ${r.value.status}`;
    });

  if (errors.length > 0) {
    console.log('  QUERY ERRORS');
    console.log(divider());
    errors.forEach((e) => console.log(e));
    console.log('');
  }

  console.log(divider('='));
  console.log('');
}

run().catch((err) => {
  console.error('[session-briefing] fatal error:', err.message);
  process.exit(1);
});
