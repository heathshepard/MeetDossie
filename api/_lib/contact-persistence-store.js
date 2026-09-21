'use strict';

// api/_lib/contact-persistence-store.js
//
// The I/O half of contact persistence. api/_lib/contact-persistence.js decides
// WHAT to write (and is pure, so it can be tested against a real contract
// without a database); this module is the only thing that touches a row.
//
// ---------------------------------------------------------------------------
// MULTI-TENANCY IS THE WHOLE POINT OF THIS FILE
// ---------------------------------------------------------------------------
// Contact details are client PII. `transactions` is multi-tenant
// (memory:transactions-table-is-multi-tenant — a missing user_id filter here
// once published another customer's client data), and these helpers run under
// the service role, which bypasses RLS entirely.
//
// So: every read AND every write in this file carries `user_id=eq.<session
// user>`. The transaction id is never trusted on its own — a caller that
// passes someone else's transaction id gets zero rows back on the read and
// zero rows patched on the write, rather than someone else's contacts.
//
// The write is deliberately expressed as `id=eq.X&user_id=eq.Y` rather than
// `id=eq.X` after an ownership check, because the check-then-write form has a
// window; the combined filter does not.

const {
  planContactWrites,
  COLUMN_MAP,
  PARTY_KEYS,
} = require('./contact-persistence');

// Every column the planner may read (to honour "a human value always wins")
// or write, plus the three it needs to decide routing.
const CONTACT_COLUMNS = (() => {
  const cols = new Set(['id', 'user_id', 'role', 'transaction_type', 'parties', 'contact_provenance', 'property_address']);
  for (const party of PARTY_KEYS) {
    for (const col of Object.values(COLUMN_MAP[party] || {})) cols.add(col);
  }
  return [...cols];
})();

const CONTACT_SELECT = CONTACT_COLUMNS.join(',');

/**
 * Load one transaction for contact planning, scoped to its owner.
 * Returns null when the row does not exist OR is not this member's.
 */
async function loadTransactionForContacts(sb, { userId, transactionId }) {
  if (!userId || !transactionId) return null;
  const { ok, data } = await sb(
    `transactions?select=${CONTACT_SELECT}`
    + `&id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + '&limit=1',
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

/**
 * Plan and (unless `dryRun`) apply the contacts from one contract extraction.
 *
 * Always returns the plan, including on a dry run, so a caller can show the
 * member exactly what would change before anything does. That is what makes
 * the backfill reviewable rather than a silent mass update.
 *
 * Never throws for a routine miss (no such deal, nothing to write) — contact
 * persistence is a side effect of scanning a contract, and it must never be
 * the reason a scan the member asked for reports failure.
 *
 * @param {Function} sb        the Supabase REST helper: (path, init) => {ok,status,data}
 * @param {object}   opts
 * @param {string}   opts.userId         session user — the tenant boundary
 * @param {string}   opts.transactionId
 * @param {object}   opts.extracted      `extracted` from scan-contract.js
 * @param {object}   opts.source         { documentId, fileName, documentLabel, scanId }
 * @param {object}   opts.profile        optional { email } for the reversed-block guard
 * @param {boolean}  opts.dryRun         plan only, write nothing
 */
async function persistContactsFromScan(sb, {
  userId,
  transactionId,
  extracted,
  source = {},
  profile = null,
  dryRun = false,
}) {
  if (!extracted || typeof extracted !== 'object') {
    return { ok: false, reason: 'no_extraction', plan: null, written: false };
  }

  const tx = await loadTransactionForContacts(sb, { userId, transactionId });
  if (!tx) {
    return { ok: false, reason: 'deal_not_found_for_user', plan: null, written: false };
  }

  const plan = planContactWrites({ tx, extracted, source, profile });

  const hasColumnWrites = Object.keys(plan.updates).length > 0;
  const hasPartyWrites = plan.parties != null;
  if (!hasColumnWrites && !hasPartyWrites) {
    return { ok: true, reason: 'nothing_to_fill', plan, written: false, transaction: tx };
  }

  if (dryRun) {
    return { ok: true, reason: 'dry_run', plan, written: false, transaction: tx };
  }

  // Provenance accumulates across scans rather than replacing: a second
  // document filling a field the first one left blank should not erase the
  // record of where the first field came from.
  const existingProv = tx.contact_provenance && typeof tx.contact_provenance === 'object' && !Array.isArray(tx.contact_provenance)
    ? tx.contact_provenance
    : {};

  const body = { ...plan.updates };
  if (hasPartyWrites) body.parties = plan.parties;
  if (Object.keys(plan.provenance).length) {
    body.contact_provenance = { ...existingProv, ...plan.provenance };
  }
  // Conflicts are part of the record too. A parsed value that disagreed with
  // what the member typed is evidence about the deal — keeping it under a
  // reserved key means the member can be shown it later without us having
  // stored it anywhere it could be mistaken for a usable contact.
  if (plan.conflicts.length) {
    const prevConflicts = Array.isArray(existingProv._conflicts) ? existingProv._conflicts : [];
    body.contact_provenance = {
      ...(body.contact_provenance || existingProv),
      _conflicts: [...prevConflicts, ...plan.conflicts.map((c) => ({ ...c, recorded_at: new Date().toISOString() }))].slice(-50),
    };
  }

  const res = await sb(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    // A failed contact write must be loud in the logs and silent to the
    // member — the scan itself still succeeded and they should get that.
    // memory:feedback_silent-failure-is-the-enemy: the alarm ships with the
    // change, not after it.
    console.error('[contact-persistence] PATCH failed', {
      status: res.status,
      transaction_id: transactionId,
      columns: Object.keys(body),
    });
    return { ok: false, reason: 'write_failed', status: res.status, plan, written: false, transaction: tx };
  }

  console.log('[contact-persistence]', JSON.stringify({
    transaction_id: transactionId,
    filled: plan.filled.map((f) => f.column),
    conflicts: plan.conflicts.length,
    blocked: plan.blocked.length,
    rejected: plan.rejected.length,
    side: plan.side,
  }));

  return { ok: true, reason: 'written', plan, written: true, transaction: tx };
}

module.exports = {
  CONTACT_COLUMNS,
  CONTACT_SELECT,
  loadTransactionForContacts,
  persistContactsFromScan,
};
