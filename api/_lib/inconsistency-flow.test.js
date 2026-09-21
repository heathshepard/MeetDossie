'use strict';

// api/_lib/inconsistency-flow.test.js   —   node --test api/_lib/
//
// The cases below are the REAL ones. 23 Nopalito and 29046 Pfeiffers Gate are
// live rows, pulled 2026-09-20, and the executed-document facts come from
// esign_events, not from anyone's memory of them.
//
// The three tests that matter most:
//   - "same person" must NOT produce an amendment
//   - "my dossier is right" on the SAME two values MUST produce one
//   - the second raise on deal_open must be silent

const test = require('node:test');
const assert = require('node:assert');

const {
  SITE, REMEDY, CHOICE,
  classifyDifference,
  describeConflict,
  routeRemedy,
  shouldSurface,
  reviewDeal,
  conflictId,
} = require('./inconsistency-flow');

// ---------------------------------------------------------------------------
// The live 23 Nopalito conflict, reconstructed.
//
// transactions 952e0d82-c453-4137-87b4-1ed46e738eb3, seller2_name.
// Heath's own hand-written note on that row:
//   "Resolved from the signed TXR-1101 listing agreement: sellers are Barry
//    Whyte and Jennifer Whyte; 'Jenny' is Jennifer."
// So before he resolved it, the dossier said "Jenny Whyte" and the contract
// said "Jennifer Whyte".
//
// The document is genuinely executed:
//   esign_events: action=completed, verification_verdict='signed',
//   provider=docuseal, event_at=2026-09-20T23:46:41Z, sha256 present,
//   "23 Nopalito - Seller Signature Packet has been completed by
//    Jennifer Whyte, Barry Whyte"
//   documents 7d669016-a2c4-4cde-9d10-cdfa4bbd8cd1,
//   file_name "executed-TREC 20-19 Contract - 23 Nopalito.pdf"
// ---------------------------------------------------------------------------
const NOPALITO_CONFLICT = {
  column: 'seller2_name',
  party: 'seller',
  kind: 'name',
  existing: 'Jenny Whyte',
  parsed: 'Jennifer Whyte',
  parsed_all: ['Barry Whyte', 'Jennifer Whyte'],
  source_field: 'sellerName',
  source_block: 'signature block',
  document: {
    document_id: '7d669016-a2c4-4cde-9d10-cdfa4bbd8cd1',
    file_name: 'executed-TREC 20-19 Contract - 23 Nopalito.pdf',
    document_label: 'trec-20-17',
  },
};

const NOPALITO_EVIDENCE = {
  dossierValue: 'Jenny Whyte',
  documents: [{
    document_id: '7d669016-a2c4-4cde-9d10-cdfa4bbd8cd1',
    file_name: 'executed-TREC 20-19 Contract - 23 Nopalito.pdf',
    label: 'the TREC 20-19 contract',
    executed: true,
    executed_at: '2026-09-20T23:46:41Z',
    verdict: 'signed',
    signer_names: 'Jennifer Whyte, Barry Whyte',
  }],
  thirdPartySends: [],
};

const NOW = '2026-09-20T20:00:00Z';

// ---------------------------------------------------------------------------
// Difference classification — the "what's worth raising" floor
// ---------------------------------------------------------------------------

test('Jenny/Jennifer is a nickname candidate, not a silent correction', () => {
  assert.strictEqual(classifyDifference('Jenny Whyte', 'Jennifer Whyte'), 'nickname_candidate');
});

test('a middle initial is cosmetic', () => {
  assert.strictEqual(classifyDifference('Clark L. Champie', 'Clark Champie'), 'middle_initial_only');
});

test('a Jr suffix is cosmetic', () => {
  assert.strictEqual(classifyDifference('Clark L. Champie, Jr.', 'Clark L. Champie'), 'suffix_only');
});

test('an extra human being is never cosmetic', () => {
  assert.strictEqual(
    classifyDifference('Andres Ramirez', 'Andres Ramirez, Vanessa Ramirez'),
    'extra_party',
  );
});

test('an unrelated name falls through to different, which ranks higher', () => {
  assert.strictEqual(classifyDifference('Aum Patel', 'Monica Bryan'), 'different');
});

test('classification never throws on null / empty', () => {
  assert.strictEqual(classifyDifference(null, null), 'identical');
  assert.strictEqual(classifyDifference('', 'Barry Whyte'), 'different');
});

// ---------------------------------------------------------------------------
// STEP 1 — surfacing presents both values and refuses to pick
// ---------------------------------------------------------------------------

test('surfacing names both values with their sources and picks no winner', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  assert.match(d.message, /Jennifer Whyte/);
  assert.match(d.message, /Jenny Whyte/);
  assert.match(d.message, /Which is right\?/);
  // No verdict, no confidence score, no recommendation anywhere in the output.
  assert.strictEqual(d.dossier.value, 'Jenny Whyte');
  assert.strictEqual(d.document.value, 'Jennifer Whyte');
  assert.ok(!('recommended' in d), 'must not recommend a winner');
  assert.ok(!('confidence' in d), 'must not score a winner');
});

test('a party name on an executed instrument ranks critical, and says why', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  assert.strictEqual(d.severity, 'critical');
  assert.match(d.severity_reason, /executed document/);
  assert.match(d.severity_reason, /amendment/);
});

test('"same person" is offered on a name conflict — it was the real answer twice', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const same = d.choices.find((c) => c.choice === CHOICE.SAME);
  assert.ok(same, '"same person" must be an option');
  assert.ok(same.needs_legal_name);
  assert.ok(d.choices.find((c) => c.choice === CHOICE.OTHER));
  assert.ok(d.choices.find((c) => c.choice === CHOICE.NOT_NOW));
});

test('the executed document is recognised from esign_events, and sited correctly', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const sites = d.sites.map((s) => s.site);
  assert.ok(sites.includes(SITE.DOSSIER));
  assert.ok(sites.includes(SITE.DOC_EXECUTED));
  assert.ok(!sites.includes(SITE.DOC_UNEXECUTED));
});

test('a cosmetic difference on a record-keeping field with no executed doc is below the floor', () => {
  const c = {
    column: 'other_broker_name', party: 'buyerAgent', kind: 'brokerage',
    existing: 'Keller Williams City View',
    parsed: 'Keller Williams City-View',
    document: { document_id: 'd1', file_name: 'x.pdf' },
  };
  const d = describeConflict(c, { dossierValue: 'Keller Williams City View', documents: [] });
  // Punctuation-only normalises identical — it should never have been a
  // conflict, and if it gets here it must not reach the member.
  const v = shouldSurface({ described: d, trigger: 'deal_open', now: NOW });
  assert.strictEqual(v.surface, false);
  assert.strictEqual(v.reason, 'below_attention_floor');
});

// ---------------------------------------------------------------------------
// STEP 3 — THE REMEDY ROUTING TABLE. This is the valuable part.
// ---------------------------------------------------------------------------

test('THE CRUX: "same person" produces NO amendment', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const r = routeRemedy({ described: d, choice: CHOICE.SAME, value: 'Jennifer Whyte', now: NOW });
  assert.ok(r.ok);
  const kinds = r.remedies.map((x) => x.remedy);
  assert.ok(kinds.includes(REMEDY.RECORD_EQUIVALENCE));
  assert.ok(!kinds.includes(REMEDY.AMENDMENT), 'nothing is wrong, so nothing may be amended');
  // Told us the legal spelling, and the dossier held the other one: align it.
  assert.ok(kinds.includes(REMEDY.UPDATE_FIELD));
  const upd = r.remedies.find((x) => x.remedy === REMEDY.UPDATE_FIELD);
  assert.deepStrictEqual(upd.action, { type: 'update_field', column: 'seller2_name', value: 'Jennifer Whyte' });
  assert.deepStrictEqual(r.resolution_record.equivalent_values, ['Jenny Whyte', 'Jennifer Whyte']);
});

test('THE CRUX, INVERTED: the same two values, answered "my dossier is right", DOES require an amendment', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const r = routeRemedy({ described: d, choice: CHOICE.DOSSIER, now: NOW });
  assert.ok(r.ok);
  const amend = r.remedies.find((x) => x.remedy === REMEDY.AMENDMENT);
  assert.ok(amend, 'an executed instrument carrying a wrong party name needs an amendment');
  assert.strictEqual(amend.site, SITE.DOC_EXECUTED);
  assert.strictEqual(amend.blocking, true);
  assert.match(amend.why, /never be edited/);
  assert.strictEqual(amend.action.type, 'draft_amendment');
  assert.strictEqual(amend.action.amendment_type, 'party_name');
  assert.strictEqual(amend.action.original_value, 'Jennifer Whyte');
  assert.strictEqual(amend.action.new_value, 'Jenny Whyte');
  assert.match(r.headline, /needs an amendment/);
  // And the dossier update waits on the amendment rather than racing it.
  const upd = r.remedies.find((x) => x.remedy === REMEDY.UPDATE_FIELD);
  assert.ok(!upd || upd.deferred_until === 'amendment_executed');
});

test('the amendment remedy is DRAFT-ONLY and says so', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const r = routeRemedy({ described: d, choice: CHOICE.DOSSIER, now: NOW });
  const amend = r.remedies.find((x) => x.remedy === REMEDY.AMENDMENT);
  assert.match(amend.detail, /DRAFT/);
  assert.match(amend.detail, /have not sent it/);
});

test('"the document is right" is a records-only fix — no amendment', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const r = routeRemedy({ described: d, choice: CHOICE.DOCUMENT, now: NOW });
  const kinds = r.remedies.map((x) => x.remedy);
  assert.deepStrictEqual(kinds, [REMEDY.UPDATE_FIELD]);
  assert.strictEqual(r.correct_value, 'Jennifer Whyte');
  assert.match(r.headline, /Records-only/);
});

test('an UNEXECUTED document is corrected and re-sent, not amended', () => {
  const evidence = {
    dossierValue: 'Jenny Whyte',
    documents: [{
      document_id: 'draft-1', file_name: 'TREC 20-19 - 23 Nopalito.pdf',
      label: 'the TREC 20-19 draft', executed: false,
    }],
    thirdPartySends: [],
  };
  const d = describeConflict({ ...NOPALITO_CONFLICT, document: { document_id: 'draft-1', file_name: 'TREC 20-19 - 23 Nopalito.pdf' } }, evidence);
  const r = routeRemedy({ described: d, choice: CHOICE.DOSSIER, now: NOW });
  const kinds = r.remedies.map((x) => x.remedy);
  assert.ok(kinds.includes(REMEDY.CORRECT_RESEND));
  assert.ok(!kinds.includes(REMEDY.AMENDMENT));
  assert.strictEqual(d.severity, 'high', 'a draft is serious but not critical');
});

test('a copy already filed with a third party gets its own remedy', () => {
  const evidence = {
    ...NOPALITO_EVIDENCE,
    thirdPartySends: [{ recipient_role: 'title', sent_to_name: 'Upward Title and Closing', sent_at: '2026-09-20T10:00:00Z' }],
  };
  const d = describeConflict(NOPALITO_CONFLICT, evidence);
  const r = routeRemedy({ described: d, choice: CHOICE.DOSSIER, now: NOW });
  const kinds = r.remedies.map((x) => x.remedy);
  assert.ok(kinds.includes(REMEDY.AMENDMENT));
  assert.ok(kinds.includes(REMEDY.NOTIFY_THIRD_PARTY));
  const n = r.remedies.find((x) => x.remedy === REMEDY.NOTIFY_THIRD_PARTY);
  assert.match(n.why, /Upward Title and Closing/);
  assert.match(n.detail, /not sent/);
  // Amendment first — it gates the notice.
  assert.ok(kinds.indexOf(REMEDY.AMENDMENT) < kinds.indexOf(REMEDY.NOTIFY_THIRD_PARTY));
});

test('a dossier-only wrong value is just a field update', () => {
  const d = describeConflict(
    { column: 'title_officer_email', party: 'title', kind: 'email', existing: 'old@upward.com', parsed: 'lauren@upward.com', document: { document_id: 'x' } },
    { dossierValue: 'old@upward.com', documents: [], thirdPartySends: [] },
  );
  const r = routeRemedy({ described: d, choice: CHOICE.DOCUMENT, now: NOW });
  assert.deepStrictEqual(r.remedies.map((x) => x.remedy), [REMEDY.UPDATE_FIELD]);
});

test('"neither" requires a value and then routes it like any correction', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const bad = routeRemedy({ described: d, choice: CHOICE.OTHER, now: NOW });
  assert.strictEqual(bad.ok, false);
  const good = routeRemedy({ described: d, choice: CHOICE.OTHER, value: 'Jennifer A. Whyte', now: NOW });
  assert.ok(good.ok);
  assert.strictEqual(good.correct_value, 'Jennifer A. Whyte');
  assert.ok(good.remedies.some((x) => x.remedy === REMEDY.AMENDMENT));
});

test('"not now" resolves nothing and writes no resolution record', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const r = routeRemedy({ described: d, choice: CHOICE.NOT_NOW, now: NOW });
  assert.strictEqual(r.resolved, false);
  assert.strictEqual(r.resolution_record, null);
  assert.deepStrictEqual(r.remedies, []);
});

test('an unknown choice is refused rather than guessed', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const r = routeRemedy({ described: d, choice: 'whatever', now: NOW });
  assert.strictEqual(r.ok, false);
});

// ---------------------------------------------------------------------------
// SURFACING IS NOT NAGGING
// ---------------------------------------------------------------------------

test('raised once on deal open, silent on the second open', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const first = shouldSurface({ described: d, ledgerEntry: null, trigger: 'deal_open', now: NOW });
  assert.strictEqual(first.surface, true);
  assert.strictEqual(first.reason, 'not_raised_before');

  const second = shouldSurface({
    described: d,
    ledgerEntry: { first_raised_at: NOW, raise_count: 1, last_severity: 'critical' },
    trigger: 'deal_open',
    now: '2026-09-21T09:00:00Z',
  });
  assert.strictEqual(second.surface, false);
  assert.strictEqual(second.reason, 'already_raised_and_unchanged');
});

test('the document gate ignores the ledger — it speaks every time', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const v = shouldSurface({
    described: d,
    ledgerEntry: { first_raised_at: NOW, raise_count: 9, last_severity: 'critical' },
    trigger: 'document_gate',
    now: '2026-09-25T09:00:00Z',
  });
  assert.strictEqual(v.surface, true);
  assert.strictEqual(v.blocking, true);
  assert.strictEqual(v.reason, 'about_to_be_used_in_a_document');
});

test('escalation re-raises even when already mentioned', () => {
  const d = describeConflict(NOPALITO_CONFLICT, NOPALITO_EVIDENCE);
  const v = shouldSurface({
    described: d,
    ledgerEntry: { first_raised_at: NOW, raise_count: 1, last_severity: 'normal' },
    trigger: 'deal_open',
    now: '2026-09-21T09:00:00Z',
  });
  assert.strictEqual(v.surface, true);
  assert.strictEqual(v.reason, 'severity_escalated');
});

test('an already-resolved conflict is never raised again', () => {
  const id = conflictId(NOPALITO_CONFLICT);
  const review = reviewDeal({
    conflicts: [NOPALITO_CONFLICT],
    evidenceFor: () => NOPALITO_EVIDENCE,
    resolutions: [{ conflict_id: id, choice: CHOICE.SAME }],
    trigger: 'deal_open',
    now: NOW,
  });
  assert.deepStrictEqual(review.raise, []);
  assert.strictEqual(review.held[0].reason, 'already_resolved');
});

test("Heath's hand-written _resolved_by_heath entries count as answered", () => {
  // The live Nopalito row's legacy entry: { on, note, column: 'seller_name' }
  // — no conflict_id, and a sibling entry in the same array uses `field`
  // instead of `column`. Both shapes must be honoured.
  const byColumn = reviewDeal({
    conflicts: [{ ...NOPALITO_CONFLICT, column: 'seller_name' }],
    evidenceFor: () => NOPALITO_EVIDENCE,
    resolutions: [{ on: '2026-09-20', column: 'seller_name', note: "'Jenny' is Jennifer." }],
    trigger: 'deal_open', now: NOW,
  });
  assert.deepStrictEqual(byColumn.raise, []);

  const byField = reviewDeal({
    conflicts: [{ ...NOPALITO_CONFLICT, column: 'buyer_name' }],
    evidenceFor: () => NOPALITO_EVIDENCE,
    resolutions: [{ on: '2026-09-20', field: 'buyer_name', note: 'same pair' }],
    trigger: 'deal_open', now: NOW,
  });
  assert.deepStrictEqual(byField.raise, []);
});

test('the document gate only asks about fields that document actually uses', () => {
  const review = reviewDeal({
    conflicts: [NOPALITO_CONFLICT],
    evidenceFor: () => NOPALITO_EVIDENCE,
    trigger: 'document_gate',
    aboutToUseColumns: ['sale_price', 'closing_date'],
    now: NOW,
  });
  assert.deepStrictEqual(review.raise, []);
  assert.strictEqual(review.held[0].reason, 'not_a_field_this_document_uses');
});

test('worst first, and multiple conflicts collapse into one line', () => {
  const minor = {
    column: 'buyer_name', party: 'buyer', kind: 'name',
    existing: 'Clark Champie', parsed: 'Clark L. Champie',
    document: { document_id: 'd2', file_name: 'y.pdf' },
  };
  const review = reviewDeal({
    conflicts: [minor, NOPALITO_CONFLICT],
    evidenceFor: (c) => (c.column === 'seller2_name'
      ? NOPALITO_EVIDENCE
      : { dossierValue: 'Clark Champie', documents: [{ document_id: 'd2', file_name: 'y.pdf', executed: false }] }),
    trigger: 'deal_open', now: NOW,
  });
  assert.strictEqual(review.raise[0].column, 'seller2_name');
  assert.strictEqual(review.raise[0].severity, 'critical');
  const { speak } = require('./inconsistency-flow');
  const line = speak(review);
  assert.match(line, /Jennifer Whyte/);
});

test('a structural conflict has no "which is right" and is not answerable', () => {
  const d = describeConflict({
    kind: 'agent_block_ambiguous',
    detail: 'Both broker blocks came back as andyramz90@gmail.com.',
    parsed: 'andyramz90@gmail.com',
  }, {});
  assert.strictEqual(d.answerable, false);
  assert.deepStrictEqual(d.choices, []);
  assert.strictEqual(d.severity, 'high');
});

test('nothing to say means nothing said', () => {
  const { speak } = require('./inconsistency-flow');
  assert.strictEqual(speak({ raise: [] }), null);
  assert.strictEqual(speak(null), null);
});

test('conflict ids are stable and content-derived, not positional', () => {
  assert.strictEqual(conflictId(NOPALITO_CONFLICT), conflictId({ ...NOPALITO_CONFLICT }));
  assert.notStrictEqual(conflictId(NOPALITO_CONFLICT), conflictId({ ...NOPALITO_CONFLICT, parsed: 'Jenni Whyte' }));
});

// ---------------------------------------------------------------------------
// The live 29046 Pfeiffers Gate case — combined-name form
// ---------------------------------------------------------------------------

test('Pfeiffers: contract lists both buyers combined, dossier splits them', () => {
  // transactions cf5e4638-…, buyer_name='Andres Ramirez', buyer2_name='Vanessa
  // Ramirez'. Heath's note: "Andres and Vanessa Ramirez on the contract is the
  // same pair as the dossier's two names."
  const c = {
    column: 'buyer_name', party: 'buyer', kind: 'name',
    existing: 'Andres Ramirez',
    parsed: 'Andres Ramirez, Vanessa Ramirez',
    parsed_all: ['Andres Ramirez', 'Vanessa Ramirez'],
    document: { document_id: '02480488-35aa-4ea5-81d9-9c03a8ebc420', file_name: 'Contract_ts09112.pdf', document_label: 'trec-20-17' },
  };
  const d = describeConflict(c, {
    dossierValue: 'Andres Ramirez',
    documents: [{ document_id: '02480488-35aa-4ea5-81d9-9c03a8ebc420', file_name: 'Contract_ts09112.pdf', label: 'the contract', executed: false }],
    thirdPartySends: [],
  });
  assert.strictEqual(d.difference, 'extra_party');
  assert.ok(['high', 'critical'].includes(d.severity));
  // "Same pair" — Heath's actual answer — must not generate paperwork.
  const r = routeRemedy({ described: d, choice: CHOICE.SAME, now: NOW });
  assert.deepStrictEqual(r.remedies.map((x) => x.remedy), [REMEDY.RECORD_EQUIVALENCE]);
});
