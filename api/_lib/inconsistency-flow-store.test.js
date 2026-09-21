'use strict';

// api/_lib/inconsistency-flow-store.test.js   —   node --test api/_lib/
//
// The store half against a fake Supabase. What is worth testing here is not the
// routing (that is inconsistency-flow.test.js) but the three things that can
// only go wrong in the I/O:
//
//   1. EXECUTION DETECTION. documents.signature_status reads 'none' on all 357
//      live rows, including the executed 23 Nopalito contract. If the store ever
//      starts trusting it, every executed instrument routes down the "just edit
//      it" path and the whole flow is worse than useless.
//   2. TENANT SCOPING. Every request must carry user_id. A regression here
//      leaks another member's client names.
//   3. NOT GUESSING. Two open mismatches on one column must refuse, not pick.

const test = require('node:test');
const assert = require('node:assert');

const {
  loadDocumentEvidence,
  reviewDealInconsistencies,
  resolveInconsistency,
  recordSurfaced,
} = require('./inconsistency-flow-store');
const { CHOICE, REMEDY, conflictId } = require('./inconsistency-flow');

const USER = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';
const OTHER_USER = 'ffffffff-0000-0000-0000-000000000000';
const TX = '952e0d82-c453-4137-87b4-1ed46e738eb3';
const DOC = '7d669016-a2c4-4cde-9d10-cdfa4bbd8cd1';

const NOPALITO_CONFLICT = {
  column: 'seller2_name',
  party: 'seller',
  kind: 'name',
  existing: 'Jenny Whyte',
  parsed: 'Jennifer Whyte',
  source_field: 'sellerName',
  source_block: 'signature block',
  document: { document_id: DOC, file_name: 'executed-TREC 20-19 Contract - 23 Nopalito.pdf', document_label: 'trec-20-17' },
};

/**
 * A fake `sb` that records every path it was asked for, so the tests can assert
 * the tenant filter is present on all of them.
 */
function fakeSb(fixture, calls = []) {
  return async function sb(pathPart, init) {
    calls.push({ path: pathPart, method: (init && init.method) || 'GET', body: init && init.body });

    // Nothing is ever returned for a path that omits the tenant filter — the
    // same way the real thing behaves once RLS is bypassed by the service role
    // and user_id is the only boundary left.
    if (!/user_id=eq\./.test(pathPart)) return { ok: true, status: 200, data: [] };

    const uid = (pathPart.match(/user_id=eq\.([^&]+)/) || [])[1];
    if (uid !== USER) return { ok: true, status: 200, data: [] };

    if (init && init.method === 'PATCH') {
      fixture.patched = fixture.patched || [];
      fixture.patched.push(JSON.parse(init.body));
      return { ok: true, status: 204, data: null };
    }
    if (pathPart.startsWith('transactions?')) return { ok: true, status: 200, data: [fixture.tx] };
    if (pathPart.startsWith('documents?')) return { ok: true, status: 200, data: fixture.documents || [] };
    if (pathPart.startsWith('esign_events?')) return { ok: true, status: 200, data: fixture.events || [] };
    if (pathPart.startsWith('compliance_sends?')) return { ok: true, status: 200, data: fixture.sends || [] };
    return { ok: true, status: 200, data: [] };
  };
}

function nopalitoFixture(overrides = {}) {
  return {
    tx: {
      id: TX,
      user_id: USER,
      property_address: '23 Nopalito',
      role: 'listing',
      seller_name: 'Barry Whyte',
      seller2_name: 'Jenny Whyte',
      contact_provenance: { _conflicts: [NOPALITO_CONFLICT] },
      ...(overrides.tx || {}),
    },
    documents: overrides.documents !== undefined ? overrides.documents : [{
      id: DOC,
      file_name: 'executed-TREC 20-19 Contract - 23 Nopalito.pdf',
      document_type: 'signed',
      // The live value. It is a lie and the store must not believe it.
      signature_status: 'none',
      status: null,
      uploaded_at: '2026-09-20T23:50:00Z',
    }],
    events: overrides.events !== undefined ? overrides.events : [{
      document_id: DOC,
      document_name: '23 Nopalito - Seller Signature Packet has been completed by Jennifer Whyte, Barry Whyte',
      action: 'completed',
      verification_verdict: 'signed',
      event_at: '2026-09-20T23:46:41Z',
    }],
    sends: overrides.sends || [],
  };
}

// ---------------------------------------------------------------------------
// 1. EXECUTION DETECTION
// ---------------------------------------------------------------------------

test('a document is executed on the esign_events verdict, NOT on signature_status', async () => {
  const fx = nopalitoFixture();
  const docs = await loadDocumentEvidence(fakeSb(fx), { userId: USER, transactionId: TX });
  assert.strictEqual(docs.length, 1);
  assert.strictEqual(docs[0].executed, true, "signature_status='none' must not win over verdict='signed'");
  assert.strictEqual(docs[0].executed_at, '2026-09-20T23:46:41Z');
  assert.strictEqual(docs[0].signer_names, 'Jennifer Whyte, Barry Whyte');
  assert.strictEqual(docs[0].label, 'the TREC 20-19 contract');
});

test('partially_signed is NOT executed, and is flagged separately', async () => {
  const fx = nopalitoFixture({
    events: [{ document_id: DOC, action: 'completed', verification_verdict: 'partially_signed', event_at: '2026-09-20T23:46:41Z' }],
  });
  const docs = await loadDocumentEvidence(fakeSb(fx), { userId: USER, transactionId: TX });
  assert.strictEqual(docs[0].executed, false);
  assert.strictEqual(docs[0].partially_signed, true);
});

test('a document with no esign event at all is not executed', async () => {
  const fx = nopalitoFixture({ events: [] });
  const docs = await loadDocumentEvidence(fakeSb(fx), { userId: USER, transactionId: TX });
  assert.strictEqual(docs[0].executed, false);
  assert.strictEqual(docs[0].verdict, null);
});

test('a later ambiguous event cannot downgrade a confirmed execution', async () => {
  const fx = nopalitoFixture({
    events: [
      { document_id: DOC, action: 'other', verification_verdict: 'unverifiable', event_at: '2026-09-21T10:00:00Z' },
      { document_id: DOC, action: 'completed', verification_verdict: 'signed', event_at: '2026-09-20T23:46:41Z', document_name: 'x completed by Jennifer Whyte' },
    ],
  });
  const docs = await loadDocumentEvidence(fakeSb(fx), { userId: USER, transactionId: TX });
  assert.strictEqual(docs[0].executed, true);
});

// ---------------------------------------------------------------------------
// 2. TENANT SCOPING
// ---------------------------------------------------------------------------

test('every query carries user_id', async () => {
  const fx = nopalitoFixture();
  const calls = [];
  await reviewDealInconsistencies(fakeSb(fx, calls), { userId: USER, transactionId: TX, now: '2026-09-21T00:00:00Z' });
  assert.ok(calls.length >= 4, `expected transactions + documents + esign_events + compliance_sends, got ${calls.length}`);
  for (const c of calls) {
    assert.match(c.path, /user_id=eq\./, `missing tenant filter on: ${c.path}`);
  }
});

test("another member's user id gets nothing, not someone else's deal", async () => {
  const fx = nopalitoFixture();
  const out = await reviewDealInconsistencies(fakeSb(fx), { userId: OTHER_USER, transactionId: TX });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'deal_not_found_for_user');
});

test('the resolution PATCH is scoped by id AND user_id in one filter', async () => {
  const fx = nopalitoFixture();
  const calls = [];
  await resolveInconsistency(fakeSb(fx, calls), {
    userId: USER, transactionId: TX, conflictId: conflictId(NOPALITO_CONFLICT),
    choice: CHOICE.DOCUMENT, now: '2026-09-21T00:00:00Z',
  });
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch, 'expected a PATCH');
  assert.match(patch.path, /id=eq\./);
  assert.match(patch.path, /user_id=eq\./);
});

// ---------------------------------------------------------------------------
// 3. END TO END ON THE REAL CASE
// ---------------------------------------------------------------------------

test('the real Nopalito conflict surfaces as critical, with the executed doc seen', async () => {
  const fx = nopalitoFixture();
  const out = await reviewDealInconsistencies(fakeSb(fx), { userId: USER, transactionId: TX, now: '2026-09-21T00:00:00Z' });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.executed_documents, 1);
  assert.strictEqual(out.raise.length, 1);
  assert.strictEqual(out.raise[0].severity, 'critical');
  assert.match(out.raise[0].message, /Jennifer Whyte/);
  assert.match(out.raise[0].message, /Jenny Whyte/);
});

test('"same person" writes a resolution, corrects only the dossier, and drafts nothing', async () => {
  const fx = nopalitoFixture();
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, conflictId: conflictId(NOPALITO_CONFLICT),
    choice: CHOICE.SAME, value: 'Jennifer Whyte',
    note: "Confirmed against her driver's licence.", now: '2026-09-21T00:00:00Z',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.resolved, true);
  assert.ok(!out.remedies.some((r) => r.remedy === REMEDY.AMENDMENT));

  const patch = fx.patched[fx.patched.length - 1];
  // The dossier is aligned to the legal spelling...
  assert.strictEqual(patch.seller2_name, 'Jennifer Whyte');
  // ...and the answer is on the record, in ONE shape, with the member's words.
  const rec = patch.contact_provenance._resolutions.slice(-1)[0];
  assert.strictEqual(rec.choice, 'same');
  assert.deepStrictEqual(rec.equivalent_values, ['Jenny Whyte', 'Jennifer Whyte']);
  assert.strictEqual(rec.note, "Confirmed against her driver's licence.");
  // Nothing was left pending, because nothing is wrong.
  assert.deepStrictEqual(out.pending, []);
});

test('"my dossier is right" returns a PENDING amendment and does NOT touch the dossier', async () => {
  const fx = nopalitoFixture();
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, conflictId: conflictId(NOPALITO_CONFLICT),
    choice: CHOICE.DOSSIER, now: '2026-09-21T00:00:00Z',
  });
  assert.strictEqual(out.ok, true);
  assert.ok(out.pending.some((r) => r.remedy === REMEDY.AMENDMENT), 'the amendment must come back as pending work');
  // The amendment has not been drafted, let alone sent.
  assert.deepStrictEqual(out.applied, []);
  const patch = fx.patched[fx.patched.length - 1];
  // seller2_name must NOT have been written — the contract still legally says
  // Jennifer until an amendment is executed.
  assert.ok(!('seller2_name' in patch), 'must not pre-apply a value the contract does not yet carry');
  assert.ok(patch.contact_provenance._resolutions.length >= 1);
});

test('"the document is right" applies the dossier fix immediately', async () => {
  const fx = nopalitoFixture();
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, conflictId: conflictId(NOPALITO_CONFLICT),
    choice: CHOICE.DOCUMENT, now: '2026-09-21T00:00:00Z',
  });
  assert.deepStrictEqual(out.applied, [{ remedy: REMEDY.UPDATE_FIELD, column: 'seller2_name', value: 'Jennifer Whyte' }]);
  assert.strictEqual(fx.patched.slice(-1)[0].seller2_name, 'Jennifer Whyte');
});

// ---------------------------------------------------------------------------
// 4. NOT GUESSING, AND NOT NAGGING
// ---------------------------------------------------------------------------

test('two open mismatches on one column refuse rather than pick one', async () => {
  const second = { ...NOPALITO_CONFLICT, parsed: 'Jenni Whyte', document: { document_id: 'other-doc', file_name: 'b.pdf' } };
  const fx = nopalitoFixture({ tx: { contact_provenance: { _conflicts: [NOPALITO_CONFLICT, second] } } });
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, column: 'seller2_name', choice: CHOICE.DOSSIER, now: '2026-09-21T00:00:00Z',
  });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'ambiguous_conflict');
  assert.strictEqual(out.count, 2);
});

test('answering by column works when it is unambiguous', async () => {
  const fx = nopalitoFixture();
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, column: 'seller2_name', choice: CHOICE.DOCUMENT, now: '2026-09-21T00:00:00Z',
  });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.correct_value, 'Jennifer Whyte');
});

test('the ledger records the raise so the next deal-open is quiet', async () => {
  const fx = nopalitoFixture();
  const sb = fakeSb(fx);
  const first = await reviewDealInconsistencies(sb, { userId: USER, transactionId: TX, now: '2026-09-21T00:00:00Z' });
  assert.strictEqual(first.raise.length, 1);

  await recordSurfaced(sb, { userId: USER, transactionId: TX, raised: first.raise, now: '2026-09-21T00:00:00Z' });
  const ledger = fx.patched.slice(-1)[0].contact_provenance._surfaced;
  const id = conflictId(NOPALITO_CONFLICT);
  assert.strictEqual(ledger[id].raise_count, 1);
  assert.strictEqual(ledger[id].last_severity, 'critical');

  // Feed the ledger back in — the same conflict must now stay quiet.
  fx.tx = { ...fx.tx, contact_provenance: { ...fx.tx.contact_provenance, _surfaced: ledger } };
  const second = await reviewDealInconsistencies(sb, { userId: USER, transactionId: TX, now: '2026-09-22T09:00:00Z' });
  assert.deepStrictEqual(second.raise, []);
  assert.strictEqual(second.held[0].reason, 'already_raised_and_unchanged');
});

test('a document gate speaks anyway, and blocks', async () => {
  const fx = nopalitoFixture();
  const id = conflictId(NOPALITO_CONFLICT);
  fx.tx = {
    ...fx.tx,
    contact_provenance: {
      ...fx.tx.contact_provenance,
      _surfaced: { [id]: { first_raised_at: '2026-09-21T00:00:00Z', raise_count: 4, last_severity: 'critical' } },
    },
  };
  const out = await reviewDealInconsistencies(fakeSb(fx), {
    userId: USER, transactionId: TX, trigger: 'document_gate',
    aboutToUseColumns: ['seller2_name', 'sale_price'], now: '2026-09-25T09:00:00Z',
  });
  assert.strictEqual(out.raise.length, 1);
  assert.strictEqual(out.raise[0].blocking, true);
});

test('"not now" snoozes instead of resolving, and writes no resolution', async () => {
  const fx = nopalitoFixture();
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, conflictId: conflictId(NOPALITO_CONFLICT),
    choice: CHOICE.NOT_NOW, now: '2026-09-21T00:00:00Z',
  });
  assert.strictEqual(out.resolved, false);
  const patch = fx.patched.slice(-1)[0];
  assert.ok(!patch.contact_provenance._resolutions, 'a deferral is not an answer');
  const snooze = patch.contact_provenance._surfaced[conflictId(NOPALITO_CONFLICT)].snoozed_until;
  assert.strictEqual(snooze, '2026-09-28T00:00:00.000Z');
});

test('a deal with no recorded conflicts skips the evidence queries entirely', async () => {
  const fx = nopalitoFixture({ tx: { contact_provenance: {} } });
  const calls = [];
  const out = await reviewDealInconsistencies(fakeSb(fx, calls), { userId: USER, transactionId: TX, now: '2026-09-21T00:00:00Z' });
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.raise, []);
  assert.strictEqual(out.recorded_conflicts, 0);
  assert.ok(!calls.some((c) => c.path.startsWith('documents?')), 'no need to load documents when nothing disagrees');
});

test("a third-party copy adds a notice remedy to the pending list", async () => {
  const fx = nopalitoFixture({
    sends: [{ recipient_role: 'title', sent_to_name: 'Upward Title and Closing', sent_at: '2026-09-20T10:00:00Z' }],
  });
  const out = await resolveInconsistency(fakeSb(fx), {
    userId: USER, transactionId: TX, conflictId: conflictId(NOPALITO_CONFLICT),
    choice: CHOICE.DOSSIER, now: '2026-09-21T00:00:00Z',
  });
  const kinds = out.pending.map((r) => r.remedy);
  assert.ok(kinds.includes(REMEDY.AMENDMENT));
  assert.ok(kinds.includes(REMEDY.NOTIFY_THIRD_PARTY));
});

test('a dry-run compliance send creates no obligation', async () => {
  // dry_run=is.false is in the query string, so the fake never returns it —
  // this asserts the filter is actually present rather than applied in JS.
  const fx = nopalitoFixture();
  const calls = [];
  await reviewDealInconsistencies(fakeSb(fx, calls), { userId: USER, transactionId: TX, now: '2026-09-21T00:00:00Z' });
  const sendsCall = calls.find((c) => c.path.startsWith('compliance_sends?'));
  assert.ok(sendsCall);
  assert.match(sendsCall.path, /dry_run=is\.false/);
});
