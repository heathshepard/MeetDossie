'use strict';

// api/_lib/deal-watch-policy.js
// =============================================================================
// WHETHER THE WATCHER IS ALLOWED TO SPEAK
//
// The single thing that can kill this feature is alert fatigue. A watcher that
// speaks every morning is trained out inside a week, and after that it is
// WORSE than nothing, because it looks like coverage while being ignored.
//
// This repo has already paid for that lesson once. The daily regression suite
// alerted on RED unconditionally while being RED for two straight months with
// an identical failure set. The fix (api/_lib/regression-alert-policy.js) was
// delta-based — speak when the failure SET CHANGES, plus a low-frequency
// still-failing reminder — and replaying real data produced 2 alerts instead
// of 12. This module applies the same discipline to deals.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE, IN ONE PARAGRAPH
//
//   Speak about a fact once, when it becomes true, if missing it would cost
//   the member something. Never speak about a state. Never speak about a fact
//   that was already true when you first looked. Never speak twice about the
//   same fact at the same severity. If nothing qualifies, say nothing at all.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR GATES, IN ORDER
//
//   1. BASELINE. The first time the watcher ever sees a member, every fact
//      then true is recorded as 'baseline' and NOTHING is said. Measured
//      against live data on 2026-09-20, skipping this gate would have opened
//      with 26 deadline alerts in one message — 9 expired option periods and
//      17 past closings — on a dataset where 52 of 64 active deals had not
//      been touched in 30 days. A first impression of pure noise about things
//      the member already moved past. The watcher earns the right to talk by
//      first proving it can stay quiet.
//
//   2. IDEMPOTENCE. A fact already in the ledger is never spoken again. The
//      guarantee is a UNIQUE (user_id, fact_key) constraint in Postgres, not
//      an application code path that remembers to check. "Wesley still hasn't
//      sent it" every morning for six days is structurally impossible.
//
//      fact_key includes the consequence tier, which is what permits the ONE
//      re-speak that is actually the product: an item that was routine while
//      the option period was three weeks out becomes urgent when it is three
//      days out. Different tier, different key, still exactly once each. That
//      is the difference between "Wesley hasn't sent it" repeated into
//      wallpaper and "Wesley hasn't sent it and the option ends Monday" said
//      at the one moment it changes what the member does today.
//
//   3. CONSEQUENCE. Rank by what it costs to miss, never by recency or
//      volume. A missed option deadline costs a buyer their unrestricted
//      termination right and, on the Low Oak file, $5,200 of real money. A
//      missing listing photo costs an afternoon. Only 'critical' and 'high'
//      interrupt a day; 'normal' and 'low' are recorded silently and remain
//      available to any digest that wants them.
//
//   4. DORMANCY + CAP. A fact on a deal nobody has touched in a month is
//      archaeology, not news. And no member hears more than MAX_SPOKEN_PER_RUN
//      facts in one run — if more qualify, the most consequential win and the
//      rest stay in the ledger. An eleven-item wall of text is not a briefing,
//      it is something to scroll past.
//
// ─────────────────────────────────────────────────────────────────────────────
// TESTABILITY
//   Pure. No fetch, no Supabase, no ambient clock. Every input is explicit so
//   the whole decision table can be exercised directly by
//   deal-watch-policy.test.js under `node --test`. Reasoning about an alert
//   path instead of running it is how the regression suite stayed broken for
//   two months, and this module is the alert path.
// =============================================================================

const { CONSEQUENCE_ORDER, DORMANT_DAYS } = require('./deal-watch-observe.js');

// Tiers that are worth interrupting a member's morning for. Everything below
// is still recorded — it just does not buzz a phone.
const SPEAKING_TIERS = new Set(['critical', 'high']);

// Hard ceiling on how much the watcher may say in one run, per member. Chosen
// small on purpose: three things a member will actually read beats eleven they
// will scroll past. Overflow is not lost, it is in the ledger and will not be
// re-offered later as news (its fact_key is already claimed).
const MAX_SPOKEN_PER_RUN = 3;

// ─────────────────────────────────────────────────────────────────────────────
// THE STILL-TRUE REMINDER — and why "say it once" alone is not enough.
//
// Replaying the real corpus (64 deals, 12 owners, 2026-09-20) surfaced a gap
// that the four gates above do not close on their own.
//
// 23 Nopalito is a live $1,295,000 listing with no counterparty emails on file
// at all, which is why the seller's reply about stale tax exemptions was never
// captured and why Dossie was silent — the case this whole feature exists for.
// The watcher observes that blind spot correctly. But because the condition
// was already true when the member was first seeded, the baseline gate records
// it, and the idempotence gate then guarantees it is NEVER spoken again.
//
// A standing, unresolved, expensive condition that can never be mentioned is
// the regression-suite failure wearing the opposite mask: instead of shouting
// the same thing every morning, it whispers it once into a ledger nobody
// reads. Both end with the member not knowing.
//
// api/_lib/regression-alert-policy.js already solved this shape — it stays
// quiet on an unchanged failure set but keeps ONE low-frequency "still broken"
// reminder so a permanently-red suite can never fade entirely into the
// background. The same rule applies here.
//
// A fact that is STILL TRUE, still at a speaking tier, and last surfaced more
// than REMINDER_DAYS ago may speak once more. The reminder mints its own
// fact_key carrying the period index, so UNIQUE (user_id, fact_key) still
// enforces exactly one utterance per period rather than a daily nag. At 14
// days that is at most twice a month for something genuinely worth fixing.
const REMINDER_DAYS = 14;

/**
 * The fact_key a reminder would occupy, or null if it is not yet due.
 *
 * Period-indexed rather than "days since last spoken" so the key is a pure
 * function of (fact, elapsed time) and cannot drift with cron jitter.
 */
function reminderKeyFor(factKey, firstSeenAt, nowMs, reminderDays = REMINDER_DAYS) {
  if (!firstSeenAt) return null;
  const elapsedDays = (nowMs - Date.parse(firstSeenAt)) / 86400000;
  if (!Number.isFinite(elapsedDays) || elapsedDays < reminderDays) return null;
  const period = Math.floor(elapsedDays / reminderDays);
  return `${factKey}:still-true:${period}`;
}

function tierIndex(t) {
  const i = CONSEQUENCE_ORDER.indexOf(t);
  return i === -1 ? CONSEQUENCE_ORDER.length : i;
}

/**
 * Decide the fate of ONE observation.
 *
 * Pure and total: every path returns an explicit outcome, and every outcome is
 * a legal value of deal_watch_log.outcome. There is deliberately no default
 * "speak" branch — a fact must earn its way past every gate.
 *
 * @param {object} args
 * @param {object} args.observation
 * @param {boolean} args.isBaselineRun   this member has never been seeded
 * @param {Set<string>} args.knownFactKeys  fact_keys already in the ledger for this member
 * @param {boolean} args.dormant         the deal has gone untouched past DORMANT_DAYS
 * @param {string|null} args.baselineAt  ISO; facts at or before this are pre-existing
 * @param {boolean} args.notifyEnabled   ops_flags.deal_watch_notify
 * @returns {{ outcome: string, speak: boolean, reason: string }}
 */
function decideFact(args) {
  const {
    observation: o,
    isBaselineRun = false,
    knownFactKeys = new Set(),
    // factKey -> ISO timestamp of when this fact first entered the ledger.
    // Drives the still-true reminder; an empty map simply disables it.
    factFirstSeen = new Map(),
    dormant = false,
    baselineAt = null,
    notifyEnabled = false,
    nowMs = Date.now(),
    reminderDays = REMINDER_DAYS,
  } = args || {};

  const no = (outcome, reason) => ({ outcome, speak: false, reason });

  // GATE 1a — seeding. Record everything, announce nothing.
  if (isBaselineRun) {
    return no('baseline', 'first run for this member — recorded, deliberately not announced');
  }

  // GATE 2 — say it once. (The database enforces this too; checking here
  // means we do not compose and rank a message only to have the insert bounce.)
  if (knownFactKeys.has(o.factKey)) {
    // ...unless it is STILL TRUE, still expensive, and has gone quiet long
    // enough that it risks disappearing entirely. See REMINDER_DAYS above.
    const firstSeenAt = factFirstSeen.get(o.factKey) || null;
    const rk = reminderKeyFor(o.factKey, firstSeenAt, nowMs, reminderDays);
    if (
      rk
      && SPEAKING_TIERS.has(o.consequence)
      && !knownFactKeys.has(rk)
      && (!dormant || o.exemptFromDormancy)
      && notifyEnabled
    ) {
      return {
        outcome: 'spoken',
        speak: true,
        isReminder: true,
        reminderKey: rk,
        reason: `still unresolved after ${reminderDays}+ days — one reminder, not a daily nag`,
      };
    }
    return no('skipped_below_threshold', 'already in the ledger — said once, never again');
  }

  // GATE 1b — a fact that predates the baseline is not news, it is backlog
  // the member had before the watcher existed.
  if (baselineAt && o.observedAt && Date.parse(o.observedAt) <= Date.parse(baselineAt)) {
    return no('baseline', 'predates this member\'s baseline — pre-existing, not new');
  }

  // GATE 4a — dormancy. Archaeology on an abandoned record.
  //
  // The exemption matters: for an observation whose whole subject is that
  // NOTHING can be filed to this deal, the deal looking quiet is the symptom,
  // not a reason to stay silent. See exemptFromDormancy in
  // deal-watch-observe.js — without this, 23 Nopalito is suppressed forever by
  // the very condition it is reporting.
  if (dormant && !o.exemptFromDormancy) {
    return no('skipped_dormant', `deal untouched for more than ${DORMANT_DAYS} days`);
  }

  // GATE 3 — consequence.
  if (!SPEAKING_TIERS.has(o.consequence)) {
    return no('skipped_below_threshold', `consequence '${o.consequence}' is recorded, not announced`);
  }

  // THE SWITCH. Everything above ran identically whether or not the flag is
  // on — the ledger is complete either way, which is what makes a dry run an
  // honest preview of live behaviour rather than a different code path.
  if (!notifyEnabled) {
    return no('skipped_disabled', 'ops_flags.deal_watch_notify is off — composed and ranked, not sent');
  }

  return { outcome: 'spoken', speak: true, reason: `${o.consequence} consequence, new since baseline` };
}

/**
 * Decide a whole member's run.
 *
 * Applies decideFact to every observation, then enforces the per-run speaking
 * cap across the survivors — most consequential first, then most recent.
 *
 * @returns {{ decisions: Array, spoken: Array, silent: boolean, summary: object }}
 */
function decideRun(args) {
  const {
    observations = [],
    isBaselineRun = false,
    knownFactKeys = new Set(),
    factFirstSeen = new Map(),
    dormantDealIds = new Set(),
    baselineAt = null,
    notifyEnabled = false,
    maxSpoken = MAX_SPOKEN_PER_RUN,
    nowMs = Date.now(),
    reminderDays = REMINDER_DAYS,
  } = args || {};

  const decisions = observations.map((o) => {
    const d = decideFact({
      observation: o,
      isBaselineRun,
      knownFactKeys,
      factFirstSeen,
      dormant: dormantDealIds.has(o.dealId),
      baselineAt,
      notifyEnabled,
      nowMs,
      reminderDays,
    });
    return { observation: o, ...d };
  });

  // GATE 4b — the cap. Rank by consequence, then by how recently the
  // underlying event actually happened.
  const candidates = decisions
    .filter((d) => d.speak)
    .sort((a, b) => {
      const t = tierIndex(a.observation.consequence) - tierIndex(b.observation.consequence);
      if (t !== 0) return t;
      return Date.parse(b.observation.observedAt || 0) - Date.parse(a.observation.observedAt || 0);
    });

  const spoken = candidates.slice(0, maxSpoken);
  const capped = candidates.slice(maxSpoken);
  for (const c of capped) {
    c.speak = false;
    c.outcome = 'skipped_capped';
    c.reason = `over the ${maxSpoken}-per-run cap; higher-consequence facts went first`;
  }

  const summary = {
    observed: observations.length,
    spoken: spoken.length,
    baseline: decisions.filter((d) => d.outcome === 'baseline').length,
    dormant: decisions.filter((d) => d.outcome === 'skipped_dormant').length,
    below_threshold: decisions.filter((d) => d.outcome === 'skipped_below_threshold').length,
    disabled: decisions.filter((d) => d.outcome === 'skipped_disabled').length,
    capped: capped.length,
  };

  // Silence is a valid morning, and is the EXPECTED outcome on most of them.
  return { decisions, spoken, silent: spoken.length === 0, summary };
}

// ---------------------------------------------------------------------------
// Message composition
// ---------------------------------------------------------------------------

const TIER_MARK = { critical: '!!', high: '!', normal: '', low: '' };

/**
 * Turn spoken facts into something a working agent can act on in one read.
 *
 * Deliberately plain: what happened, on which property, and the clock that
 * makes it matter. No preamble, no "I hope this finds you well", no restating
 * that this is an automated message. A transaction coordinator saying this out
 * loud would use about this many words.
 */
function composeNotification(spokenDecisions, { memberName = null } = {}) {
  if (!spokenDecisions || spokenDecisions.length === 0) return null;

  const lines = [];
  lines.push(spokenDecisions.length === 1 ? 'One thing needs you:' : `${spokenDecisions.length} things need you:`);
  lines.push('');

  for (const d of spokenDecisions) {
    const o = d.observation;
    const mark = TIER_MARK[o.consequence] ? `${TIER_MARK[o.consequence]} ` : '';
    const still = d.isReminder ? 'Still open — ' : '';
    lines.push(`${mark}${still}${o.headline}`);
    if (o.deadlineText) lines.push(`   ...and ${o.deadlineText}.`);
    if (o.detail) lines.push(`   ${String(o.detail).slice(0, 300)}`);
    lines.push('');
  }

  // NOTIFY, DO NOT ACT. The watcher observes and tells. It does not email the
  // client, chase the other agent, or file anything on its own. Anything that
  // reaches a real person waits for the member. Saying so in the message keeps
  // that contract visible at the point of use rather than only in a comment.
  lines.push('I have not contacted anyone — tell me if you want a nudge drafted.');

  const body = lines.join('\n').trim();
  return memberName ? `${memberName} — ${body}` : body;
}

module.exports = {
  SPEAKING_TIERS,
  MAX_SPOKEN_PER_RUN,
  REMINDER_DAYS,
  reminderKeyFor,
  decideFact,
  decideRun,
  composeNotification,
  _internal: { tierIndex },
};
