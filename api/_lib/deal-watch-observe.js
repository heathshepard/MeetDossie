'use strict';

// api/_lib/deal-watch-observe.js
// =============================================================================
// WHAT THE WATCHER CAN SEE — pure observation extraction, no I/O.
//
// Given one deal row (plus the signature requests attached to it) and today's
// date, produce the list of FACTS that are true about that deal right now.
// Deciding which of those facts are worth interrupting a member's morning for
// is a separate concern and lives in deal-watch-policy.js.
//
// Everything here is pure on purpose. An observation engine that needs a
// database to test is an observation engine nobody tests, and "we reasoned
// about the alert path instead of exercising it" is exactly how the daily
// regression suite stayed broken for two months.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHERE THE DATA COMES FROM, AND WHY THE WATCHER ADDS NO MAILBOX LOAD
//
// The obvious way to notice "a party replied" is to go read the member's
// inbox. This module deliberately does NOT do that, for two reasons:
//
//   1. It is already done. api/cron-email-to-dossier.js runs every 15 minutes,
//      per entitled+connected member, matches inbound mail against the deal's
//      counterparties, summarizes it with Haiku, and appends an entry to
//      transactions.notes_log with a stable id (`email-<messageId>`) and a
//      `read: false` marker. The signal is already captured and persisted.
//      What has been missing is anything that then TELLS THE MEMBER.
//
//   2. Inbox reads in this codebase are bounded BY DESIGN — api/_lib/
//      inbox-tools.js clamps to 1-90 days and 1-20 results, refuses a search
//      with neither `query` nor `from`, and carries no identity parameter in
//      any tool schema (identity arrives as a separate session argument that
//      the member cannot influence). Those bounds exist to keep the blast
//      radius of a prompt-injected tool call small. Widening them so a watcher
//      could sweep mailboxes more conveniently would trade a real security
//      property for developer convenience. So: the watcher reads what has
//      already been filed, and adds ZERO new mailbox access.
//
// The happy consequence is that tenancy is inherited rather than re-derived.
// notes_log lives on the transactions row, which is already scoped by user_id.
// There is no join here that could leak one member's correspondence into
// another member's notification.
// =============================================================================

// Consequence tiers, most severe first. See rankConsequence() for how a fact
// is assigned one — the ordering is what the per-run speaking cap sorts by.
const CONSEQUENCE_ORDER = ['critical', 'high', 'normal', 'low'];

// A deadline inside this many days makes an outstanding obligation urgent.
// 5 days is chosen so a Monday deadline is urgent from the preceding Wednesday
// — enough runway to actually chase somebody before a weekend eats two of the
// remaining days. (Friday-execution compression is a real and expensive
// failure mode in this business, not a hypothetical.)
const URGENT_DEADLINE_DAYS = 5;

// A deadline inside this many days makes an outstanding obligation worth
// mentioning at all, even when nothing is overdue yet.
const NEAR_DEADLINE_DAYS = 14;

// A deal nobody has touched in this long is treated as dormant: facts about it
// are recorded but not announced. Measured against live data on 2026-09-20,
// 52 of 64 active deals had not been updated in 30 days, and 8 had closing
// dates more than a month past. Those are abandoned records, not emergencies,
// and announcing them is precisely the wall of noise that trains a member to
// ignore the watcher forever.
const DORMANT_DAYS = 30;

// A filed party reply older than this is history, not news. It still gets a
// ledger row so it can never be announced later as though it just happened.
const REPLY_FRESH_DAYS = 14;

// Stages at which a deal is genuinely live and worth watching. Note that
// `status` in this schema only ever holds 'active' or 'closed' — `stage` is
// the real lifecycle column, so the stage list is what actually gates work.
const LIVE_STAGES = new Set([
  'pre-contract', 'active-listing', 'under-contract', 'option-period',
  'inspection', 'title-survey', 'financing', 'appraisal', 'clear-to-close',
]);

// Stages where a listing is publicly on market and a seller's disclosure
// should already exist. Texas practice: the SDN goes out with the listing, not
// at contract. A live listing without one is a real compliance gap.
const LISTING_LIVE_STAGES = new Set(['active-listing']);

// ---------------------------------------------------------------------------
// Small date helpers. All comparisons are day-granular on 'YYYY-MM-DD' so the
// result never depends on what timezone the serverless function woke up in.
// ---------------------------------------------------------------------------

function toYMD(value) {
  if (!value) return null;
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function daysBetweenYMD(fromYmd, toYmdStr) {
  if (!fromYmd || !toYmdStr) return null;
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmdStr}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

function daysSinceIso(iso, nowMs) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / 86400000);
}

// A short, stable, filesystem-safe token from arbitrary text (an email
// address, a party name). Used inside fact_key so the key stays readable and
// bounded regardless of what the underlying string contains.
function slug(value, max = 24) {
  return String(value || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'unknown';
}

// ---------------------------------------------------------------------------
// Deadline context — the thing that turns an obligation into an emergency.
// ---------------------------------------------------------------------------

// The date fields that can make an outstanding item urgent, in the order we
// prefer to cite them. Option expiration first: missing it costs a buyer their
// unrestricted right to terminate, which is the single most expensive clock in
// a Texas residential contract.
const DEADLINE_FIELDS = [
  { col: 'option_expiration_date', label: 'the option period ends' },
  { col: 'closing_date', label: 'closing is' },
  { col: 'loan_approval_deadline', label: 'loan approval is due' },
  { col: 'appraisal_deadline', label: 'the appraisal deadline is' },
  { col: 'survey_deadline', label: 'the survey deadline is' },
  { col: 'hoa_document_deadline', label: 'HOA documents are due' },
];

/**
 * The nearest FUTURE deadline on a deal, or null.
 *
 * Deliberately ignores past deadlines. A deadline that has already gone by is
 * cron-deadline-reminders.js's business (it fires T-7/T-1/T-0 with its own
 * database-enforced dedup on (transaction_id, deadline_type, days_out)), and
 * re-announcing it here would be a second voice saying the same thing — the
 * fastest possible route to the member muting both.
 *
 * What this module contributes that the deadline cron cannot is the JOIN:
 * an unmet obligation, held against the clock it threatens.
 */
function nearestDeadline(deal, todayYmd) {
  let best = null;
  for (const f of DEADLINE_FIELDS) {
    const ymd = toYMD(deal[f.col]);
    if (!ymd) continue;
    const days = daysBetweenYMD(todayYmd, ymd);
    if (days === null || days < 0) continue; // past deadlines: not ours
    if (!best || days < best.days) best = { label: f.label, date: ymd, days, col: f.col };
  }
  return best;
}

function describeDeadline(d) {
  if (!d) return null;
  if (d.days === 0) return `${d.label} today`;
  if (d.days === 1) return `${d.label} tomorrow`;
  return `${d.label} in ${d.days} days`;
}

// ---------------------------------------------------------------------------
// Consequence ranking
// ---------------------------------------------------------------------------

/**
 * Rank by what it COSTS to miss, never by how recent or how loud it is.
 *
 * A missed option deadline costs a buyer their termination right and, in the
 * Low Oak case, $5,200 of real money. A missing listing photo costs nothing
 * that cannot be fixed on any later afternoon. Those must never occupy the
 * same tier, and recency must never promote one over the other.
 */
function rankConsequence(base, deadline) {
  if (!deadline) return base;
  // An obligation that is already outstanding, against a clock about to run
  // out, is the case this whole feature exists for.
  if (deadline.days <= URGENT_DEADLINE_DAYS) {
    if (base === 'high' || base === 'critical') return 'critical';
    if (base === 'normal') return 'high';
  } else if (deadline.days <= NEAR_DEADLINE_DAYS) {
    if (base === 'high') return 'high';
    if (base === 'normal') return 'normal';
  }
  return base;
}

// ---------------------------------------------------------------------------
// Observation builders
// ---------------------------------------------------------------------------

function makeObservation(deal, fields) {
  const o = {
    userId: deal.user_id,
    dealId: deal.id,
    address: deal.property_address || '(no address on file)',
    stage: deal.stage || null,
    salePrice: deal.sale_price != null ? Number(deal.sale_price) : null,
    ...fields,
  };
  // fact_key carries the consequence tier on purpose. See the migration
  // header: it is what allows exactly one re-speak when a routine item
  // escalates into an urgent one, while still guaranteeing each (fact, tier)
  // pair is announced at most once.
  o.factKey = `${o.kind}:${deal.id}:${o.subjectKey}:${o.consequence}`;
  return o;
}

/**
 * 1. A REPLY FROM A PARTY ON A LIVE FILE.
 *
 * Source: transactions.notes_log entries written by cron-email-to-dossier.js,
 * shape `{ id: 'email-<msgId>', source: 'email', fromName, fromEmail, subject,
 * text (a Haiku summary), createdAt, read }`.
 *
 * NOTE ON `read`: it is NOT used as the trigger. It records whether anyone
 * opened the entry inside the Dossie web app, and most members never open the
 * app at all — on live data every filed reply but one sits at read:false,
 * including entries a month old. Keying off it would mean announcing a
 * standing backlog as though it were news, every single morning. Freshness
 * plus the baseline cutoff is the honest signal; `read` is carried through
 * only as extra colour on an already-eligible fact.
 */
function observeReplies(deal, nowMs) {
  const out = [];
  const log = Array.isArray(deal.notes_log) ? deal.notes_log : [];
  for (const e of log) {
    if (!e || e.source !== 'email') continue;
    const age = daysSinceIso(e.createdAt, nowMs);
    if (age === null) continue;

    const who = e.fromName || e.fromEmail || 'Someone';
    const isFresh = age <= REPLY_FRESH_DAYS;

    out.push(makeObservation(deal, {
      kind: 'party_reply',
      // Identity is the message, not the tier-invariant deal — one row per
      // actual email, so a second reply on the same thread is its own fact.
      subjectKey: slug(e.gmailMessageId || e.id || e.subject, 32),
      consequence: isFresh ? 'high' : 'low',
      observedAt: e.createdAt || null,
      headline: `${who} replied on ${deal.property_address || 'a deal'}`,
      detail: e.text ? String(e.text).slice(0, 400) : (e.subject || ''),
      subject: e.subject || null,
      fromEmail: e.fromEmail || null,
      unreadInApp: e.read === false,
    }));
  }
  return out;
}

/**
 * 2. SOMEONE OWES SOMETHING AND HASN'T DELIVERED IT.
 *
 * The recurring, tedious, genuinely valuable case: a signature packet went out
 * and has not come back, and a clock is running. This is the work a member
 * does by hand — chasing the other agent, the title officer, the lender — and
 * it is the most mechanical part of the job.
 *
 * Source: signature_requests rows in a non-terminal status. `pending` and
 * `sent` mean it is out there unsigned; `completed`/`declined`/`expired` are
 * done with.
 */
const OPEN_SIGNATURE_STATUSES = new Set(['pending', 'sent', 'awaiting', 'opened', 'partially_completed']);

function observeAwaitingDelivery(deal, signatureRequests, todayYmd, nowMs) {
  const out = [];
  const deadline = nearestDeadline(deal, todayYmd);

  for (const sr of signatureRequests || []) {
    if (!sr || !OPEN_SIGNATURE_STATUSES.has(String(sr.status || '').toLowerCase())) continue;
    const waiting = daysSinceIso(sr.created_at, nowMs);
    if (waiting === null || waiting < 2) continue; // give people a business day

    // Who we are actually waiting on, for language the member can act on.
    const signers = Array.isArray(sr.signers) ? sr.signers : [];
    const outstanding = signers
      .filter((s) => s && !s.completed_at && !s.signed_at)
      .map((s) => s.name || s.email)
      .filter(Boolean);
    const who = outstanding.length
      ? outstanding.slice(0, 2).join(' and ')
      : (sr.seller_agent_name || 'the other side');

    const base = waiting >= 5 ? 'high' : 'normal';
    const consequence = rankConsequence(base, deadline);

    out.push(makeObservation(deal, {
      kind: 'awaiting_delivery',
      subjectKey: slug(sr.id || sr.docuseal_submission_id, 32),
      consequence,
      observedAt: sr.created_at || null,
      headline: `${who} hasn't returned the signature packet on ${deal.property_address || 'a deal'}`,
      detail: `Sent ${waiting} days ago, still ${sr.status}.`,
      waitingDays: waiting,
      deadline: deadline || null,
      deadlineText: describeDeadline(deadline),
    }));
  }
  return out;
}

/**
 * 3. A DOCUMENT ARRIVED — a signed contract, an executed amendment.
 *
 * Completion is good news, but good news that closes a loop the member has
 * been holding open is worth one line. Ranked below anything at risk: a thing
 * that went right never outranks a thing about to go wrong.
 */
function observeDocumentArrived(deal, signatureRequests, nowMs) {
  const out = [];
  for (const sr of signatureRequests || []) {
    if (!sr || String(sr.status || '').toLowerCase() !== 'completed') continue;
    if (!sr.completed_at) continue;
    const age = daysSinceIso(sr.completed_at, nowMs);
    if (age === null || age > REPLY_FRESH_DAYS) continue;

    out.push(makeObservation(deal, {
      kind: 'document_arrived',
      subjectKey: slug(sr.id || sr.docuseal_submission_id, 32),
      consequence: 'normal',
      observedAt: sr.completed_at,
      headline: `Fully executed packet came back on ${deal.property_address || 'a deal'}`,
      detail: 'All signers completed.',
    }));
  }
  return out;
}

/**
 * 4. THE FILE IS MISSING SOMETHING IT SHOULD HAVE.
 *
 * Today: a live listing with no seller's disclosure on file. In Texas the SDN
 * goes out with the listing, so a publicly-marketed listing without one is a
 * standing compliance gap rather than a nice-to-have.
 */
function observeMissingRequired(deal, todayYmd) {
  const out = [];
  const stage = String(deal.stage || '');

  if (LISTING_LIVE_STAGES.has(stage)) {
    const hasSdn = Boolean(deal.sellers_disclosure_received_at) || deal.sdn_received === true;
    if (!hasSdn) {
      const deadline = nearestDeadline(deal, todayYmd);
      out.push(makeObservation(deal, {
        kind: 'missing_required',
        subjectKey: 'sellers-disclosure',
        consequence: rankConsequence('normal', deadline),
        // A missing thing has no event date of its own. The deal's own last
        // update is the closest honest timestamp, and it keeps the baseline
        // comparison meaningful.
        observedAt: deal.updated_at || null,
        headline: `${deal.property_address || 'A listing'} is on market with no seller's disclosure on file`,
        detail: "Texas practice is that the SDN goes out with the listing. Nothing in the dossier shows one received.",
        deadline: deadline || null,
        deadlineText: describeDeadline(deadline),
      }));
    }
  }
  return out;
}

/**
 * 5. THE DEAL IS UNWATCHABLE.
 *
 * This is the 23 Nopalito observation, and it is the most valuable single
 * thing in this module.
 *
 * cron-email-to-dossier.js files an inbound email onto a deal only on an EXACT
 * From-address match against a counterparty stored on that deal. 23 Nopalito —
 * a live $1,295,000 listing — has parties = {} and every counterparty email
 * column NULL. So when the seller replied answering the biggest open question
 * on the file, there was no address to match, nothing was filed, and there was
 * never anything for any watcher to find.
 *
 * A watcher that only reports what it can see would have been silent on that
 * deal forever while looking like coverage. Reporting the blind spot itself is
 * the difference between a tool that works on tidy data and an assistant that
 * tells you when it cannot help you.
 */
function observeMissingContacts(deal) {
  const emailCols = [
    'seller_email', 'seller2_email', 'buyer_email', 'buyer2_email',
    'other_agent_email_addr', 'listing_agent_email_addr',
    'title_officer_email', 'loan_officer_email',
  ];
  const anyFlat = emailCols.some((c) => deal[c] && String(deal[c]).trim());
  const parties = deal.parties && typeof deal.parties === 'object' ? deal.parties : {};
  const anyParty = ['buyer', 'seller', 'buyerAgent', 'listingAgent', 'title', 'lender']
    .some((k) => parties[k] && parties[k].email);

  if (anyFlat || anyParty) return [];

  return [makeObservation(deal, {
    kind: 'missing_contacts',
    subjectKey: 'no-contacts',
    // PER-DEAL, THIS IS DELIBERATELY BELOW THE SPEAKING THRESHOLD.
    //
    // A 45-day replay over the real corpus with this set to 'high' produced a
    // 9-message burst on a single morning — one "I can't watch X" per
    // contactless deal, which is the exact flood the whole design exists to
    // prevent, arriving through the reminder door instead of the front one.
    //
    // The mistake was treating a CONFIGURATION problem as an EVENT. A deal
    // missing its contacts is not something that happened this morning; it is
    // a standing setup gap, and nine of them are one problem, not nine. So the
    // per-deal row is recorded for the ledger (it is genuinely useful to know
    // WHICH deals) and the member hears a single roll-up instead — see
    // rollUpMissingContacts() below.
    consequence: 'low',
    // EXEMPT FROM THE DORMANCY GATE, and this is not an exception so much as a
    // correction of circular reasoning.
    //
    // The dormancy gate exists to suppress archaeology — a closing date that
    // went by six weeks ago on a record nobody has touched. It keys off
    // updated_at, which is a proxy for "somebody is still working this file".
    //
    // That proxy INVERTS for this particular observation. A deal with no
    // counterparty addresses is one that nothing can ever be filed to, so its
    // updated_at cannot refresh no matter how live the deal is in reality.
    // 23 Nopalito — an active $1,295,000 listing — reads as 42 days dormant
    // for exactly the reason this observation is reporting. Suppressing the
    // message because the deal looks quiet would suppress it BECAUSE of the
    // condition it is trying to report, and the one file that most needed the
    // warning would be the one file guaranteed never to get it.
    //
    // Caught by replaying 45 days over the real corpus, where Nopalito never
    // surfaced once.
    exemptFromDormancy: true,
    observedAt: deal.updated_at || null,
    headline: `I can't watch ${deal.property_address || 'a deal'} — no contact emails on file`,
    detail: "Nothing gets filed to this dossier because inbound mail is matched by the other party's email address, and this deal has none. Add the seller, buyer, other agent or title officer and I can start watching it.",
  })];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Every fact currently true about one deal.
 *
 * @param {object} args
 * @param {object} args.deal               a transactions row (must carry user_id + id)
 * @param {Array}  [args.signatureRequests] signature_requests rows for THIS deal only
 * @param {string} args.todayYmd           'YYYY-MM-DD' in the member's local sense
 * @param {number} args.nowMs              Date.now(), passed in so tests are deterministic
 * @returns {{ observations: Array, dormant: boolean, dormantDays: number|null, live: boolean }}
 */
function observeDeal({ deal, signatureRequests = [], todayYmd, nowMs }) {
  if (!deal || !deal.id || !deal.user_id) {
    return { observations: [], dormant: false, dormantDays: null, live: false };
  }

  const live = String(deal.status || '').toLowerCase() !== 'closed'
    && LIVE_STAGES.has(String(deal.stage || ''));

  const dormantDays = daysSinceIso(deal.updated_at, nowMs);
  const dormant = dormantDays !== null && dormantDays > DORMANT_DAYS;

  if (!live) return { observations: [], dormant, dormantDays, live };

  const observations = [
    ...observeReplies(deal, nowMs),
    ...observeAwaitingDelivery(deal, signatureRequests, todayYmd, nowMs),
    ...observeDocumentArrived(deal, signatureRequests, nowMs),
    ...observeMissingRequired(deal, todayYmd),
    ...observeMissingContacts(deal),
  ];

  return { observations, dormant, dormantDays, live };
}

/**
 * Collapse every "this deal has no contacts" row into ONE fact for the member.
 *
 * Nine blind deals are one problem, not nine notifications. The roll-up names
 * the count and the single most consequential example, which is what makes it
 * actionable — "6 deals, starting with the $1,295,000 listing" tells a member
 * where to spend the next ten minutes, where six separate pings tell them to
 * mute the watcher.
 *
 * Ordering picks the example by stage: a live listing or a deal under contract
 * outranks a pre-contract lead, because the cost of being blind to it is real
 * money rather than a stale record.
 *
 * The fact_key is member-scoped and carries the COUNT, so the roll-up speaks
 * again if the situation materially changes (a seventh deal goes blind, or the
 * member fixes three) but stays silent while it is merely unchanged.
 */
const STAKE_ORDER = [
  'clear-to-close', 'financing', 'appraisal', 'title-survey', 'inspection',
  'option-period', 'under-contract', 'active-listing', 'pre-contract',
];

function describeStake(o) {
  const bits = [];
  if (o.stage) bits.push(o.stage);
  if (Number(o.salePrice) > 0) bits.push(`$${Number(o.salePrice).toLocaleString('en-US')}`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

function rollUpMissingContacts(observations) {
  const blind = observations.filter((o) => o.kind === 'missing_contacts');
  if (blind.length === 0) return observations;

  const kept = observations.filter((o) => o.kind !== 'missing_contacts');

  const ranked = [...blind].sort((a, b) => {
    const ai = STAKE_ORDER.indexOf(a.stage);
    const bi = STAKE_ORDER.indexOf(b.stage);
    const byStage = (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    if (byStage !== 0) return byStage;
    // Same stage: the bigger file first. Being blind to a $1,295,000 listing
    // costs more than being blind to a $300,000 one, and "the one I'd fix
    // first" is only useful advice if it is actually the one worth fixing
    // first. Caught in replay, where 23 Nopalito ($1.295M) lost the exemplar
    // slot to a smaller listing purely on tie-break order.
    return (Number(b.salePrice) || 0) - (Number(a.salePrice) || 0);
  });
  const example = ranked[0];
  const n = blind.length;

  const rollup = {
    userId: example.userId,
    dealId: example.dealId,          // the exemplar, for the ledger's FK
    address: example.address,
    stage: example.stage,
    kind: 'missing_contacts',
    subjectKey: `rollup-${n}`,
    consequence: 'high',
    exemptFromDormancy: true,        // see the note on the per-deal observation
    observedAt: example.observedAt,
    headline: n === 1
      ? `I can't watch ${example.address} — no contact emails on file`
      : `${n} of your deals have no contact emails on file, so I can't watch them`,
    detail: n === 1
      ? "Nothing gets filed to this dossier because inbound mail is matched by the other party's email address. Add the seller, buyer, other agent or title officer and I can start watching it."
      : `Inbound mail is matched to a deal by the other party's email address, so these are invisible to me. The one I'd fix first is ${example.address}${describeStake(example)}.`,
  };
  rollup.factKey = `missing_contacts:member:${example.userId}:${rollup.subjectKey}:high`;

  // Per-deal rows stay in the stream at 'low' so the ledger still records
  // exactly WHICH deals are blind — recorded, never announced individually.
  return [...kept, ...blind, rollup];
}

module.exports = {
  CONSEQUENCE_ORDER,
  rollUpMissingContacts,
  STAKE_ORDER,
  URGENT_DEADLINE_DAYS,
  NEAR_DEADLINE_DAYS,
  DORMANT_DAYS,
  REPLY_FRESH_DAYS,
  LIVE_STAGES,
  observeDeal,
  nearestDeadline,
  describeDeadline,
  rankConsequence,
  _internal: { toYMD, daysBetweenYMD, daysSinceIso, slug, observeReplies, observeAwaitingDelivery, observeMissingContacts, observeMissingRequired, observeDocumentArrived },
};
