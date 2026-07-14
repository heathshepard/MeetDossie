#!/usr/bin/env node
/**
 * 61-0-place-fields.spec.js — TREC 61-0 Groundwater via "Place fields" mode.
 *
 * 2026-07-14 KNOWN GAP: No form_template row exists for TREC 61-0. Place
 * Fields requires an attached documents row. Blocked until form_template
 * row is seeded.
 */

'use strict';

console.log('  [SKIP] TREC 61-0 form_template row missing. Cannot attach doc for Place Fields.');
console.log('\n=== EVIDENCE ===');
console.log('  Passed      : false');
console.log('  Fail reason : No form_template row for 61-0 — cannot attach doc.');
process.exit(1);
