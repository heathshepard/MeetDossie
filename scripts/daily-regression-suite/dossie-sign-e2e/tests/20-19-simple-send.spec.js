#!/usr/bin/env node
/**
 * 20-19-simple-send.spec.js — TREC 20-19 Resale Contract via "Simple send" mode.
 *
 * Simple send mode = agent attaches a form template to a dossier, clicks
 * "Send for sig." on the attached document row, fills a signer, clicks Send.
 * Backend calls /api/esign-create (not /api/esign-templates) — a separate
 * code path from template mode.
 *
 * Form template ID a6114e4e-35b7-42af-8a90-375ae7ff608f is the TREC 20-19
 * form_template row (short_name "1-4 Family Contract" trec_number "20-19"),
 * verified via SQL against public.form_templates.
 *
 * PASS = envelope created + Dossie signing email delivered + signer link
 * opens without error. Blank template PDFs render as-is on signer view
 * (no prefill since Simple Send is not the template-mode code path).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runSimpleSendWalk } = require('../_lib/simple-send-walk');

function loadDotenv() {
  const envPath = path.resolve(__dirname, '..', '..', '..', '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
  }
}

async function main() {
  loadDotenv();
  const base = process.env.BASE_URL || 'https://meetdossie.com';
  const headless = process.env.HEADED === '1' ? false : true;

  const evidence = await runSimpleSendWalk({
    formKey: '20-19',
    base,
    headless,
    // TREC 20-19 form_template row id (from form_templates table, verified 2026-07-14).
    formTemplateId: 'a6114e4e-35b7-42af-8a90-375ae7ff608f',
    signers: [
      { name: 'Alex Testbuyer', roleValue: 'Buyer 1' },
    ],
    // Simple send does NOT prefill — the PDF sent to DocuSeal is the raw
    // template. Signer sees a blank contract with signature widgets. Assert
    // only that the signer page loads with contract-ish content.
    expectedRenders: [
      { key: 'signer_page_loaded', re: /Sign|DocuSeal|Signature|Contract/i, sample: 'signer page loaded' },
    ],
  });

  process.exit(evidence.passed ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
