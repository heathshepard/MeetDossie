'use strict';

// api/_lib/inconsistency-flow-store.js
//
// The I/O half of the inconsistency flow. api/_lib/inconsistency-flow.js decides
// WHAT to raise and WHAT the remedy is (and is pure, so the routing table is
// testable without a database); this module gathers the evidence and is the only
// thing here that writes a row.
//
// ---------------------------------------------------------------------------
// MULTI-TENANCY
// ---------------------------------------------------------------------------
// Same contract as api/_lib/contact-persistence-store.js, for the same reason:
// these helpers run under the service role, which bypasses RLS entirely, and
// `transactions` is multi-tenant (memory:transactions-table-is-multi-tenant — a
// missing user_id filter once published another customer's client data).
//
// Every read and every write carries `user_id=eq.<session user>`. The
// transaction id is never trusted on its own. The write is expressed as
// `id=eq.X&user_id=eq.Y` rather than an ownership check followed by
// `id=eq.X`, because check-then-write has a window and the combined filter
// does not.
//
// ---------------------------------------------------------------------------
// EXECUTION STATE COMES FROM esign_events, NOT FROM documents.signature_status
// ---------------------------------------------------------------------------
// `documents.signature_status` reads 'none' on all 357 live rows — including
// document 7d669016-…, "executed-TREC 20-19 Contract - 23 Nopalito.pdf", whose
// esign_events row says verification_verdict='signed', signed by Jennifer Whyte
// and Barry Whyte on 2026-09-20. Trusting that column would route every
// executed instrument down the "just edit it" path, which is the one thing this
// whole flow exists to prevent.
//
// So: a document is EXECUTED only when the system of record says so —
// esign_events.verification_verdict='signed'. 'partially_signed' is NOT
// executed (memory:feedback_only-upload-executed-documents), and it is not a
// draft either; it is called out separately so the member is told the packet is
// mid-signature rather than being offered a quiet re-send.
// memory:feedback_poll-system-of-record-not-notifications.
//
// Owner: 2026-09-20.

const {
  reviewDeal,
  describeConflict,
  routeRemedy,
  conflictId,
  CHOICE,
} = require('./inconsistency-flow');

// Reserved keys inside transactions.contact_provenance.
const K_CONFLICTS = '_conflicts';
const K_RESOLUTIONS = '_resolutions';
const K_LEGACY_RESOLUTIONS = '_resolved_by_heath';
const K_LEDGER = '_surfaced';

const TX_SELECT = [
  'id', 'user_id', 'property_address', 'city_state_zip', 'role', 'transaction_type',
  'buyer_name', 'buyer2_name', 'seller_name', 'seller2_name',
  'sale_price', 'closing_date', 'earnest_money', 'option_fee', 'option_days',
  'title_company', 'title_officer_name', 'title_officer_email', 'title_officer_phone',
  'other_agent_name', 'other_agent_email_addr', 'other_broker_name',
  'parties', 'contact_provenance',
].join(',');

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Load one deal, scoped to its owner. null when it is not this member's. */
async function loadDeal(sb, { userId, transactionId }) {
  if (!userId || !transactionId) return null;
  const { ok, data } = await sb(
    `transactions?select=${TX_SELECT}`
    + `&id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + '&limit=1',
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

/**
 * Every document on this deal, with an honest executed flag.
 *
 * Two queries because the truth is split across two tables, and both are
 * user_id-scoped independently — a document id from another tenant must not be
 * resolvable through the esign_events join either.
 */
async function loadDocumentEvidence(sb, { userId, transactionId }) {
  const [docsRes, eventsRes] = await Promise.all([
    sb(`documents?select=id,file_name,document_type,form_type,status,docuseal_submission_id,uploaded_at`
      + `&transaction_id=eq.${encodeURIComponent(transactionId)}`
      + `&user_id=eq.${encodeURIComponent(userId)}`
      + '&order=uploaded_at.desc&limit=200'),
    sb(`esign_events?select=document_id,document_name,action,verification_verdict,event_at,participant_name`
      + `&transaction_id=eq.${encodeURIComponent(transactionId)}`
      + `&user_id=eq.${encodeURIComponent(userId)}`
      + '&order=event_at.desc&limit=200'),
  ]);

  const events = asArray(eventsRes && eventsRes.data);
  // Best verdict per document. 'signed' beats 'partially_signed' beats the rest,
  // because a later ambiguous event must not downgrade a confirmed execution.
  const verdictRank = { signed: 3, partially_signed: 2, unverifiable: 1 };
  const byDoc = new Map();
  for (const e of events) {
    if (!e || !e.document_id) continue;
    const prev = byDoc.get(e.document_id);
    const rank = verdictRank[e.verification_verdict] || 0;
    if (!prev || rank > (verdictRank[prev.verification_verdict] || 0)) byDoc.set(e.document_id, e);
  }

  return asArray(docsRes && docsRes.data).map((d) => {
    const ev = byDoc.get(d.id) || null;
    const verdict = ev && ev.verification_verdict;
    const executed = verdict === 'signed';
    // Signers come off the esign notification subject, which is the only place
    // that records WHO signed. Names, not addresses — this text is shown to the
    // member, and the amendment remedy tells them who has to sign the fix.
    const signers = ev && ev.document_name
      ? (String(ev.document_name).match(/completed by (.+)$/i) || [])[1] || null
      : null;
    return {
      document_id: d.id,
      file_name: d.file_name,
      label: friendlyDocLabel(d),
      document_type: d.document_type || null,
      executed,
      executed_at: executed && ev ? ev.event_at : null,
      verdict: verdict || null,
      partially_signed: verdict === 'partially_signed',
      signer_names: signers,
    };
  });
}

function friendlyDocLabel(d) {
  const raw = String((d && d.file_name) || '').replace(/\.pdf$/i, '').replace(/^executed-/i, '');
  const t = String((d && d.document_type) || '');
  if (/20-19|resale|1-4 family/i.test(raw) || t === 'resale_contract') return 'the TREC 20-19 contract';
  if (t === 'amendment') return 'the amendment';
  if (/listing.agreement|1101/i.test(raw) || t === 'listing_agreement' || t === 'trec-listing-agreement') return 'the listing agreement';
  if (t === 'sellers_disclosure' || t === 'trec-sellers-disclosure') return "the seller's disclosure";
  return raw || 'a document on this file';
}

/**
 * Copies that have already left the member's control.
 * `dry_run=false` only — a dry run never reached anybody, so it creates no
 * obligation to correct anything.
 */
async function loadThirdPartySends(sb, { userId, transactionId }) {
  const { ok, data } = await sb(
    `compliance_sends?select=recipient_role,sent_to_name,sent_to_email,sent_at,document_count`
    + `&transaction_id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + '&dry_run=is.false&order=sent_at.desc&limit=50',
  );
  if (!ok) return [];
  return asArray(data).filter((r) => r && r.sent_at);
}

/**
 * STEP 1 — what should this member be shown about this deal, right now?
 *
 * @param {Function} sb  the Supabase REST helper: (path, init) => {ok,status,data}
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} opts.transactionId
 * @param {string} [opts.trigger]            'deal_open' | 'document_gate' | 'scan'
 * @param {string[]|null} [opts.aboutToUseColumns]  for 'document_gate'
 * @param {string} [opts.now]
 */
async function reviewDealInconsistencies(sb, {
  userId,
  transactionId,
  trigger = 'deal_open',
  aboutToUseColumns = null,
  now = null,
}) {
  const tx = await loadDeal(sb, { userId, transactionId });
  if (!tx) return { ok: false, reason: 'deal_not_found_for_user' };

  const prov = asObject(tx.contact_provenance);
  const conflicts = asArray(prov[K_CONFLICTS]);

  // Nothing recorded: say so plainly rather than inventing reassurance. An
  // empty _conflicts array means "the scanner found no disagreement", NOT
  // "this deal has been checked and is clean" — no scan may ever have run.
  const [documents, thirdPartySends] = conflicts.length
    ? await Promise.all([
      loadDocumentEvidence(sb, { userId, transactionId }),
      loadThirdPartySends(sb, { userId, transactionId }),
    ])
    : [[], []];

  const resolutions = [
    ...asArray(prov[K_RESOLUTIONS]),
    ...asArray(prov[K_LEGACY_RESOLUTIONS]),
  ];

  const review = reviewDeal({
    conflicts,
    // Evidence is per-conflict: only the documents that actually carry the
    // parsed value, plus the deal's current value for that column.
    evidenceFor: (c) => ({
      dossierValue: c && c.column ? tx[c.column] : null,
      documents: documents.filter((d) => d.document_id === (c && c.document && c.document.document_id)),
      thirdPartySends,
    }),
    ledger: asObject(prov[K_LEDGER]),
    resolutions,
    trigger,
    aboutToUseColumns,
    now: now || new Date().toISOString(),
  });

  return {
    ok: true,
    transaction: {
      id: tx.id,
      property_address: tx.property_address,
      city_state_zip: tx.city_state_zip,
    },
    recorded_conflicts: conflicts.length,
    documents_seen: documents.length,
    executed_documents: documents.filter((d) => d.executed).length,
    ...review,
  };
}

/**
 * Mark what we just showed the member, so the same thing is not raised again
 * tomorrow. This is the anti-nag ledger; without it shouldSurface() has no
 * memory and every deal-open repeats itself.
 *
 * Fire-and-forget by design: failing to record a raise must never stop the
 * member seeing the conflict. But it is logged loudly, because a silently
 * broken ledger degrades into exactly the daily-alert behaviour this replaces.
 * memory:feedback_silent-failure-is-the-enemy.
 */
async function recordSurfaced(sb, { userId, transactionId, raised, now = null }) {
  const list = asArray(raised).filter((r) => r && r.conflict_id);
  if (!list.length) return { ok: true, written: false };

  const tx = await loadDeal(sb, { userId, transactionId });
  if (!tx) return { ok: false, reason: 'deal_not_found_for_user' };

  const prov = asObject(tx.contact_provenance);
  const ledger = { ...asObject(prov[K_LEDGER]) };
  const at = now || new Date().toISOString();

  for (const r of list) {
    const prev = asObject(ledger[r.conflict_id]);
    ledger[r.conflict_id] = {
      first_raised_at: prev.first_raised_at || at,
      last_raised_at: at,
      raise_count: (Number(prev.raise_count) || 0) + 1,
      last_severity: r.severity || prev.last_severity || 'low',
      last_trigger: r.surface_reason || null,
      snoozed_until: null,
    };
  }

  const res = await sb(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ contact_provenance: { ...prov, [K_LEDGER]: ledger } }),
    },
  );
  if (!res.ok) {
    console.error('[inconsistency-flow] ledger PATCH failed', {
      status: res.status, transaction_id: transactionId, count: list.length,
    });
    return { ok: false, reason: 'ledger_write_failed', status: res.status };
  }
  return { ok: true, written: true, count: list.length };
}

/**
 * STEP 2 + STEP 3 — record the member's choice and return the remedy plan.
 *
 * Writes the resolution but performs NO remedy. The remedies come back as a
 * plan the caller acts on, one at a time, with the member's eyes on it. In
 * particular nothing here drafts, signs or sends anything; `draft_amendment`
 * is a separate, explicitly draft-only call the member triggers.
 *
 * @param {object} opts
 * @param {string} opts.conflictId
 * @param {string} opts.choice     one of CHOICE
 * @param {string} [opts.value]    required for 'other'; optional legal spelling for 'same'
 * @param {string} [opts.note]
 */
async function resolveInconsistency(sb, {
  userId, transactionId, conflictId: targetId, column = null, choice, value = null, note = null, now = null,
}) {
  const tx = await loadDeal(sb, { userId, transactionId });
  if (!tx) return { ok: false, reason: 'deal_not_found_for_user' };

  const prov = asObject(tx.contact_provenance);
  const conflicts = asArray(prov[K_CONFLICTS]);
  const alreadyResolved = new Set(
    asArray(prov[K_RESOLUTIONS]).map((r) => r && r.conflict_id).filter(Boolean),
  );

  let match = null;
  if (targetId) {
    match = conflicts.find((c) => conflictId(c) === targetId) || null;
    if (!match) return { ok: false, reason: 'conflict_not_found' };
  } else if (column) {
    // Voice answers ("the dossier is right") arrive without an id. Match by
    // column — but ONLY when it is unambiguous. Two open mismatches on the same
    // field and we refuse rather than resolve the wrong one: a mis-attributed
    // answer would record a decision the member never made, and on a party name
    // that decision is what does or does not trigger an amendment.
    const candidates = conflicts.filter(
      (c) => c && c.column === column && !alreadyResolved.has(conflictId(c)),
    );
    if (candidates.length === 0) return { ok: false, reason: 'conflict_not_found' };
    if (candidates.length > 1) return { ok: false, reason: 'ambiguous_conflict', count: candidates.length, column };
    match = candidates[0];
  } else {
    return { ok: false, reason: 'conflict_not_specified' };
  }

  // From here on the id is always known, whether the caller supplied it or we
  // matched by column — the ledger and the log are keyed on it.
  const resolvedId = conflictId(match);

  const [documents, thirdPartySends] = await Promise.all([
    loadDocumentEvidence(sb, { userId, transactionId }),
    loadThirdPartySends(sb, { userId, transactionId }),
  ]);

  const described = describeConflict(match, {
    dossierValue: match.column ? tx[match.column] : null,
    documents: documents.filter((d) => d.document_id === (match.document && match.document.document_id)),
    thirdPartySends,
  });

  const at = now || new Date().toISOString();
  const routed = routeRemedy({ described, choice, value, note, now: at });
  if (!routed.ok) return { ok: false, reason: 'bad_choice', error: routed.error };

  // 'not_now' is a deferral, not an answer. Snooze it rather than resolving it,
  // so it comes back — but only once the snooze expires, and immediately at a
  // document gate regardless.
  if (!routed.resolved) {
    const ledger = { ...asObject(prov[K_LEDGER]) };
    const prev = asObject(ledger[resolvedId]);
    const snooze = new Date(Date.parse(at) + 7 * 24 * 3600 * 1000).toISOString();
    ledger[resolvedId] = { ...prev, first_raised_at: prev.first_raised_at || at, snoozed_until: snooze };
    await sb(
      `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}`,
      { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ contact_provenance: { ...prov, [K_LEDGER]: ledger } }) },
    );
    return { ok: true, resolved: false, described, ...routed };
  }

  const resolutions = [...asArray(prov[K_RESOLUTIONS]), routed.resolution_record].slice(-100);

  const body = { contact_provenance: { ...prov, [K_RESOLUTIONS]: resolutions } };

  // Apply ONLY the dossier-record remedy, and only when it is not waiting on an
  // amendment. Everything else is paperwork the member has to see first: an
  // unexecuted document has to be regenerated and re-sent, an executed one
  // needs an amendment all parties sign, and a third-party copy needs a notice.
  // None of that happens as a side effect of answering a question.
  const applied = [];
  const fieldRemedy = asArray(routed.remedies).find(
    (r) => r.action && r.action.type === 'update_field' && !r.deferred_until,
  );
  if (fieldRemedy && fieldRemedy.action.column) {
    body[fieldRemedy.action.column] = fieldRemedy.action.value;
    applied.push({ remedy: fieldRemedy.remedy, column: fieldRemedy.action.column, value: fieldRemedy.action.value });
  }

  const res = await sb(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    console.error('[inconsistency-flow] resolution PATCH failed', {
      status: res.status, transaction_id: transactionId, conflict_id: resolvedId,
    });
    return { ok: false, reason: 'write_failed', status: res.status };
  }

  console.log('[inconsistency-flow]', JSON.stringify({
    transaction_id: transactionId,
    conflict_id: resolvedId,
    column: described.column,
    choice,
    remedies: routed.remedies.map((r) => r.remedy),
    applied: applied.map((a) => a.column),
  }));

  return {
    ok: true,
    resolved: true,
    described,
    applied,
    // Work the member still has to authorise. Nothing in here has happened.
    pending: asArray(routed.remedies)
      .filter((r) => r.action && r.action.type !== 'update_field')
      .concat(asArray(routed.remedies).filter((r) => r.action && r.action.type === 'update_field' && r.deferred_until)),
    ...routed,
  };
}

module.exports = {
  K_CONFLICTS,
  K_RESOLUTIONS,
  K_LEGACY_RESOLUTIONS,
  K_LEDGER,
  CHOICE,
  loadDeal,
  loadDocumentEvidence,
  loadThirdPartySends,
  reviewDealInconsistencies,
  recordSurfaced,
  resolveInconsistency,
};
