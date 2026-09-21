'use strict';

// api/cron-option-timing-risk.js
// =============================================================================
// Heath, direct request: "Regarding the option fee Dossie needs to also
// suggest to subscribers that if it's on a Friday and we're submitting a
// contract to maybe also ask the other agent to execute the contract on
// Sunday so that our option can start on Monday. I want Dossie to be
// proactive and able to help subscribers from getting into difficult
// situations like we got into with Low Oak." That file cost him $5,200 —
// see low-oak-earnest-money-dispute (memory) / friday-execution-option-
// fee-trap (memory).
//
// Detection lives in api/_lib/option-timing-risk.js (pure, tested against
// the two named acceptance cases — a Friday deal warns, a Tuesday deal
// stays quiet — plus holiday-collision cases a fixed weekday list would
// miss). This file is the I/O wrapper: same detection + dossie_asks pattern
// as api/cron-financial-sanity.js (dedup, re-raise cooldown, dry-run,
// forceTxId to bypass the demo-user exclusion for testing).
//
// ADVICE, NOT ACTION: this raises a dossie_asks card and explains the
// trade-off. It never moves an execution date, drafts an amendment, or
// contacts the other agent — the two suggested_actions are
// acknowledge/snooze, same as every other system-raised ask. The member
// decides.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: same daily in-app-surface batch as cron-financial-sanity.js /
// cron-mls-status-staleness.js.
//
// Owner: Carter, 2026-09-21.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { computeFundsDeliveryCollision } = require('./_lib/option-timing-risk.js');
const { todayInTexasYMD } = require('./_lib/chat-deal-deadlines.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Same re-raise cooldown reasoning as cron-financial-sanity.js: if a prior
// ask on this exact condition was resolved/dismissed and the underlying
// collision is STILL true (deal never re-scheduled), re-raise after this
// many days rather than staying silent forever on a live risk.
const RE_RAISE_DAYS = 3;
const SOURCE = 'system:option-timing-risk-funds-delivery-collision';

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

function isExcludedEmail(email) {
  if (!email) return true;
  return email.toLowerCase().includes('demo');
}

async function loadDemoUserIds() {
  const profResp = await supabaseFetch('/rest/v1/profiles?select=id,email,is_demo');
  if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);
  const out = new Set();
  for (const p of (profResp.data || [])) {
    if (p.is_demo || isExcludedEmail(p.email)) out.add(p.id);
  }
  return out;
}

async function loadMostRecentAsk(transactionId, source) {
  const r = await supabaseFetch(
    `/rest/v1/dossie_asks?transaction_id=eq.${encodeURIComponent(transactionId)}` +
      `&source=eq.${encodeURIComponent(source)}` +
      `&select=id,status,resolved_at,created_at,body` +
      `&order=created_at.desc&limit=1`,
  );
  if (!r.ok) throw new Error(`dossie_asks read failed (${r.status}) for tx ${transactionId}/${source}`);
  return (r.data || [])[0] || null;
}

async function raiseAsk({ userId, transactionId, urgency, title, body, dryRun, results, extra }) {
  let existing;
  try {
    existing = await loadMostRecentAsk(transactionId, SOURCE);
  } catch (err) {
    results.push({ transaction_id: transactionId, error: String(err && err.message) });
    return { created: false };
  }

  if (existing) {
    if (existing.status === 'open' || existing.status === 'snoozed') {
      results.push({ transaction_id: transactionId, skipped: 'already_open', ...extra });
      return { created: false };
    }
    const resolvedAt = existing.resolved_at ? new Date(existing.resolved_at).getTime() : 0;
    const ageDays = resolvedAt ? (Date.now() - resolvedAt) / 86400000 : Infinity;
    if (ageDays < RE_RAISE_DAYS) {
      results.push({ transaction_id: transactionId, skipped: 're_raise_cooldown', ...extra });
      return { created: false };
    }
  }

  if (dryRun) {
    results.push({ transaction_id: transactionId, would_create: true, ...extra });
    return { created: false };
  }

  const payload = {
    user_id: userId,
    transaction_id: transactionId,
    urgency,
    title,
    body,
    due_at: null,
    due_label: null,
    suggested_actions: [
      { id: 'reviewed', label: "Got it — I'll handle the timing", kind: 'primary', effect: 'resolve' },
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
  results.push({ transaction_id: transactionId, created: r.ok, ...extra });
  return { created: r.ok };
}

async function checkFundsDeliveryCollision(tx, today, { dryRun, results }) {
  const collision = computeFundsDeliveryCollision(tx.contract_effective_date, today, {
    optionDays: tx.option_days,
    optionExpirationDate: tx.option_expiration_date,
  });
  if (!collision) return;

  await raiseAsk({
    userId: tx.user_id,
    transactionId: tx.id,
    urgency: collision.isAlreadyPast ? 'high' : 'critical', // still time to act -> more urgent to catch it now
    title: collision.title,
    body: collision.body,
    dryRun,
    results,
    extra: {
      effective_date: collision.effectiveDate,
      colliding_dates: collision.collidingDates.map((d) => d.date),
      business_days_in_window: collision.businessDaysInWindow,
      already_past: collision.isAlreadyPast,
    },
  });
}

module.exports = withTelemetry('cron-option-timing-risk', async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const dryRun = String(req.query?.dryRun || '') === '1';
  const forceTxId = req.query?.forceTxId ? String(req.query.forceTxId) : null;
  const today = todayInTexasYMD();

  let demoUserIds;
  try {
    demoUserIds = await loadDemoUserIds();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'profiles_load_failed', detail: String(err && err.message) });
  }

  let query =
    `/rest/v1/transactions?select=id,user_id,property_address,contract_effective_date,option_days,option_expiration_date,stage,status` +
    `&or=(status.is.null,status.neq.closed)`;
  if (forceTxId) {
    query = `/rest/v1/transactions?select=id,user_id,property_address,contract_effective_date,option_days,option_expiration_date,stage,status&id=eq.${encodeURIComponent(forceTxId)}`;
  }

  const txRes = await supabaseFetch(query);
  if (!txRes.ok) {
    return res.status(500).json({ ok: false, error: 'transactions_read_failed', status: txRes.status });
  }

  const results = [];
  let checked = 0;

  for (const tx of (txRes.data || [])) {
    if (!forceTxId && demoUserIds.has(tx.user_id)) continue;
    if (tx.stage === 'closed' || tx.stage === 'terminated') continue;
    if (!tx.contract_effective_date) continue; // pre-contract — nothing to evaluate yet
    checked++;
    await checkFundsDeliveryCollision(tx, today, { dryRun, results });
  }

  const created = results.filter((r) => r.created === true).length;

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    today,
    transactions_checked: checked,
    created,
    results,
  });
});
