'use strict';

// api/_lib/revision-label-guard.test.js
//
// 23 Nopalito, 2026-09-21: Dossie told Heath "TREC 20-17" in chat about a
// document that is a TREC 20-19 — the internal document_type slug 'trec-20-17'
// (deliberately generic across every 1-4 Family Residential Contract revision,
// see scan-contract.js's own IDENTIFY_PROMPT comment) leaked into a model
// system prompt as an ASSERTION of the document's actual name
// ("(TREC 20-17)"), and the model's own free-text output inherited it.
//
// The permanent fix: a document's real revision has exactly one legitimate
// source — the file's own name (CONTRACT_REVISION_RE / contractDocumentMeta()
// in dossie-app.jsx, already what the document tiles read). This is a static
// regression guard, not a runtime test: it reads scan-contract.js's own
// source and fails if a parenthetical-revision assertion pattern like
// "(TREC 20-17)" or "(TREC 20-19)" ever reappears inside a prompt string
// handed to the model — the exact shape of the string that leaked.
//
// Deliberately does NOT flag every bare "TREC 20-17"/"TREC 20-19" mention —
// most of those are internal field-location instructions ("Paragraph 10 on
// TREC 20-17 lists...") telling the model WHERE to find data, not asking it
// to assert the document's identity. Only the parenthetical-assertion shape
// ("... a TREC One to Four Family Residential Contract (TREC 20-17) ...")
// is the pattern that actually leaked, so that's what this guards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('scan-contract.js never asserts a specific TREC revision number in a prompt sent to the model', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scan-contract.js'), 'utf8');
  // The exact leaked shape: "(TREC 20-17)" or "(TREC 20-19)" etc, immediately
  // following "Residential Contract" — an assertion of identity, not a
  // field-location instruction.
  const assertionPattern = /Residential Contract \(TREC 20-\d\d\)/;
  assert.doesNotMatch(source, assertionPattern, 'a prompt is asserting a specific TREC revision as the document\'s identity — this is exactly the 23 Nopalito leak. Use the generic "TREC One to Four Family Residential Contract" (no revision) instead, and let the file name be the only source of a stated revision.');
});
