'use strict';

// api/cron-financial-sanity.js
// =============================================================================
// Alpha TC Roadmap #1 (Atlas infra audit, 2026-08-24): "nothing checks
// appraisal-vs-price gap math, commission math, or net-sheet consistency
// automatically." Three independent checks, each writing its own dossie_asks
// row when it finds a real problem:
//
//   1. APPRAISAL GAP — transactions.appraisal_value (populated today via
//      chat/dossie-voice-fill when the agent tells Dossie "appraisal came in
//      at $X") vs. sale_price. Below-price appraisals are a real, common
//      financing-contingency risk (TREC Third Party Financing Addendum /
//      appraisal termination right) — the agent needs to know the moment the
//      number is entered, not discover it during closing prep.
//
//   2. COMMISSION MATH — transactions.commission_rate is free text extracted
//      by scan-contract.js from whatever language the Listing Agreement
//      used, NOT a clean numeric column. Verified against real production
//      data before writing this (see api/_lib/commission-math.js header):
//      values in the wild include "2.5%", "$3,500.00 flat fee (no percentage
//      specified)", and "5.500% total (2.500% to buyer's broker)". The naive
//      parse already used as a net-sheet contract-default
//      (`parseFloat(rate.replace(/[^0-9.]/g,''))`) turns the flat-fee example
//      into commissionPct=3500 — an implied $2.29M commission on a $65,500
//      sale if that default is ever used unmodified. This check parses the
//      real text properly and flags anything that doesn't reduce to one
//      plausible number.
//
//   3. NET SHEET RECONCILIATION — api/net-sheet.js computes a breakdown
//      array (what the agent SEES) and a netProceeds figure (the number they
//      trust) from the same formula. This independently re-sums the
//      breakdown items and verifies they equal netProceeds. It is not a
//      per-transaction data-quality check (net sheets aren't persisted —
//      api/net-sheet.js computes on demand and never writes a row) — it is a
//      regression trip-wire against exactly the bug class "a line item was
//      added to the display array without updating the total, or vice
//      versa." Runs against every open transaction's current
//      contract-extracted defaults so it exercises the real formula daily,
//      not just at test time.
//
// THIS IS DETECTION + ALERT ONLY — same principle as cron-mls-status-
// staleness.js. Dossie never edits commission_rate, appraisal_value, or any
// financial figure; it surfaces a dossie_asks card and the agent decides.
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: "20 13 * * *" (5 min after cron-mls-status-staleness, same
//            8:15-8:20 AM CDT batch window as the other daily in-app-surface
//            crons).
//
// Owner: Carter, 2026-08-25 (Alpha TC Roadmap #1)
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { calculateNetSheet, reconcileBreakdown } = require('./_lib/net-sheet-calc.js');
const { parseCommissionRate, checkCommissionPlausibility } = require('./_lib/commission-math.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// A below-price appraisal under 1% is often just rounding/estimation noise
// in how the number got typed in; TREC's own financing contingency clock
// doesn't care about the size of the shortfall, but this keeps day-one out
// of "flag literally every dollar" territory. Anything at or above this gets
// flagged; severity still scales with the real gap.
const MIN_GAP_PCT = 0.1;
const CRITICAL_GAP_PCT = 3; // TREC's common "material" appraisal gap threshold in practice

// If a prior ask on this exact condition was resolved/dismissed and the
// underlying mismatch is STILL true, re-raise after this many days — same
// pattern and same reasoning as cron-mls-status-staleness.js.
const RE_RAISE_DAYS = 3;

const SOURCE_APPRAISAL = 'system:financial-sanity-appraisal-gap';
const SOURCE_COMMISSION = 'system:financial-sanity-commission-math';
const SOURCE_NET_SHEET = 'system:financial-sanity-net-sheet';

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

function dealLabel(address) {
  if (!address || typeof address !== 'string') return 'this dossier';
  return address.split(',')[0].trim();
}

function money(n) {
  return Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });
}

// Most recent dossie_ask on a given (transaction, source) pair, if any.
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

// Shared create/dedup logic for all three checks: skip if an identical open
// ask already exists, re-raise if a prior one was resolved/dismissed long
// enough ago that a real fix in the underlying data hasn't since cleared it
// (i.e. the condition is still true today).
async function raiseAsk({ userId, transactionId, source, urgency, title, body, dryRun, results, extra }) {
  let existing;
  try {
    existing = await loadMostRecentAsk(transactionId, source);
  } catch (err) {
    results.push({ transaction_id: transactionId, source, error: String(err && err.message) });
    return { created: false };
  }

  if (existing) {
    if (existing.status === 'open' || existing.status === 'snoozed') {
      results.push({ transaction_id: transactionId, source, skipped: 'already_open', ...extra });
      return { created: false };
    }
    const resolvedAt = existing.resolved_at ? new Date(existing.resolved_at).getTime() : 0;
    const ageDays = resolvedAt ? (Date.now() - resolvedAt) / 86400000 : Infinity;
    if (ageDays < RE_RAISE_DAYS) {
      results.push({ transaction_id: transactionId, source, skipped: 're_raise_cooldown', ...extra });
      return { created: false };
    }
  }

  if (dryRun) {
    results.push({ transaction_id: transactionId, source, would_create: true, ...extra });
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
      { id: 'reviewed', label: 'Reviewed — confirmed correct', kind: 'primary', effect: 'resolve' },
      { id: 'not_yet', label: 'Not yet, remind me', kind: 'secondary', effect: 'snooze' },
    ],
    created_by: 'system',
    source,
  };

  const r = await supabaseFetch('/rest/v1/dossie_asks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
  results.push({ transaction_id: transactionId, source, created: r.ok, ...extra });
  return { created: r.ok };
}

// -----------------------------------------------------------------------
// Check 1: appraisal vs. sale price gap
// -----------------------------------------------------------------------
async function checkAppraisalGap(tx, { dryRun, results }) {
  const salePrice = Number(tx.sale_price);
  const appraisalValue = Number(tx.appraisal_value);
  if (!Number.isFinite(salePrice) || salePrice <= 0) return;
  if (!Number.isFinite(appraisalValue) || appraisalValue <= 0) return;

  const gap = salePrice - appraisalValue;
  if (gap <= 0) return; // appraisal at/above price — no financing-contingency risk from this
  const gapPct = Math.round((gap / salePrice) * 1000) / 10;
  if (gapPct < MIN_GAP_PCT) return;

  const urgency = gapPct >= CRITICAL_GAP_PCT ? 'critical' : 'high';
  const label = dealLabel(tx.property_address);
  const body =
    `The appraisal on ${label} came back at ${money(appraisalValue)} against a ${money(salePrice)} sale price — ` +
    `${money(gap)} short (${gapPct}%). If the buyer's financing is contingent on the appraised value, this is a ` +
    `real trigger under the Third Party Financing Addendum: the buyer may have the right to terminate, or you're ` +
    `heading into a price renegotiation or an appraisal gap payment conversation. Worth confirming this number and ` +
    `getting ahead of it now rather than at closing.`;

  await raiseAsk({
    userId: tx.user_id,
    transactionId: tx.id,
    source: SOURCE_APPRAISAL,
    urgency,
    title: 'Appraisal came in below sale price',
    body,
    dryRun,
    results,
    extra: { sale_price: salePrice, appraisal_value: appraisalValue, gap, gap_pct: gapPct },
  });
}

// -----------------------------------------------------------------------
// Check 2: commission math
// -----------------------------------------------------------------------
async function checkCommissionMath(tx, { dryRun, results }) {
  if (!tx.commission_rate) return;
  const salePrice = Number(tx.sale_price);
  const parsed = parseCommissionRate(tx.commission_rate);
  if (parsed.kind === 'empty') return;
  const check = checkCommissionPlausibility(parsed, salePrice);
  if (!check.implausible) return;

  const label = dealLabel(tx.property_address);
  const body =
    `The commission on ${label} is recorded as "${parsed.raw}"${Number.isFinite(salePrice) ? ` against a ${money(salePrice)} sale price` : ''} — ${check.reason}. ` +
    `This came from AI extraction off the contract, not a typed-in number, so it's worth a quick confirm before it ` +
    `feeds a net sheet, CDA, or anything else that trusts it as a straight percentage.`;

  await raiseAsk({
    userId: tx.user_id,
    transactionId: tx.id,
    source: SOURCE_COMMISSION,
    urgency: 'high',
    title: 'Commission rate needs a quick confirm',
    body,
    dryRun,
    results,
    extra: { commission_rate_raw: parsed.raw, parsed_kind: parsed.kind, implied_amount: check.impliedAmount, implied_pct: check.impliedPct },
  });
}

// -----------------------------------------------------------------------
// Check 3: net sheet reconciliation (regression trip-wire, not a per-deal
// data check — see file header). Uses only real contract-extracted defaults
// (sale_price, commission_pct derived from commission_rate, option_fee);
// every manual-entry field (mortgage payoff, escrow, title, HOA transfer,
// warranty, survey, repairs, other credits) is not stored on the
// transaction and defaults to 0 here, same as api/net-sheet.js's own GET
// prefill would show before the agent touches anything.
// -----------------------------------------------------------------------
async function checkNetSheetReconciliation(tx, { dryRun, results }) {
  const salePrice = Number(tx.sale_price);
  if (!Number.isFinite(salePrice) || salePrice <= 0) return;

  let commissionPct = 3; // net-sheet.js's own fallback when nothing is on file
  if (tx.commission_rate) {
    const parsed = parseCommissionRate(tx.commission_rate);
    if (parsed.kind === 'percent' && Number.isFinite(parsed.totalPct)) commissionPct = parsed.totalPct;
    // flat/ambiguous commission text is out of scope for this check — that's
    // exactly what checkCommissionMath() above exists to flag separately.
  }
  const optionFeeCredit = Number.isFinite(Number(tx.option_fee)) && Number(tx.option_fee) > 0 ? Number(tx.option_fee) : 0;

  const { breakdown, netProceeds } = calculateNetSheet({ salePrice, commissionPct, optionFeeCredit });
  const rec = reconcileBreakdown({ salePrice, breakdown, netProceeds });
  if (rec.ok) return;

  // A mismatch here means the shared formula itself is internally
  // inconsistent — a real engineering bug, not a per-transaction data
  // problem. Still routed through dossie_asks (per spec) so it's visible
  // where financial alerts already live, but this should be treated as a
  // code regression to fix, not something the agent can resolve themselves.
  const label = dealLabel(tx.property_address);
  const body =
    `Dossie's net sheet math for ${label} doesn't reconcile internally — the itemized breakdown sums to ` +
    `${money(rec.summedNet)} but the reported net proceeds is ${money(netProceeds)} (off by ${money(rec.diff)}). ` +
    `This points to a bug in the net sheet calculation itself, not your data — don't trust the net sheet number ` +
    `for this deal until it's fixed.`;

  await raiseAsk({
    userId: tx.user_id,
    transactionId: tx.id,
    source: SOURCE_NET_SHEET,
    urgency: 'critical',
    title: 'Net sheet math does not reconcile',
    body,
    dryRun,
    results,
    extra: { summed_net: rec.summedNet, reported_net_proceeds: netProceeds, diff: rec.diff },
  });
}

module.exports = withTelemetry('cron-financial-sanity', async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const dryRun = String(req.query?.dryRun || '') === '1';
  const forceTxId = req.query?.forceTxId ? String(req.query.forceTxId) : null;

  let demoUserIds;
  try {
    demoUserIds = await loadDemoUserIds();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'profiles_load_failed', detail: String(err && err.message) });
  }

  let query =
    `/rest/v1/transactions?select=id,user_id,property_address,sale_price,appraisal_value,commission_rate,option_fee,stage,status` +
    `&or=(status.is.null,status.neq.closed)`;
  if (forceTxId) {
    query = `/rest/v1/transactions?select=id,user_id,property_address,sale_price,appraisal_value,commission_rate,option_fee,stage,status&id=eq.${encodeURIComponent(forceTxId)}`;
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
    checked++;

    await checkAppraisalGap(tx, { dryRun, results });
    await checkCommissionMath(tx, { dryRun, results });
    await checkNetSheetReconciliation(tx, { dryRun, results });
  }

  const created = results.filter((r) => r.created === true).length;

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    transactions_checked: checked,
    created,
    results,
  });
});
