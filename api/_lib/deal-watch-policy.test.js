'use strict';

// api/_lib/deal-watch-policy.test.js
//
// Run: node --test api/_lib/deal-watch-policy.test.js
//
// The alert path is the thing that decides whether this feature survives
// contact with a real user, so it gets exercised rather than reasoned about.
// That distinction is not academic here: the daily regression suite stayed
// broken for two months precisely because its alert path was only ever
// reasoned about.
//
// The fixtures at the bottom are REAL shapes pulled from the live Supabase
// project on 2026-09-20 (88 Amberwood Ln, 14 Sablewood, 930 Alamo Heights
// Blvd), with addresses kept and bodies truncated. Replaying them is what
// turned up the day-one flood the baseline gate now prevents.

const test = require('node:test');
const assert = require('node:assert');

const { observeDeal, rollUpMissingContacts } = require('./deal-watch-observe.js');
const { decideFact, decideRun, composeNotification, MAX_SPOKEN_PER_RUN } = require('./deal-watch-policy.js');

const NOW = Date.parse('2026-09-20T12:00:00Z');
const TODAY = '2026-09-20';

// ---------------------------------------------------------------------------
// Gate 1 — baseline
// ---------------------------------------------------------------------------

test('first run for a member records everything and announces nothing', () => {
  const obs = [
    { factKey: 'a', dealId: 'd1', consequence: 'critical', observedAt: '2026-09-19T00:00:00Z' },
    { factKey: 'b', dealId: 'd1', consequence: 'high', observedAt: '2026-09-19T00:00:00Z' },
  ];
  const r = decideRun({ observations: obs, isBaselineRun: true, notifyEnabled: true });
  assert.strictEqual(r.spoken.length, 0, 'a baseline run must never speak');
  assert.strictEqual(r.silent, true);
  assert.ok(r.decisions.every((d) => d.outcome === 'baseline'));
});

test('a fact that predates the baseline is backlog, not news', () => {
  const d = decideFact({
    observation: { factKey: 'x', dealId: 'd1', consequence: 'critical', observedAt: '2026-08-01T00:00:00Z' },
    baselineAt: '2026-09-01T00:00:00Z',
    notifyEnabled: true,
  });
  assert.strictEqual(d.speak, false);
  assert.strictEqual(d.outcome, 'baseline');
});

test('a fact that postdates the baseline is eligible', () => {
  const d = decideFact({
    observation: { factKey: 'x', dealId: 'd1', consequence: 'critical', observedAt: '2026-09-15T00:00:00Z' },
    baselineAt: '2026-09-01T00:00:00Z',
    notifyEnabled: true,
  });
  assert.strictEqual(d.speak, true);
  assert.strictEqual(d.outcome, 'spoken');
});

// ---------------------------------------------------------------------------
// Gate 2 — say it once
// ---------------------------------------------------------------------------

test('a fact already in the ledger is never spoken again', () => {
  const o = { factKey: 'awaiting:d1:pkt:high', dealId: 'd1', consequence: 'high', observedAt: '2026-09-19T00:00:00Z' };
  const d = decideFact({ observation: o, knownFactKeys: new Set(['awaiting:d1:pkt:high']), notifyEnabled: true });
  assert.strictEqual(d.speak, false);
});

test('SIX CONSECUTIVE MORNINGS produce exactly ONE alert, not six', () => {
  // The literal anti-pattern from the brief: "Wesley still hasn't sent it"
  // every morning for six days.
  const known = new Set();
  let alerts = 0;
  for (let day = 0; day < 6; day += 1) {
    const o = { factKey: 'awaiting:d1:wesley:high', dealId: 'd1', consequence: 'high', observedAt: '2026-09-14T00:00:00Z' };
    const r = decideRun({
      observations: [o], knownFactKeys: known, baselineAt: '2026-09-13T00:00:00Z', notifyEnabled: true,
    });
    alerts += r.spoken.length;
    for (const s of r.spoken) known.add(s.observation.factKey);
  }
  assert.strictEqual(alerts, 1, 'the same unchanged fact must speak exactly once across six runs');
});

test('the one permitted escalation: routine item becomes urgent as the clock closes', () => {
  // Same underlying obligation, different consequence tier because the option
  // period is now days away. This is the product, and it must still be
  // bounded to one utterance per tier.
  const known = new Set();
  let alerts = 0;

  const routine = { factKey: 'awaiting:d1:wesley:normal', dealId: 'd1', consequence: 'normal', observedAt: '2026-09-14T00:00:00Z' };
  let r = decideRun({ observations: [routine], knownFactKeys: known, baselineAt: '2026-09-13T00:00:00Z', notifyEnabled: true });
  alerts += r.spoken.length;
  assert.strictEqual(r.spoken.length, 0, 'normal consequence stays quiet');

  const urgent = { factKey: 'awaiting:d1:wesley:critical', dealId: 'd1', consequence: 'critical', observedAt: '2026-09-14T00:00:00Z' };
  for (let day = 0; day < 4; day += 1) {
    r = decideRun({ observations: [urgent], knownFactKeys: known, baselineAt: '2026-09-13T00:00:00Z', notifyEnabled: true });
    alerts += r.spoken.length;
    for (const s of r.spoken) known.add(s.observation.factKey);
  }
  assert.strictEqual(alerts, 1, 'escalation speaks once, then goes quiet again');
});

// ---------------------------------------------------------------------------
// Gate 3 — consequence
// ---------------------------------------------------------------------------

test('normal and low are recorded but never interrupt a day', () => {
  for (const tier of ['normal', 'low']) {
    const d = decideFact({
      observation: { factKey: `k-${tier}`, dealId: 'd1', consequence: tier, observedAt: '2026-09-19T00:00:00Z' },
      baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true,
    });
    assert.strictEqual(d.speak, false, `${tier} must not speak`);
    assert.strictEqual(d.outcome, 'skipped_below_threshold');
  }
});

test('a missed option deadline outranks a cosmetic gap', () => {
  const critical = { factKey: 'c', dealId: 'd1', consequence: 'critical', observedAt: '2026-09-10T00:00:00Z' };
  const low = { factKey: 'l', dealId: 'd1', consequence: 'low', observedAt: '2026-09-19T00:00:00Z' };
  const r = decideRun({ observations: [low, critical], baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true });
  assert.strictEqual(r.spoken.length, 1);
  assert.strictEqual(r.spoken[0].observation.factKey, 'c', 'recency must never promote a cheap fact over an expensive one');
});

// ---------------------------------------------------------------------------
// Gate 4 — dormancy and cap
// ---------------------------------------------------------------------------

test('a dormant deal is archaeology, not an emergency', () => {
  const d = decideFact({
    observation: { factKey: 'x', dealId: 'd1', consequence: 'critical', observedAt: '2026-09-19T00:00:00Z' },
    dormant: true, baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true,
  });
  assert.strictEqual(d.speak, false);
  assert.strictEqual(d.outcome, 'skipped_dormant');
});

test('no member hears more than the per-run cap', () => {
  const obs = Array.from({ length: 9 }, (_, i) => ({
    factKey: `k${i}`, dealId: `d${i}`, consequence: 'critical', observedAt: '2026-09-19T00:00:00Z',
  }));
  const r = decideRun({ observations: obs, baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true });
  assert.strictEqual(r.spoken.length, MAX_SPOKEN_PER_RUN);
  assert.strictEqual(r.summary.capped, 9 - MAX_SPOKEN_PER_RUN);
});

// ---------------------------------------------------------------------------
// Silence, and the switch
// ---------------------------------------------------------------------------

test('a quiet morning says nothing at all', () => {
  const r = decideRun({ observations: [], baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true });
  assert.strictEqual(r.silent, true);
  assert.strictEqual(composeNotification(r.spoken), null, 'silence must produce no message object at all');
});

test('the flag gates delivery only — ranking still runs, so a dry run previews live behaviour', () => {
  const o = { factKey: 'k', dealId: 'd1', consequence: 'critical', observedAt: '2026-09-19T00:00:00Z' };
  const off = decideRun({ observations: [o], baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: false });
  assert.strictEqual(off.spoken.length, 0);
  assert.strictEqual(off.decisions[0].outcome, 'skipped_disabled');

  const on = decideRun({ observations: [o], baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true });
  assert.strictEqual(on.spoken.length, 1, 'same fact, same ranking — only delivery differs');
});

// ---------------------------------------------------------------------------
// REPLAY AGAINST REAL DEAL DATA (live Supabase rows, 2026-09-20)
// ---------------------------------------------------------------------------

// 88 Amberwood Ln — transaction 42a11919, stage 'financing', five filed
// party replies, every one of them read:false. Verbatim shapes from notes_log.
const WILD_CHERRY = {
  id: '42a11919-ba8b-44fa-9b04-ed13563ab888',
  user_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  property_address: '88 Amberwood Ln',
  status: 'active',
  stage: 'financing',
  seller_email: 'ghaletx@mail.example',
  updated_at: '2026-09-17T21:40:09Z',
  closing_date: '2026-09-30',
  notes_log: [
    { id: 'email-1a05d726033ce2db', read: false, source: 'email', subject: 'disclosures',
      fromName: 'Heather Mutz', fromEmail: 'heathermutz@homesteadandranch.com',
      createdAt: '2026-09-01T14:49:20.000Z', gmailMessageId: '1a05d726033ce2db',
      text: 'Heather Mutz has sent disclosure documents from zipForm for the transaction.' },
    { id: 'email-1a045e038c9850e6', read: false, source: 'email', subject: 'Re: 8/27/2026 - well shock by buyer',
      fromName: 'Greg Hale', fromEmail: 'ghaletx@mail.example',
      createdAt: '2026-08-28T00:58:26.000Z', gmailMessageId: '1a045e038c9850e6',
      text: 'Seller Greg Hale is documenting that the home inspector performed an unsolicited well shock treatment...' },
    { id: 'email-1a025f363f090b4b', read: false, source: 'email', subject: 'Re: GF 70378 / 88 Amberwood Lane',
      fromName: 'Greg Hale', fromEmail: 'ghaletx@mail.example',
      createdAt: '2026-08-21T20:11:28.000Z', gmailMessageId: '1a025f363f090b4b',
      text: 'Tom is questioning whether the seller needs to provide the current mortgage payoff information now...' },
  ],
};

// 14 Sablewood — transaction 952e0d82. A live $1,295,000 listing with
// parties = {}, every counterparty email NULL, no seller's disclosure, and
// untouched since 2026-08-09. This is the deal from the brief.
const SABLEWOOD = {
  id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  user_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  property_address: '14 Sablewood',
  status: 'active',
  stage: 'active-listing',
  sale_price: 1295000,
  parties: {},
  seller_email: null,
  other_agent_email_addr: null,
  title_officer_email: null,
  sellers_disclosure_received_at: null,
  sdn_received: false,
  updated_at: '2026-08-09T16:47:44Z',
  notes_log: [],
};

// 930 Alamo Heights Blvd — option expired 2026-07-25, closing 2026-09-01,
// still stage 'under-contract', untouched since 2026-08-17. One of the 17
// past-closing rows that a naive watcher would have shouted about.
const STALE_DEAL = {
  id: 'd0de853e-0331-4b0b-8173-9f0e86d37497',
  user_id: '2a98678e-4b36-4e56-86d5-f55ac1291dc0',
  property_address: '930 Alamo Heights Blvd',
  status: 'active',
  stage: 'under-contract',
  seller_email: 'seller@example.com',
  option_expiration_date: '2026-07-25',
  closing_date: '2026-09-01',
  updated_at: '2026-08-17T21:47:13Z',
  notes_log: [],
};

test('REAL DATA: 14 Sablewood is reported as unwatchable, with the reason', () => {
  const { observations } = observeDeal({ deal: SABLEWOOD, todayYmd: TODAY, nowMs: NOW });
  const blind = observations.find((o) => o.kind === 'missing_contacts');
  assert.ok(blind, 'a deal with no counterparty addresses must report that it cannot be watched');
  assert.match(blind.headline, /can't watch 14 Sablewood/);

  // Per-deal it is recorded but NOT announced — nine blind deals are one
  // problem, not nine notifications. The member-level roll-up is what speaks.
  assert.strictEqual(blind.consequence, 'low', 'the per-deal row is ledger-only');

  const rolled = rollUpMissingContacts(observations);
  const rollup = rolled.find((o) => o.kind === 'missing_contacts' && o.consequence === 'high');
  assert.ok(rollup, 'the member-level roll-up is the thing that speaks');
  assert.match(rollup.headline, /can't watch 14 Sablewood/);
  assert.strictEqual(rollup.exemptFromDormancy, true,
    'a deal that is invisible can never look "recently updated" — the dormancy gate must not suppress its own cause');

  const sdn = observations.find((o) => o.kind === 'missing_required');
  assert.ok(sdn, 'a live listing with no seller\'s disclosure must be noticed');
});

test('the roll-up names the most consequential deal first, by stage then by price', () => {
  const mk = (addr, stage, price) => ({
    id: addr, user_id: 'u1', property_address: addr, status: 'active', stage,
    sale_price: price, parties: {}, notes_log: [], updated_at: '2026-09-01T00:00:00Z',
  });
  const obs = [];
  for (const d of [
    mk('14 Sablewood', 'active-listing', 1295000),
    mk('130 Senisa Dr', 'active-listing', 389000),
    mk('9 Small Lead', 'pre-contract', 200000),
  ]) obs.push(...observeDeal({ deal: d, todayYmd: TODAY, nowMs: NOW }).observations);

  const rollup = rollUpMissingContacts(obs).find((o) => o.consequence === 'high');
  assert.match(rollup.headline, /3 of your deals/);
  assert.match(rollup.detail, /14 Sablewood/, 'the $1.295M listing must be the one named, not a smaller one at the same stage');
  assert.match(rollup.detail, /\$1,295,000/);
});

test('REAL DATA: the day-one flood is prevented — baseline run is silent across all three deals', () => {
  const all = [];
  for (const deal of [WILD_CHERRY, SABLEWOOD, STALE_DEAL]) {
    all.push(...observeDeal({ deal, todayYmd: TODAY, nowMs: NOW }).observations);
  }
  assert.ok(all.length > 0, 'there ARE facts here — the point is that none are announced on day one');

  const r = decideRun({ observations: all, isBaselineRun: true, notifyEnabled: true });
  assert.strictEqual(r.spoken.length, 0);
  assert.strictEqual(r.summary.baseline, all.length);
});

test('REAL DATA: after baseline, pre-existing replies stay quiet and only genuinely new ones speak', () => {
  const { observations } = observeDeal({ deal: WILD_CHERRY, todayYmd: TODAY, nowMs: NOW });
  // Baseline taken after every filed reply on this deal.
  const r = decideRun({
    observations, baselineAt: '2026-09-19T00:00:00Z', notifyEnabled: true,
  });
  assert.strictEqual(r.spoken.length, 0, 'five standing unread replies must not become five alerts');
  assert.strictEqual(r.silent, true);
});

test('REAL DATA: 930 Alamo Heights is dormant — its stale deadlines never reach the member', () => {
  const { dormant, dormantDays } = observeDeal({ deal: STALE_DEAL, todayYmd: TODAY, nowMs: NOW });
  assert.strictEqual(dormant, true, `untouched for ${dormantDays} days`);

  const o = { factKey: 'x', dealId: STALE_DEAL.id, consequence: 'critical', observedAt: '2026-09-19T00:00:00Z' };
  const r = decideRun({
    observations: [o], dormantDealIds: new Set([STALE_DEAL.id]),
    baselineAt: '2026-09-01T00:00:00Z', notifyEnabled: true,
  });
  assert.strictEqual(r.spoken.length, 0);
});

test('REAL DATA: a NEW reply on a live file, arriving after baseline, does speak', () => {
  const fresh = JSON.parse(JSON.stringify(WILD_CHERRY));
  fresh.notes_log.unshift({
    id: 'email-newreply001', read: false, source: 'email',
    subject: 'Re: tax exemptions at closing',
    fromName: 'Greg Hale', fromEmail: 'ghaletx@mail.example',
    createdAt: '2026-09-19T15:02:00.000Z', gmailMessageId: 'newreply001',
    text: 'Confirming the homestead and over-65 exemptions were never transferred, so the buyer should expect the higher assessed amount at closing.',
  });

  const { observations } = observeDeal({ deal: fresh, todayYmd: TODAY, nowMs: NOW });
  const r = decideRun({ observations, baselineAt: '2026-09-18T00:00:00Z', notifyEnabled: true });

  assert.strictEqual(r.spoken.length, 1, 'exactly the one new fact');
  const msg = composeNotification(r.spoken);
  assert.match(msg, /Greg Hale replied on 88 Amberwood Ln/);
  assert.match(msg, /I have not contacted anyone/, 'the notify-not-act contract must be visible in the message');
});

test('a message never implies the watcher contacted anyone', () => {
  const msg = composeNotification([{ observation: {
    headline: 'Wesley hasn\'t returned the signature packet on 507 Ridge Blf',
    consequence: 'critical', deadlineText: 'the option period ends in 3 days',
    detail: 'Sent 6 days ago, still pending.', observedAt: '2026-09-14T00:00:00Z',
  } }]);
  assert.match(msg, /option period ends in 3 days/);
  assert.doesNotMatch(msg, /\b(I sent|I emailed|I chased|I followed up with)\b/i);
});
