#!/usr/bin/env node
/**
 * 61-0-simple-send.spec.js — TREC 61-0 Groundwater Notice via "Simple send" mode.
 *
 * 2026-07-14 KNOWN GAP: No form_template row exists for TREC 61-0. Simple
 * Send requires an attached documents row (which requires a form_template).
 * Blocked until Heath (or a form_template seed script) adds a row for 61-0.
 *
 * Test result: FAIL until a form_template row exists.
 */

'use strict';

console.log('  [SKIP] TREC 61-0 form_template row missing in public.form_templates.');
console.log('  [SKIP] Simple Send blocked — requires attached document row.');
console.log('  [SKIP] Action needed: seed a form_template row for TREC 61-0 (name/short_name/storage_path).');
console.log('\n=== EVIDENCE ===');
console.log('  Passed      : false');
console.log('  Fail reason : No form_template row for 61-0 — cannot attach doc.');
process.exit(1);
