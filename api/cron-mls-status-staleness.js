'use strict';

// api/cron-mls-status-staleness.js
// =============================================================================
// Detects one specific, high-confidence staleness condition: a dossier's own
// tracked stage still shows 'option-period' after that dossier's own
// option_expiration_date has passed. That mismatch is exactly what happened on
// 104 Wild Cherry (2026-08-13/2026-08-18 window) — option period ended and the
// repair amendment was fully executed, but the MLS status sat on "Active
// Option" for 4 days because nobody was watching the dossier's own facts
// against its own stage.
//
// THIS IS DETECTION + ALERT ONLY. Dossie has no MLS credentials and never
// writes to MLS — same principle as the e-sign "verify the document, never
// the status" rule. The output is a dossie_asks row (urgency: critical,
// source: 'system:mls-status-stale') that nudges the agent to go make the
// change themselves. See api/dossie-asks.js + src/components/DossieAsks.jsx
// (Dossie repo) for the surface this feeds.
//
// Deliberately narrow: one condition, not a model of every MLS status
// transition. Broaden only after this one is proven out.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: "15 13 * * *" (8:15 AM CDT, same batch window as
//            cron-deadline-reminders / cron-email-digest)
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// A dossier is not "stale" the instant the clock ticks past midnight on
// expiration day — agents are still closing out that day's paperwork. Flag
// once it's unambiguously been sitting, not on day zero.
const GRACE_DAYS = 1;

// If a prior ask on this exact condition was resolved or dismissed and the
// underlying mismatch is STILL true, re-raise after this many days rather
// than assuming a dismissal means it was actually fixed in MLS.
const RE_RAISE_DAYS = 3;

const SOURCE = 'system:mls-status-stale';

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function isAuthorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  if (CRON_SECRET && req.query && req.query.secret === CRON_SECRET) return true;
  return false;
}

// Same Chicago-date anchoring as cron-deadline-reminders.js / cron-morning-brief.js —
// staleness is date-based, not clock-based.
function todayChicagoYMD() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function daysBetweenYMD(earlierYMD, laterYMD) {
  const a = new Date(`${earlierYMD}T00:00:00Z`).getTime();
  const b = new Date(`${laterYMD}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}

function friendlyDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function dealLabel(address) {
  if (!address || typeof address !== 'string') return 'this dossier';
  return address.split(',')[0].trim();
}

// Same customer exclusions as cron-deadline-reminders.js: skip demo accounts,
// Heath's own login, and anyone without an active subscription.
function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.startsWith('heath.shepard@')) return true;
  if (e.includes('demo')) return true;
  return false;
}

async function loadActiveCustomerIds() {
  const subResp = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=user_id');
  if (!subResp.ok) throw new Error(`subscriptions fetch ${subResp.status}`);
  const userIds = (subResp.data || []).map((s) => s.user_id).filter(Boolean);
  if (userIds.length === 0) return new Set();

  const filter = userIds.map((id) => `"${id}"`).join(',');
  const profResp = await supabaseFetch(
    `/rest/v1/profiles?id=in.(${filter})&select=id,email,is_demo`,
  );
  if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);

  const out = new Set();
  for (const p of (profResp.data || [])) {
    if (p.is_demo) continue;
    if (isExcludedEmail(p.email)) continue;
    out.add(p.id);
  }
  return out;
}

// Most recent dossie_ask on this exact condition for this transaction, if any.
async function loadMostRecentAsk(transactionId) {
  const r = await supabaseFetch(
    `/rest/v1/dossie_asks?transaction_id=eq.${encodeURIComponent(transactionId)}` +
      `&source=eq.${encodeURIComponent(SOURCE)}` +
      `&select=id,status,resolved_at,created_at` +
      `&order=created_at.desc&limit=1`,
  );
  if (!r.ok) throw new Error(`dossie_asks read failed (${r.status}) for tx ${transactionId}`);
  return (r.data || [])[0] || null;
}

async function createAsk({ userId, transactionId, address, expirationYMD, staleDays }) {
  const label = dealLabel(address);
  const niceDate = friendlyDate(expirationYMD);
  const payload = {
    user_id: userId,
    transaction_id: transactionId,
    urgency: 'critical',
    title: 'Your MLS status may be behind',
    body:
      `The option period on ${label} ended ${niceDate} (${staleDays} day${staleDays === 1 ? '' : 's'} ago), ` +
      `but this dossier still shows Option Period as the stage. If the MLS listing still reads Active Option, ` +
      `that's stale for anyone looking at the listing and a real flag if your broker or TREC ever reviews the ` +
      `file. Want to jump into MLS and update the status now?`,
    due_at: null,
    due_label: `Option ended ${niceDate}`,
    suggested_actions: [
      { id: 'updated_mls', label: 'Done — I updated MLS', kind: 'primary', effect: 'resolve' },
      { id: 'not_yet', label: 'Not yet, remind me', kind: 'secondary', effect: 'snooze' },
    ],
    created_by: 'system',
    source: SOURCE,
  };

  const r = await supabaseFetch('/rest/v1/dossie_asks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  return r.ok;
}

module.exports = withTelemetry('cron-mls-status-staleness', async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const dryRun = String(req.query?.dryRun || '') === '1';
  const forceTxId = req.query?.forceTxId ? String(req.query.forceTxId) : null;

  const today = todayChicagoYMD();

  let activeCustomerIds;
  try {
    activeCustomerIds = await loadActiveCustomerIds();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'customer_load_failed', detail: String(err && err.message) });
  }

  // Candidates: open dossiers still tracked as 'option-period' with a real
  // option_expiration_date on file. forceTxId bypasses the customer filter so
  // a specific transaction can be smoke-tested without touching real
  // subscription state.
  let query =
    `/rest/v1/transactions?select=id,user_id,property_address,option_expiration_date,stage,status` +
    `&stage=eq.option-period` +
    `&option_expiration_date=not.is.null` +
    `&or=(status.is.null,status.neq.closed)`;
  if (forceTxId) {
    query = `/rest/v1/transactions?select=id,user_id,property_address,option_expiration_date,stage,status&id=eq.${encodeURIComponent(forceTxId)}`;
  }

  const txRes = await supabaseFetch(query);
  if (!txRes.ok) {
    return res.status(500).json({ ok: false, error: 'transactions_read_failed', status: txRes.status });
  }

  const results = [];
  let flagged = 0;
  let created = 0;

  for (const tx of (txRes.data || [])) {
    if (!forceTxId && !activeCustomerIds.has(tx.user_id)) continue;

    const expirationYMD = String(tx.option_expiration_date).slice(0, 10);
    const staleDays = daysBetweenYMD(expirationYMD, today);
    if (staleDays < GRACE_DAYS) continue; // not yet stale enough to flag

    flagged++;

    let existing;
    try {
      existing = await loadMostRecentAsk(tx.id);
    } catch (err) {
      results.push({ transaction_id: tx.id, error: String(err && err.message) });
      continue;
    }

    if (existing) {
      if (existing.status === 'open' || existing.status === 'snoozed') {
        results.push({ transaction_id: tx.id, skipped: 'already_open', stale_days: staleDays });
        continue;
      }
      // resolved/dismissed — only re-raise if it's been long enough that a
      // dismissal without a real MLS fix shouldn't stay silent forever.
      const resolvedAt = existing.resolved_at ? new Date(existing.resolved_at).getTime() : 0;
      const ageDays = resolvedAt ? (Date.now() - resolvedAt) / 86400000 : Infinity;
      if (ageDays < RE_RAISE_DAYS) {
        results.push({ transaction_id: tx.id, skipped: 're_raise_cooldown', stale_days: staleDays });
        continue;
      }
    }

    if (dryRun) {
      results.push({ transaction_id: tx.id, would_create: true, stale_days: staleDays, property_address: tx.property_address });
      continue;
    }

    const ok = await createAsk({
      userId: tx.user_id,
      transactionId: tx.id,
      address: tx.property_address,
      expirationYMD,
      staleDays,
    });
    if (ok) created++;
    results.push({ transaction_id: tx.id, created: ok, stale_days: staleDays, property_address: tx.property_address });
  }

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    candidates_checked: (txRes.data || []).length,
    flagged,
    created,
    results,
  });
});
