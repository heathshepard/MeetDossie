#!/usr/bin/env node
// Unit tests for api/_lib/esign-notification-parser.js.
//
// The two Authentisign cases are the CONFIRMED real formats from Heath's live
// 104 Wild Cherry Ln signing on 2026-08-13. The rest guard the normalization
// and the deliberately-conservative deal matching.
//
// Usage: node scripts/carter-esign-parser-test.js

'use strict';

const {
  detectProvider,
  parseEsignNotification,
  matchToDeal,
} = require('../api/_lib/esign-notification-parser');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}

// --- provider detection -----------------------------------------------------
check('authentisign sender detected', detectProvider('secure@authentisign.com') === 'authentisign');
check('docusign sender detected', detectProvider('dse@docusign.net') === 'docusign');
check('docuseal sender detected', detectProvider('noreply@docuseal.com') === 'docuseal');
check('random sender is not an e-sign email', detectProvider('tom@gmail.com') === null);
check('lookalike domain rejected', detectProvider('a@notauthentisign.com.evil.com') === null);

// --- CONFIRMED case 1: participant action ----------------------------------
const updated = parseEsignNotification({
  fromEmail: 'secure@authentisign.com',
  subject: 'Signing updated - Amendment #1 - 104 Wild Cherry Ln',
  body: [
    'A signing you are participating in has been updated.',
    '',
    'Action: Document Accepted',
    'Participant: Thomas Linton',
    'Signing: Amendment #1 - 104 Wild Cherry Ln',
    '',
    'View the signing: https://authentisign.com/signing/abc123',
  ].join('\n'),
  dateIso: '2026-08-13T16:52:00Z',
});
check('CONFIRMED updated: provider', updated && updated.provider === 'authentisign');
check('CONFIRMED updated: action=accepted', updated && updated.action === 'accepted', updated && updated.action);
check('CONFIRMED updated: participant Thomas Linton',
  updated && updated.participantName === 'Thomas Linton', updated && updated.participantName);
check('CONFIRMED updated: not a completion', updated && updated.isCompletion === false);
check('CONFIRMED updated: doc name has address',
  updated && /104 Wild Cherry Ln/i.test(updated.documentName || ''), updated && updated.documentName);

// --- CONFIRMED case 2: completion ------------------------------------------
const complete = parseEsignNotification({
  fromEmail: 'secure@authentisign.com',
  subject: 'Signing complete: Amendment #1 - 104 Wild Cherry Ln',
  body: [
    'All participants have completed the signing.',
    'Signing: Amendment #1 - 104 Wild Cherry Ln',
    '',
    'Download the completed documents: https://authentisign.com/download/xyz789.pdf',
    'This link expires in 7 days.',
    'Unsubscribe: https://authentisign.com/unsubscribe?u=1',
  ].join('\n'),
  dateIso: '2026-08-13T17:54:00Z',
});
check('CONFIRMED complete: action=completed', complete && complete.action === 'completed', complete && complete.action);
check('CONFIRMED complete: isCompletion true', complete && complete.isCompletion === true);
check('CONFIRMED complete: documentName parsed',
  complete && complete.documentName === 'Amendment #1 - 104 Wild Cherry Ln', complete && complete.documentName);
check('CONFIRMED complete: pdf link ranked first',
  complete && /xyz789\.pdf/.test(complete.documentLinks[0] || ''), complete && complete.documentLinks);
check('CONFIRMED complete: unsubscribe link excluded',
  complete && !complete.documentLinks.some((u) => /unsubscribe/i.test(u)), complete && complete.documentLinks);

// --- negative events must not read as benign -------------------------------
const declined = parseEsignNotification({
  fromEmail: 'secure@authentisign.com',
  subject: 'Signing declined - Amendment #1 - 104 Wild Cherry Ln',
  body: 'Action: Declined\nParticipant: Carol Linton',
});
check('declined detected', declined && declined.action === 'declined', declined && declined.action);
check('declined flagged negative', declined && declined.isNegative === true);
check('declined is not a completion', declined && declined.isCompletion === false);

// --- non-esign email returns null ------------------------------------------
check('counterparty email is not parsed as e-sign',
  parseEsignNotification({ fromEmail: 'TomLintonTX@Gmail.com', subject: 'Re: repairs', body: 'signed and sent' }) === null);

// --- deal matching ----------------------------------------------------------
const deals = [
  { id: 'deal-wc', address: '104 Wild Cherry Ln, Boerne, TX 78006' },
  { id: 'deal-np', address: '23 Nopalito, San Antonio, TX 78257' },
];
const m1 = matchToDeal(complete, deals);
check('matches Wild Cherry by address in signing name', m1.deal && m1.deal.id === 'deal-wc', m1);
check('match confidence is high', m1.confidence === 'high', m1.confidence);

const noMatch = matchToDeal(
  { documentName: 'Amendment #1 - 900 Unknown Rd', subject: '' }, deals);
check('unknown address does not match any deal', noMatch.deal === null, noMatch);

const ambiguous = matchToDeal(
  { documentName: 'Package - 104 Wild Cherry Ln and 23 Nopalito', subject: '' }, deals);
check('ambiguous multi-deal match refuses to guess',
  ambiguous.deal === null && ambiguous.confidence === 'ambiguous', ambiguous);

const noDeals = matchToDeal(complete, []);
check('no active deals handled', noDeals.deal === null);

console.log(`\n${fail === 0 ? 'ALL PARSER TESTS PASSED' : 'PARSER TESTS FAILED'}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
