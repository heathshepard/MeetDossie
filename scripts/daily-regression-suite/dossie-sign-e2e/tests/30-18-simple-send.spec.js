#!/usr/bin/env node
/**
 * 30-18-simple-send.spec.js — TREC 30-18 Condominium Contract via "Simple send" mode.
 *
 * 2026-07-14 KNOWN GAP: No form_template row exists for TREC 30-18 (or any
 * condo variant). Simple Send requires an attached documents row.
 * Blocked until Heath adds a form_template row.
 *
 * Test result: FAIL until a form_template row exists.
 */

'use strict';

console.log('  [SKIP] TREC 30-18 form_template row missing in public.form_templates.');
console.log('  [SKIP] Simple Send blocked — requires attached document row.');
console.log('  [SKIP] Action needed: seed a form_template row for TREC 30-18 (Condominium Contract).');
console.log('\n=== EVIDENCE ===');
console.log('  Passed      : false');
console.log('  Fail reason : No form_template row for 30-18 — cannot attach doc.');
process.exit(1);
