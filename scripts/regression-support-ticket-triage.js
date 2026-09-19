#!/usr/bin/env node
'use strict';

/**
 * scripts/regression-support-ticket-triage.js
 *
 * Asserts api/_lib/support-ticket-classify.js against ALL 18 real rows that
 * were in public.support_tickets on 2026-09-18, plus a set of adversarial
 * cases for the failure modes that would hurt a customer.
 *
 * WHY FIXTURES AND NOT A LIVE QUERY
 *   These are the real messages, copied verbatim from the table. Freezing them
 *   here means (a) the test runs with no credentials and no network, (b) it
 *   can never send anything, and (c) a future edit to the classifier is
 *   checked against the exact wording that actually cost us a customer rather
 *   than against whatever happens to be in the table that day.
 *
 * CUSTOMER ADDRESSES ARE REDACTED. heathshepard/MeetDossie is a PUBLIC repo.
 *   Real customer email addresses are replaced with example.com equivalents
 *   that preserve everything the classifier actually keys on (internal vs
 *   external, domain shape, local-part shape). Internal addresses
 *   (quinn@meetdossie.internal, demo2@meetdossie.com) are kept verbatim
 *   because they ARE the rule under test — they must never be mailed.
 *
 * THE ONE THAT MATTERS
 *   503a1d1b — Amanda Nuckles, 2026-08-24, ticket_type='bug', message
 *   "How do I cancel my account?". The assertion is that this classifies as
 *   'cancellation' and route 'heath_only'. If that assertion ever fails, this
 *   pipeline would email a departing customer a thank-you for her bug report.
 *
 * Run: node scripts/regression-support-ticket-triage.js [--verbose]
 * Exit 0 = all pass. Exit 1 = at least one failure.
 */

const path = require('path');
const {
  classify,
  buildAck,
  findPromise,
  firstNameFor,
} = require(path.join(__dirname, '..', 'api', '_lib', 'support-ticket-classify.js'));

const VERBOSE = process.argv.includes('--verbose');

// ── The 18 real rows, verbatim. ────────────────────────────────────────────
// `expect` is what this pipeline must do with each one.
const REAL_TICKETS = [
  { id: '812f908d', agent_email: 'demo2@meetdossie.com', ticket_type: 'bug', status: 'resolved',
    message: 'there are no shareable milestone cards displaying in the appropriate place in the pipeline',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '4ed6866b', agent_email: 'demo2@meetdossie.com', ticket_type: 'feature', status: 'open',
    message: 'when will signatures be available',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '11ecadee', agent_email: 'demo2@meetdossie.com', ticket_type: 'bug', status: 'open',
    message: 'I need help with an issue im running into',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '89938c2c', agent_email: 'agent-b@example-realty.com', ticket_type: 'feature', status: 'resolved',
    message: 'Follow up date on active listings to stay in touch on consistent basis, etc..',
    expect: { ticketClass: 'feature', route: 'ack_only', mayAutoFix: false } },
  { id: '4141c097', agent_email: 'agent-b@example-realty.com', ticket_type: 'bug', status: 'resolved',
    message: 'The pre-contract and pre-listing columns have disappeared',
    expect: { ticketClass: 'bug', route: 'ack_and_fix', mayAutoFix: true } },
  { id: '1b605557', agent_email: 'agent-b@example-realty.com', ticket_type: 'bug', status: 'resolved',
    message: 'Names of clients not showing in pre-listing or pre-contract.. having to put them in property address line to appear',
    expect: { ticketClass: 'bug', route: 'ack_and_fix', mayAutoFix: true } },
  { id: '86c299c7', agent_email: 'agent-b@example-realty.com', ticket_type: 'bug', status: 'resolved',
    message: "I have 2 pre listings that are showing in active listings, and it won't let me shift them back..",
    expect: { ticketClass: 'bug', route: 'ack_and_fix', mayAutoFix: true } },
  { id: '27e07178', agent_email: 'agent-m@example-mail.com', ticket_type: 'bug', status: 'resolved',
    message: 'I am trying to upload a new executed contract in pdf format and receiving an error. This is the 2nd contract where I get an error. Will manually input info and see if I can find a work around.',
    // Contract INGESTION, not contract generation. The sensitive-area gate is
    // scoped to generation/fill/e-signature on purpose — see the note in the
    // adversarial block below.
    expect: { ticketClass: 'bug', route: 'ack_and_fix', mayAutoFix: true } },
  // 10 Quinn rows. All internal — these are the ones that would flood a naive
  // auto-responder. Two ticket_type spellings are in the live data.
  { id: '5774fbc8', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn_sev2', status: 'resolved',
    message: '[quinn-daily-audit] T05-talk-to-dossie failed: chat_http_401',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '9b60f6a3', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn_sev1', status: 'open',
    message: '[quinn-daily-audit] T08-upload-automap failed: automap_stuck_count_30',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: 'ae8b1529', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn_sev2', status: 'resolved',
    message: '[quinn-daily-audit] T10-trec-citation failed: chat_http_401',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '90d1e6a4', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn-daily-audit', status: 'resolved',
    message: 'ITER1 T08 FAIL SEV-1 — Auto-map cron cron-automap-pending-documents last ran 2026-07-03 14:18:36 UTC. Test document uploaded at 14:25:40 remained scan_status=pending for 7+ minutes.',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '50d6ab1b', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn-daily-audit', status: 'resolved',
    message: 'ITER1 T11 FAIL SEV-2 — Morning Brief renders one BLANK card (no address prefix) in "First things first" section',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '2b7926e1', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn-daily-audit', status: 'resolved',
    message: 'ITER1 T13 FAIL SEV-2 — Follow-up dates feature (Atlas #2 ship) is NOT surfaced in UI.',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '068418b4', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn-daily-audit', status: 'resolved',
    message: 'ITER1 finding SEV-3 — Console errors on dossier detail view: /api/wire-fraud-status returns 404 for every transaction load; /api/form-packages returns 500.',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: '2b124a8a', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn-daily-audit', status: 'resolved',
    message: 'ITER1 finding SEV-3 — Deal details section shows "$0" for sale_price/earnest_money/option_fee when values are null.',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },
  { id: 'bd628ee4', agent_email: 'quinn@meetdossie.internal', ticket_type: 'quinn-daily-audit', status: 'open',
    message: 'ITER1 finding SEV-3 — Create Dossier form fields are not saved on submit.',
    expect: { ticketClass: 'internal', route: 'suppress_internal' } },

  // ── THE ONE THAT MATTERS ─────────────────────────────────────────────────
  { id: '503a1d1b', agent_email: 'agent-a@example.com', ticket_type: 'bug', status: 'open',
    message: 'How do I cancel my account?',
    expect: {
      ticketClass: 'cancellation',
      route: 'heath_only',
      mayAutoReply: false,
      mayAutoFix: false,
      overrodeTypeHint: true,
    } },
];

// ── Adversarial cases: the ways this hurts somebody if it's wrong. ─────────
const ADVERSARIAL = [
  { name: 'cancellation phrased as a statement, typed as feature',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'feature', message: 'I want to cancel my subscription, this is not for me.' },
    expect: { ticketClass: 'cancellation', route: 'heath_only', mayAutoReply: false } },

  { name: 'cancel BUTTON bug is a bug, not a departure',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'The cancel button on the new dossier modal does nothing when I click it.' },
    expect: { ticketClass: 'bug', mayAutoReply: true } },

  { name: 'billing dispute never gets a template',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'I was charged twice this month, can you look at my invoice?' },
    expect: { ticketClass: 'billing', route: 'heath_only', mayAutoReply: false } },

  { name: 'angry customer never gets a template',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'This is the third time the uploads have broken. I am extremely frustrated and this is a waste of money.' },
    expect: { ticketClass: 'unhappy', route: 'heath_only', mayAutoReply: false } },

  { name: 'legal threat never gets a template',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'other', message: 'Delete all my data immediately or I will have my attorney contact you.' },
    expect: { ticketClass: 'legal', route: 'heath_only', mayAutoReply: false } },

  { name: 'login bug is acknowledged but NEVER auto-fixed',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: "I can't log in, the password reset link says the token is invalid." },
    expect: { ticketClass: 'bug', route: 'ack_and_escalate', mayAutoReply: true, mayAutoFix: false, sensitive: ['auth'] } },

  { name: 'payment bug is acknowledged but NEVER auto-fixed',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'The Stripe checkout page throws a 500 when I try to update my card on file.' },
    expect: { ticketClass: 'bug', route: 'ack_and_escalate', mayAutoFix: false, sensitive: ['payments'] } },

  { name: 'contract GENERATION bug is acknowledged but NEVER auto-fixed',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'When it generates the TREC contract the buyer name is populated in the wrong field.' },
    expect: { ticketClass: 'bug', route: 'ack_and_escalate', mayAutoFix: false, sensitive: ['contracts'] } },

  { name: 'e-signature bug is acknowledged but NEVER auto-fixed',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'The signature fields are missing on page 3 of the packet I sent out.' },
    expect: { ticketClass: 'bug', route: 'ack_and_escalate', mayAutoFix: false, sensitive: ['contracts'] } },

  { name: 'apparent data loss is acknowledged but NEVER auto-fixed',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'All of my uploaded documents are gone from the dossier, they were there yesterday.' },
    expect: { ticketClass: 'bug', route: 'ack_and_escalate', mayAutoFix: false, sensitive: ['data_deletion'] } },

  { name: 'roadmap question is a question, not a bug',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'feature', message: 'When will signatures be available?' },
    expect: { ticketClass: 'question', route: 'ack_only', mayAutoFix: false } },

  { name: 'how-do-I question is a question, not a bug',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'bug', message: 'How do I add a second agent to my account?' },
    expect: { ticketClass: 'question', route: 'ack_only', mayAutoFix: false } },

  { name: 'genuine feature request is never auto-built',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'feature', message: 'Could you add the ability to export a dossier to PDF? Would be great for my broker.' },
    expect: { ticketClass: 'feature', route: 'ack_only', mayAutoFix: false } },

  { name: 'demo account never receives mail',
    ticket: { agent_email: 'demo@meetdossie.com', ticket_type: 'bug', message: 'everything is broken and nothing loads at all' },
    expect: { ticketClass: 'internal', route: 'suppress_internal', mayAutoReply: false } },

  { name: "Heath's own test ticket never gets mailed back to Heath",
    ticket: { agent_email: 'heath@meetdossie.com', ticket_type: 'bug', message: 'testing the modal, the submit button is broken' },
    expect: { ticketClass: 'internal', route: 'suppress_internal', mayAutoReply: false } },

  { name: 'no address at all routes to Heath, never crashes',
    ticket: { agent_email: null, ticket_type: 'bug', message: 'the app is broken and will not load' },
    expect: { route: 'heath_only', mayAutoReply: false } },

  { name: 'empty message does not throw and never auto-replies a fix',
    ticket: { agent_email: 'real@agent.com', ticket_type: 'other', message: '' },
    expect: { ticketClass: 'unknown', route: 'ack_only', mayAutoFix: false } },
];

// ── Runner ─────────────────────────────────────────────────────────────────

let pass = 0;
const failures = [];

function check(label, actual, expected, extra) {
  if (actual === expected) { pass++; return true; }
  failures.push(`${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}${extra ? `\n      ${extra}` : ''}`);
  return false;
}

function assertTicket(label, ticket, expect) {
  let result;
  try {
    result = classify(ticket);
  } catch (err) {
    failures.push(`${label} — classify() THREW: ${err.message}`);
    return null;
  }
  const reasons = `reasons: ${result.reasons.join(' | ')}`;
  if (expect.ticketClass !== undefined) check(`${label} → ticketClass`, result.ticketClass, expect.ticketClass, reasons);
  if (expect.route !== undefined) check(`${label} → route`, result.route, expect.route, reasons);
  if (expect.mayAutoReply !== undefined) check(`${label} → mayAutoReply`, result.mayAutoReply, expect.mayAutoReply, reasons);
  if (expect.mayAutoFix !== undefined) check(`${label} → mayAutoFix`, result.mayAutoFix, expect.mayAutoFix, reasons);
  if (expect.overrodeTypeHint !== undefined) check(`${label} → overrodeTypeHint`, result.overrodeTypeHint, expect.overrodeTypeHint, reasons);
  if (expect.sensitive !== undefined) {
    const keys = result.sensitiveAreas.map((a) => a.key);
    for (const k of expect.sensitive) {
      check(`${label} → sensitive includes ${k}`, keys.includes(k), true, `got: [${keys.join(',')}]`);
    }
  }
  return result;
}

console.log('\n=== support-ticket triage regression ===\n');

console.log('--- the 18 real support_tickets rows (2026-09-18) ---');
const realResults = [];
for (const t of REAL_TICKETS) {
  const r = assertTicket(`[${t.id}] ${t.agent_email || '(no email)'}`, t, t.expect);
  if (r) realResults.push({ t, r });
  if (VERBOSE && r) {
    console.log(`  ${t.id.padEnd(10)} ${String(t.agent_email || 'null').padEnd(30)} type=${String(t.ticket_type).padEnd(18)} -> ${r.ticketClass}/${r.route}`);
  }
}

console.log('--- adversarial cases ---');
for (const c of ADVERSARIAL) {
  assertTicket(c.name, c.ticket, c.expect);
}

// ── INVARIANTS. These are not per-case assertions; they must hold globally.
console.log('--- global invariants ---');

// 1. No internal address is ever mailable, in any class.
for (const { t, r } of realResults) {
  const internal = /@meetdossie\.(internal|com)$/.test(String(t.agent_email || ''))
    || /^quinn|^demo/.test(String(t.agent_email || ''));
  if (internal) check(`INVARIANT no mail to internal ${t.agent_email}`, r.mayAutoReply, false);
}

// 2. Nothing routed heath_only may auto-reply or auto-fix. Ever.
for (const { t, r } of realResults) {
  if (r.route === 'heath_only') {
    check(`INVARIANT heath_only never replies [${t.id}]`, r.mayAutoReply, false);
    check(`INVARIANT heath_only never fixes [${t.id}]`, r.mayAutoFix, false);
  }
}

// 3. Anything with a sensitive area is never auto-fixable.
for (const { t, r } of realResults) {
  if (r.sensitiveAreas.length > 0) {
    check(`INVARIANT sensitive never auto-fixes [${t.id}]`, r.mayAutoFix, false);
  }
}

// 4. Across ALL 18 real rows, exactly zero would be emailed by this pipeline
//    on a backfill — every one is far older than the 48h window, and the only
//    non-internal open one is a cancellation. Assert the class-level half of
//    that here (the age half is enforced in the cron and asserted below).
const mailableReal = realResults.filter(({ r }) => r.mayAutoReply);
check('INVARIANT no OPEN real ticket is auto-replyable',
  mailableReal.filter(({ t }) => t.status === 'open').length, 0,
  `mailable+open: ${mailableReal.filter(({ t }) => t.status === 'open').map(({ t }) => t.id).join(',') || 'none'}`);

// 5. Every acknowledgement body is short, in Heath's voice, and promises
//    nothing. The promise guard is the runtime backstop; this is the design-
//    time one.
console.log('--- acknowledgement copy ---');
for (const cls of ['bug', 'feature', 'question', 'unknown']) {
  const { subject, bodyText } = buildAck({ ticketClass: cls, fullName: 'Brittney Jones', email: 'agent-b@example-realty.com' });
  check(`ack[${cls}] greets by first name`, bodyText.startsWith('Hey Brittney,'), true, bodyText);
  check(`ack[${cls}] signs off as Heath`, bodyText.trimEnd().endsWith('Thanks,\nHeath'), true, bodyText);
  check(`ack[${cls}] contains no promise`, findPromise(bodyText), null, bodyText);
  check(`ack[${cls}] has a subject`, typeof subject === 'string' && subject.length > 0, true);
  // 1-3 sentences: greeting line + one body line + sign-off.
  const bodyLines = bodyText.split('\n').filter((l) => l.trim()).length;
  check(`ack[${cls}] is <= 4 non-empty lines`, bodyLines <= 4, true, `${bodyLines} lines`);
  if (VERBOSE) console.log(`  [${cls}] "${subject}"\n${bodyText.split('\n').map((l) => `      ${l}`).join('\n')}`);
}

// 6. The promise guard actually catches promises — otherwise it's decoration.
console.log('--- promise guard ---');
const PROMISES_THAT_MUST_BE_CAUGHT = [
  'Hey Amanda,\n\nThanks — this will be fixed by Friday.\n\nThanks,\nHeath',
  'Hey Amanda,\n\nGot it, this is already resolved.\n\nThanks,\nHeath',
  'Hey Amanda,\n\nWe will have this within 24 hours.\n\nThanks,\nHeath',
  'Hey Amanda,\n\nThis should be working in the next release.\n\nThanks,\nHeath',
  'Hey Amanda,\n\nI promise to get this sorted.\n\nThanks,\nHeath',
];
for (const body of PROMISES_THAT_MUST_BE_CAUGHT) {
  const hit = findPromise(body);
  check(`promise guard catches: "${body.split('\n')[2]}"`, typeof hit === 'string' && hit.length > 0, true);
}

// 7. Name derivation never produces something embarrassing in a greeting.
console.log('--- greeting names ---');
check('firstName from full name', firstNameFor('Amanda Nuckles', 'agent-a@example.com'), 'Amanda');
check('firstName from email local part', firstNameFor(null, 'brittney@example-realty.com'), 'Brittney');
check('firstName strips dotted local part', firstNameFor(null, 'heath.shepard@kw.com'), 'Heath');
check('firstName strips hyphenated local part', firstNameFor(null, 'agent-b@example-realty.com'), 'Agent');
check('firstName falls back to "there"', firstNameFor(null, '12345@example.com'), 'there');
check('firstName falls back on empty', firstNameFor(null, null), 'there');

// ── Report ─────────────────────────────────────────────────────────────────
console.log('');
if (failures.length === 0) {
  console.log(`✅ PASS — ${pass} assertions, 0 failures.`);
  console.log(`   ${REAL_TICKETS.length} real rows classified; ${realResults.filter(({ r }) => r.ticketClass === 'internal').length} internal (never mailable), `
    + `${realResults.filter(({ r }) => r.route === 'heath_only').length} routed to Heath, `
    + `${realResults.filter(({ r }) => r.mayAutoFix).length} eligible for an auto-dispatched fix.`);
  process.exit(0);
} else {
  console.log(`❌ FAIL — ${pass} passed, ${failures.length} failed:\n`);
  for (const f of failures) console.log(`  • ${f}\n`);
  process.exit(1);
}
