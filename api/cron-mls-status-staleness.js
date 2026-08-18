'use strict';

// api/cron-mls-status-staleness.js
// =============================================================================
// Detects one specific, high-confidence staleness condition: a dossier's own
// option period has ended, per its own tracked facts, within roughly the last
// two weeks — and nothing in Dossie shows the agent confirmed the MLS status
// was updated to reflect it.
//
// VERIFIED AGAINST REAL DATA BEFORE BUILDING THIS: the original hypothesis —
// "flag when the dossier's own `stage` still reads pre-option-expiration" —
// does NOT hold. Checked the real 104 Wild Cherry row
// (42a11919-ba8b-44fa-9b04-ed13563ab888): its Dossie `stage` had already
// correctly advanced to 'financing' by the time the MLS listing was still
// sitting on Active Option. Dossie's own stage tracking and the agent's
// separate act of logging into MLS and flipping the public status are two
// different systems that can (and did) drift apart independently — Dossie has
// no visibility into the live MLS record at all, so `stage` can't be used to
// confirm or deny anything about it. The only real signal Dossie has is the
// CALENDAR FACT that the option period ended. So this is a pure date check,
// not a stage comparison — it fires once shortly after every option period
// ends, regardless of what stage the dossier has since moved to.
//
// Also verified: `option_expiration_date` is populated on only a handful of
// live transactions. Most store `contract_effective_date` + `option_days`
// instead and leave `option_expiration_date` null. Both are read; the
// explicit date wins when present, otherwise it's derived.
//
// Bounded window (see GRACE_DAYS / MAX_STALE_DAYS below): the live table has
// transactions whose option period "ended" years ago (old contract dates on
// still-`active` records). Without an upper bound, the first run would dredge
// up every one of those as a false "critical" alert. This only flags option
// periods that ended recently — the exact window where the nudge is still
// useful — and goes quiet on anything older.
//
// THIS IS DETECTION + ALERT ONLY. Dossie has no MLS credentials and never
// writes to MLS — same principle as the e-sign "verify the document, never
// the status" rule. The output is a dossie_asks row (urgency: critical,
// source: 'system:mls-status-stale') that nudges the agent to go make the
// change themselves. See api/dossie-asks.js + src/components/DossieAsks.jsx
// (Dossie repo) for the surface this feeds — it renders as a pinned,
// full-bleed alert card above the normal capped feed, not a generic entry.
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

// Past this many days, assume the moment has passed (either it was handled
// quietly, or flagging something this old is no longer useful) — do not open
// new asks for option periods that ended long ago. Keeps the first run (and
// every run against real historical data) from dredging up years-old
// transactions as fresh "critical" alerts.
const MAX_STALE_DAYS = 14;

// If a prior ask on this exact condition was resolved or dismissed and the
// underlying mismatch is STILL true (still inside the window above), re-raise
// after this many days rather than assuming a dismissal means it was actually
// fixed in MLS.
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

function addDaysYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
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

// Placeholder / garbage dates seen in live data (unset fields defaulted to
// year 1 instead of null) — never treat these as a real contract date.
function isRealYMD(ymd) {
  if (!ymd || typeof ymd !== 'string') return false;
  const year = Number(ymd.slice(0, 4));
  return Number.isFinite(year) && year > 1900;
}

// The one calendar fact this whole check runs on: when did the option period
// actually end, per THIS dossier's own record. Explicit field wins; otherwise
// derive from contract_effective_date + option_days. Returns null when there
// is not enough real data to compute it (no option period tracked, or dates
// are placeholder/missing) — those transactions are silently skipped, not
// guessed at.
function computeOptionEndYMD(tx) {
  if (tx.option_expiration_date) {
    const explicit = String(tx.option_expiration_date).slice(0, 10);
    if (isRealYMD(explicit)) return explicit;
  }
  const days = Number(tx.option_days);
  const effective = tx.contract_effective_date ? String(tx.contract_effective_date).slice(0, 10) : null;
  if (Number.isFinite(days) && days > 0 && isRealYMD(effective)) {
    return addDaysYMD(effective, days);
  }
  return null;
}

// NOTE: this deliberately does NOT reuse the "active paying subscription"
// customer filter from the outbound-email crons (cron-deadline-reminders.js
// etc). Those intentionally skip Heath's own login because they send
// customer-facing emails he shouldn't receive about himself. This is an
// in-app surface, not an email — and Heath's own 104 Wild Cherry dossier
// (subscriptions.status='pending_onboarding', not 'active') is the exact
// case that motivated this feature. Verified: gating on an active
// subscription would have silently excluded the one real incident this cron
// exists to catch. So the only exclusion here is demo accounts, to keep test
// data out of a real user's alert feed.
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

async function createAsk({ userId, transactionId, address, endYMD, staleDays }) {
  const label = dealLabel(address);
  const niceDate = friendlyDate(endYMD);
  const payload = {
    user_id: userId,
    transaction_id: transactionId,
    urgency: 'critical',
    title: 'Your MLS status may be behind',
    body:
      `The option period on ${label} ended ${niceDate} (${staleDays} day${staleDays === 1 ? '' : 's'} ago). ` +
      `Dossie can't see your actual MLS listing, so this is a nudge, not a confirmation either way — but if ` +
      `the status still reads Active Option, that's stale for anyone browsing it and a real flag if your ` +
      `broker or TREC ever reviews the file. Want to jump into MLS and update the status now?`,
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

  let demoUserIds;
  try {
    demoUserIds = await loadDemoUserIds();
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'profiles_load_failed', detail: String(err && err.message) });
  }

  // Candidates: every open dossier that tracks an option period at all
  // (option_days > 0). Staleness itself is computed in JS since the true
  // option-end date is frequently derived, not stored. forceTxId bypasses the
  // customer filter so a specific transaction can be smoke-tested without
  // touching real subscription state.
  let query =
    `/rest/v1/transactions?select=id,user_id,property_address,option_expiration_date,contract_effective_date,option_days,stage,status` +
    `&option_days=gt.0` +
    `&or=(status.is.null,status.neq.closed)`;
  if (forceTxId) {
    query = `/rest/v1/transactions?select=id,user_id,property_address,option_expiration_date,contract_effective_date,option_days,stage,status&id=eq.${encodeURIComponent(forceTxId)}`;
  }

  const txRes = await supabaseFetch(query);
  if (!txRes.ok) {
    return res.status(500).json({ ok: false, error: 'transactions_read_failed', status: txRes.status });
  }

  const results = [];
  let flagged = 0;
  let created = 0;

  for (const tx of (txRes.data || [])) {
    if (!forceTxId && demoUserIds.has(tx.user_id)) continue;
    if (tx.stage === 'closed' || tx.stage === 'terminated') continue;

    const endYMD = computeOptionEndYMD(tx);
    if (!endYMD) continue; // no usable option-period data on this dossier

    const staleDays = daysBetweenYMD(endYMD, today);
    if (staleDays < GRACE_DAYS || staleDays > MAX_STALE_DAYS) continue;

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
      results.push({ transaction_id: tx.id, would_create: true, stale_days: staleDays, property_address: tx.property_address, option_end: endYMD });
      continue;
    }

    const ok = await createAsk({
      userId: tx.user_id,
      transactionId: tx.id,
      address: tx.property_address,
      endYMD,
      staleDays,
    });
    if (ok) created++;
    results.push({ transaction_id: tx.id, created: ok, stale_days: staleDays, property_address: tx.property_address, option_end: endYMD });
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
