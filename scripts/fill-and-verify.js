/**
 * scripts/fill-and-verify.js
 *
 * Closed-loop "fill + render to images" orchestrator for TREC contract fills.
 * Heath caught Quinn's grep-based QA shipping broken PDFs (text present in
 * PDF stream but visually rendered at the wrong coordinates → form blanks
 * stay empty). The fix is to render every fill to images and let a Visual QA
 * agent confirm each expected field landed in the correct visible location
 * BEFORE Heath ever sees the PDF.
 *
 * What this script does:
 *   1. Reads an input JSON file: { form_type, field_values, [label] }
 *   2. Authenticates against Supabase as demo@meetdossie.com
 *   3. Calls production POST https://meetdossie.com/api/fill-form with
 *      strict:true so caller field_values are the ONLY data written.
 *   4. Downloads the returned signed-URL PDF.
 *   5. Renders every page to a 150 DPI PNG via Poppler's pdftoppm.exe.
 *   6. Emits an expected-fields.json that pairs each field_value with the
 *      page it should visually appear on (cross-referenced from Hadley's
 *      TREC 20-19 field schema).
 *   7. Prints the absolute path of the run directory to stdout —
 *      Cole spawns Quinn next with the Visual QA prompt against that path.
 *
 * What this script does NOT do:
 *   - It does NOT modify api/fill-form.js (Carter's domain).
 *   - It does NOT call the production API more than once per run.
 *   - It does NOT do the visual check itself (that's Quinn's job, with the
 *     prompt template at scripts/fill-and-verify-VISUAL-QA-PROMPT.md).
 *
 * Usage:
 *   node scripts/fill-and-verify.js path/to/input.json
 *   node scripts/fill-and-verify.js path/to/input.json --label joe-shmo-smoke
 *   node scripts/fill-and-verify.js --inline '{"form_type":"resale-contract","field_values":{...}}'
 *
 * Output:
 *   .tmp-fill-verify/run-<timestamp>/
 *     input.json            (echo of the caller payload)
 *     fill-response.json    (raw API response — signed URL + metadata)
 *     contract.pdf          (the filled PDF as downloaded)
 *     expected-fields.json  (field → expected_page → expected_section)
 *     pg-01.png ... pg-NN.png  (150 DPI page renders)
 *     run.log               (every step + timing)
 *
 * Exit codes:
 *   0  success — run directory printed on the last stdout line as
 *      "RUN_DIR=<absolute path>"
 *   1  any failure (auth, API, render, write)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPABASE_URL = 'https://pgwoitbdiyubjugwufhk.supabase.co';
const PROD_API_BASE = process.env.FILL_VERIFY_API_BASE || 'https://meetdossie.com';
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';

// Demo transaction provided in the build brief — required by /api/fill-form
// even when strict:true is set (Carter's code path still pulls the row).
const DEMO_TRANSACTION_ID = '807dd591-d589-4019-89cf-3a805e14d421';

// Poppler 25.07.0 location (winget install). Fresh shells resolve `pdftoppm`
// via PATH; child_process.spawn does NOT always inherit the user PATH on
// Windows when this script is invoked from a long-running Claude Code shell.
// Hard-code the absolute path as the primary, fall back to PATH lookup.
const PDFTOPPM_ABS = 'C:\\Users\\Heath Shepard\\AppData\\Local\\Microsoft\\WinGet\\Packages\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\\poppler-25.07.0\\Library\\bin\\pdftoppm.exe';

// Output root (relative to MeetDossie repo root, which is the CWD this
// script expects to be invoked from). Falls back to absolute if CWD differs.
const REPO_ROOT_CANDIDATE = process.cwd();
const REPO_ROOT_FALLBACK = 'C:\\Users\\Heath Shepard\\Desktop\\MeetDossie';
const REPO_ROOT = fs.existsSync(path.join(REPO_ROOT_CANDIDATE, 'package.json'))
  ? REPO_ROOT_CANDIDATE
  : REPO_ROOT_FALLBACK;
const OUTPUT_ROOT = path.join(REPO_ROOT, '.tmp-fill-verify');

// ---------------------------------------------------------------------------
// Page-assignment map per Hadley's schema
//   trec-20-19-field-schema.md (Shepard-Ventures/Legal/dossie-fill-system)
//
// The brief says sections live on these pages of the 11-page TREC 20-18 PDF:
//   Sections 1-3        page 1
//   Section 4           page 1 (bottom of page 1)
//   Section 5           page 2
//   Section 6           pages 2-3
//   Section 7           pages 4-5
//   Sections 8-9        pages 5-6
//   Sections 10-12      pages 6-7
//   Sections 13-22      pages 7-8
//   Notices             page 8
//   Addenda checkboxes  pages 8-9
//   Execution + sigs    page 9
//   Broker info         page 10
//   Receipts            page 11
//
// Field-id → page lookup. Keys mirror the field_id column in Hadley's schema.
// If a field_id is not in this map, Visual QA treats expected_page as null
// and the agent must find the value visually anywhere on the document.
// ---------------------------------------------------------------------------

const FIELD_PAGE_MAP = {
  // --- Section 1: Parties (page 1)
  buyer_name: { page: 1, section: '1 PARTIES', visual_hint: '"between Seller and ___" line at top of page 1' },
  seller_name: { page: 1, section: '1 PARTIES', visual_hint: '"Seller, and ___" line at top of page 1' },

  // --- Section 2: Property (page 1)
  property_address: { page: 1, section: '2 PROPERTY', visual_hint: 'Address blank under "A. LAND:" on page 1' },
  property_street: { page: 1, section: '2 PROPERTY', visual_hint: 'Street line in §2A on page 1' },
  property_city: { page: 1, section: '2 PROPERTY', visual_hint: 'City blank in §2A on page 1' },
  property_state: { page: 1, section: '2 PROPERTY', visual_hint: 'State blank in §2A on page 1 (TX/Texas)' },
  property_zip: { page: 1, section: '2 PROPERTY', visual_hint: 'Zip code blank in §2A on page 1' },
  property_county: { page: 1, section: '2 PROPERTY', visual_hint: 'County blank in §2A on page 1' },
  legal_description: { page: 1, section: '2 PROPERTY', visual_hint: '"described as" / Lot/Block legal description on page 1' },
  subdivision: { page: 1, section: '2 PROPERTY', visual_hint: '"Addition" / subdivision line on page 1' },
  exclusions: { page: 1, section: '2 PROPERTY', visual_hint: '§2E exclusions blank on page 1' },

  // --- Section 3: Sales Price (page 1)
  sale_price: { page: 1, section: '3 SALES PRICE', visual_hint: 'Section 3C "Sales Price (Sum of A and B)" line on page 1' },
  cash_amount: { page: 1, section: '3 SALES PRICE', visual_hint: 'Section 3A "Cash portion" blank on page 1' },
  loan_amount: { page: 1, section: '3 SALES PRICE', visual_hint: 'Section 3B "Sum of all financing" blank on page 1' },

  // --- Section 4: Leases (page 1 bottom — explicitly per brief)
  has_tenant_lease: { page: 1, section: '4 LEASES', visual_hint: 'Section 4A residential lease checkbox area, bottom of page 1' },
  has_fixture_lease: { page: 1, section: '4 LEASES', visual_hint: 'Section 4B fixture lease checkbox area, bottom of page 1' },

  // --- Section 5: Earnest Money + Option (page 2)
  earnest_money: { page: 2, section: '5 EARNEST MONEY', visual_hint: 'Section 5A earnest amount line on page 2' },
  earnest_amount: { page: 2, section: '5 EARNEST MONEY', visual_hint: 'Section 5A earnest amount line on page 2' },
  additional_earnest: { page: 2, section: '5 EARNEST MONEY', visual_hint: 'Section 5A "additional earnest money" line on page 2' },
  additional_earnest_days: { page: 2, section: '5 EARNEST MONEY', visual_hint: 'Section 5A "within ___ days" line on page 2' },
  escrow_agent: { page: 2, section: '5 ESCROW AGENT', visual_hint: 'Escrow agent / title company name on page 2' },
  title_company: { page: 2, section: '5 ESCROW AGENT', visual_hint: 'Title company name on page 2' },
  escrow_address: { page: 2, section: '5 ESCROW AGENT', visual_hint: 'Escrow agent address on page 2' },
  option_fee: { page: 2, section: '5D OPTION FEE', visual_hint: 'Section 5D option-fee amount blank on page 2' },
  option_period_days: { page: 2, section: '5D OPTION FEE', visual_hint: 'Section 5D "___ days" termination-option line on page 2' },
  option_days: { page: 2, section: '5D OPTION FEE', visual_hint: 'Section 5D "___ days" termination-option line on page 2' },

  // --- Section 6: Title Policy + Survey + Notices (pages 2-3)
  title_furnished_by: { page: 2, section: '6A TITLE POLICY', visual_hint: 'Section 6A "Title Policy furnished by Seller/Buyer" on page 2-3' },
  existing_survey: { page: 3, section: '6C SURVEY', visual_hint: 'Section 6C existing-survey checkbox on page 3' },
  t47_seller: { page: 3, section: '6C SURVEY', visual_hint: 'Section 6C T-47 affidavit selection on page 3' },
  survey_party: { page: 3, section: '6C SURVEY', visual_hint: 'Section 6C survey party on page 3' },
  hoa_exists: { page: 3, section: '6E HOA', visual_hint: 'Section 6E HOA membership checkbox on page 3' },
  hoa_description: { page: 3, section: '6E HOA', visual_hint: 'Section 6E HOA description on page 3' },

  // --- Section 7: Property Condition (pages 4-5)
  inspections_acceptance: { page: 4, section: '7B INSPECTIONS', visual_hint: 'Section 7B acceptance checkbox on page 4' },
  sdn_received: { page: 4, section: '7B', visual_hint: 'Section 7B Seller Disclosure receipt on page 4' },
  warranty_amount: { page: 5, section: '7G RESIDENTIAL SERVICE CONTRACT', visual_hint: 'Section 7G warranty dollar amount on page 5' },
  warranty_provider: { page: 5, section: '7G RESIDENTIAL SERVICE CONTRACT', visual_hint: 'Section 7G warranty provider name on page 5' },

  // --- Section 8: Brokers + License Holder Disclosure (page 5-6) — usually blank
  // --- Section 9: Closing Date (page 5-6)
  closing_date: { page: 6, section: '9 CLOSING', visual_hint: 'Section 9A closing date on page 5-6' },

  // --- Section 10: Possession (page 6-7)
  possession_at_closing: { page: 6, section: '10 POSSESSION', visual_hint: 'Section 10 possession-at-closing checkbox' },

  // --- Section 11: Special Provisions (page 6-7)
  special_provisions: { page: 7, section: '11 SPECIAL PROVISIONS', visual_hint: 'Section 11 blank lines on page 7' },

  // --- Section 12: Settlement (page 6-7)
  buyer_closing_credit: { page: 7, section: '12A SETTLEMENT', visual_hint: 'Section 12A(1)(c) buyer closing-cost credit on page 7' },
  seller_concessions: { page: 7, section: '12A SETTLEMENT', visual_hint: 'Section 12A seller-paid expenses on page 7' },

  // --- Section 21: Notices (page 8)
  buyer_address: { page: 8, section: '21 NOTICES', visual_hint: 'Buyer notice address on page 8' },
  seller_address: { page: 8, section: '21 NOTICES', visual_hint: 'Seller notice address on page 8' },

  // --- Section 22 addenda checkboxes (page 8-9)
  financing_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Third Party Financing Addendum checkbox on page 8' },
  seller_financing_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Seller Financing checkbox on page 8' },
  hoa_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 HOA Addendum checkbox on page 8' },
  appraisal_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Appraisal Addendum (TREC 49-1) checkbox on page 8' },
  lead_paint_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Lead-Based Paint checkbox on page 8' },
  sellers_disclosure_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 SDN checkbox on page 8' },
  residential_leases_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Residential Leases checkbox on page 8' },
  fixture_leases_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Fixture Leases checkbox on page 8' },
  pid_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 PID checkbox on page 8' },
  short_sale_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Short Sale checkbox on page 8' },
  loan_assumption_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Loan Assumption checkbox on page 8' },
  buyer_leaseback_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Buyer Leaseback checkbox on page 8' },
  seller_leaseback_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Seller Leaseback checkbox on page 8' },
  other_property_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Sale of Other Property checkbox on page 8' },
  environmental_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Environmental Assessment checkbox on page 8' },
  coastal_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Coastal Addendum checkbox on page 8' },
  oil_gas_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Oil/Gas/Mineral checkbox on page 8' },
  backup_contract_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Backup Contract checkbox on page 8' },
  propane_addendum: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 Propane Gas checkbox on page 8' },
  exchange_1031: { page: 8, section: '22 ADDENDA', visual_hint: 'Section 22 §1031 Exchange checkbox on page 8' },

  // --- Execution block (page 9)
  execution_date: { page: 9, section: 'EXECUTION', visual_hint: '"EXECUTED the ___ day of ___" line on page 9' },
  contract_effective_date: { page: 9, section: 'EXECUTION', visual_hint: 'Effective-date blank on page 9 (often left blank by Dossie)' },
  buyer_email: { page: 9, section: 'EXECUTION', visual_hint: 'Buyer email blank under signature block on page 9' },
  seller_email: { page: 9, section: 'EXECUTION', visual_hint: 'Seller email blank under signature block on page 9' },

  // --- Page 10 — Broker Information block
  listing_broker_firm: { page: 10, section: 'BROKER INFO', visual_hint: '"Listing Broker Firm" label on page 10' },
  listing_broker_name: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing broker firm on page 10' },
  listing_broker_license: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing broker License No. on page 10' },
  listing_agent_name: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing Associate Name on page 10' },
  listing_agent_license: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing Associate License No. on page 10' },
  listing_agent_email: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing Associate Email on page 10' },
  listing_agent_phone: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing Associate Phone on page 10' },
  other_broker_firm: { page: 10, section: 'BROKER INFO', visual_hint: '"Other Broker Firm" label on page 10' },
  selling_broker_firm: { page: 10, section: 'BROKER INFO', visual_hint: '"Other Broker Firm" label on page 10' },
  selling_agent_name: { page: 10, section: 'BROKER INFO', visual_hint: 'Selling/buyer-side associate name on page 10' },
  selling_agent_license: { page: 10, section: 'BROKER INFO', visual_hint: 'Selling-side License No. on page 10' },
  selling_agent_email: { page: 10, section: 'BROKER INFO', visual_hint: 'Selling-side associate email on page 10' },
  selling_agent_phone: { page: 10, section: 'BROKER INFO', visual_hint: 'Selling-side associate phone on page 10' },
  buyers_agent_commission_pct: { page: 10, section: 'BROKER INFO', visual_hint: '"Escrow agent is authorized" BAC% blank on page 10' },
  buyer_agent_commission: { page: 10, section: 'BROKER INFO', visual_hint: '"Escrow agent is authorized" BAC dollar amount on page 10' },
  buyer_only_agent: { page: 10, section: 'BROKER INFO', visual_hint: '"Buyer only" representation checkbox on page 10' },
  listing_intermediary: { page: 10, section: 'BROKER INFO', visual_hint: 'Listing-side representation checkbox on page 10' },
};

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function makeLogger(runDir) {
  const logPath = path.join(runDir, 'run.log');
  return (msg) => {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(logPath, line + '\n'); } catch (_) { /* ignore */ }
  };
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let inputPath = null;
  let inlineJson = null;
  let label = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--inline') {
      inlineJson = args[++i];
    } else if (a === '--label') {
      label = args[++i];
    } else if (!a.startsWith('--')) {
      inputPath = a;
    }
  }

  if (!inputPath && !inlineJson) {
    throw new Error(
      'Usage: node scripts/fill-and-verify.js <input.json> [--label <slug>]\n' +
      '       node scripts/fill-and-verify.js --inline \'{"form_type":"...","field_values":{...}}\' [--label <slug>]'
    );
  }

  let payload;
  if (inlineJson) {
    payload = JSON.parse(inlineJson);
  } else {
    const abs = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
    const raw = fs.readFileSync(abs, 'utf8');
    payload = JSON.parse(raw);
  }

  if (!payload.form_type) throw new Error('Input JSON missing required field: form_type');
  if (!payload.field_values || typeof payload.field_values !== 'object') {
    throw new Error('Input JSON missing or malformed field_values object');
  }

  return { payload, label };
}

// ---------------------------------------------------------------------------
// Supabase auth
// ---------------------------------------------------------------------------

function readAnonKey() {
  // Per brief: read NEXT_PUBLIC_SUPABASE_ANON_KEY from .env.local.
  const envPath = path.join(REPO_ROOT, '.env.local');
  if (!fs.existsSync(envPath)) {
    throw new Error(`Cannot find .env.local at ${envPath}`);
  }
  const raw = fs.readFileSync(envPath, 'utf8');
  const match = raw.match(/^NEXT_PUBLIC_SUPABASE_ANON_KEY=("?)(.+?)\1\s*$/m);
  if (!match) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY not found in .env.local');
  return match[2];
}

async function signIn(anonKey, log) {
  log(`auth: signing in as ${DEMO_EMAIL}`);
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase auth failed (${res.status}): ${body}`);
  }
  const j = await res.json();
  log(`auth: ok — user_id=${j.user.id}`);
  return { jwt: j.access_token, userId: j.user.id };
}

// ---------------------------------------------------------------------------
// Fill API
// ---------------------------------------------------------------------------

async function callFillForm(jwt, payload, log) {
  const url = `${PROD_API_BASE}/api/fill-form`;
  log(`fill: POST ${url} (form_type=${payload.form_type}, strict:true)`);
  const body = {
    transaction_id: DEMO_TRANSACTION_ID,
    form_type: payload.form_type,
    field_values: payload.field_values,
    strict: true,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Origin: 'https://meetdossie.com',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!res.ok) {
    throw new Error(`fill-form API failed (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!parsed.signedUrl) {
    throw new Error(`fill-form API returned no signedUrl: ${text.slice(0, 500)}`);
  }
  log(`fill: ok — documentId=${parsed.documentId || '?'} signedUrl=<set>`);
  return parsed;
}

async function downloadPdf(signedUrl, destPath, log) {
  log(`download: GET signed url`);
  const res = await fetch(signedUrl);
  if (!res.ok) throw new Error(`PDF download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  log(`download: wrote ${buf.length} bytes → ${destPath}`);
  return buf.length;
}

// ---------------------------------------------------------------------------
// Render with pdftoppm
// ---------------------------------------------------------------------------

function resolvePdftoppm(log) {
  if (fs.existsSync(PDFTOPPM_ABS)) {
    log(`pdftoppm: using absolute path ${PDFTOPPM_ABS}`);
    return PDFTOPPM_ABS;
  }
  // Fall back to PATH lookup
  log(`pdftoppm: absolute path missing, trying PATH lookup`);
  const probe = spawnSync('pdftoppm', ['-v'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    throw new Error(
      `pdftoppm not found at ${PDFTOPPM_ABS} and not on PATH. ` +
      `Install Poppler via: winget install --id=oschwartz10612.Poppler --scope user`
    );
  }
  return 'pdftoppm';
}

function renderPdfToPngs(exe, pdfPath, outDir, log) {
  // pdftoppm -r 150 -png input.pdf prefix
  // Output: prefix-01.png ... prefix-NN.png (zero-padded based on page count >= 10)
  const prefix = path.join(outDir, 'pg');
  log(`render: ${exe} -r 150 -png ${pdfPath} ${prefix}`);
  const result = spawnSync(exe, ['-r', '150', '-png', pdfPath, prefix], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  // Poppler logs "Syntax Error: No display font" to stderr while still
  // producing valid PNGs at exit 0. Don't treat stderr as fatal.
  if (result.stderr && result.stderr.trim()) {
    log(`render: pdftoppm stderr (non-fatal):\n${result.stderr.trim().split('\n').slice(0, 5).join('\n')}`);
  }
  if (result.status !== 0) {
    throw new Error(`pdftoppm exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  // List produced pngs
  const pngs = fs.readdirSync(outDir).filter((f) => /^pg-\d+\.png$/.test(f)).sort();
  log(`render: produced ${pngs.length} PNG(s): ${pngs.join(', ')}`);
  return pngs;
}

// ---------------------------------------------------------------------------
// expected-fields.json builder
// ---------------------------------------------------------------------------

function buildExpectedFields(formType, fieldValues, totalPages) {
  // For non-resale forms we don't have a calibrated page map; emit
  // expected_page: null and let Visual QA find the value anywhere on
  // the document.
  const isResale = formType === 'resale-contract';

  const expected = [];
  for (const [fieldId, value] of Object.entries(fieldValues)) {
    // Skip null/empty/false values — they were not supposed to render anything visible.
    if (value == null || value === '' || value === false) continue;

    let pageInfo = null;
    if (isResale && FIELD_PAGE_MAP[fieldId]) {
      pageInfo = FIELD_PAGE_MAP[fieldId];
    }

    expected.push({
      field_id: fieldId,
      expected_value: value,
      expected_page: pageInfo ? pageInfo.page : null,
      expected_section: pageInfo ? pageInfo.section : null,
      visual_hint: pageInfo ? pageInfo.visual_hint : null,
      type: typeof value === 'boolean' ? 'checkbox' : 'text',
    });
  }
  return {
    form_type: formType,
    total_pages: totalPages,
    field_count: expected.length,
    page_map_source: isResale
      ? 'Shepard-Ventures/Legal/dossie-fill-system/trec-20-19-field-schema.md (section→page assignments from build brief 2026-06-14)'
      : null,
    fields: expected,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let runDir;
  let log;
  try {
    const { payload, label } = parseArgs(process.argv);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = label ? `${ts}-${label}` : ts;
    runDir = path.join(OUTPUT_ROOT, `run-${slug}`);
    fs.mkdirSync(runDir, { recursive: true });
    log = makeLogger(runDir);

    log(`run dir: ${runDir}`);
    log(`form_type=${payload.form_type} field_count=${Object.keys(payload.field_values).length}`);

    // Echo input for the audit trail
    fs.writeFileSync(
      path.join(runDir, 'input.json'),
      JSON.stringify(payload, null, 2),
      'utf8'
    );

    // Auth
    const anonKey = readAnonKey();
    const { jwt } = await signIn(anonKey, log);

    // Call fill-form
    const fillResponse = await callFillForm(jwt, payload, log);
    fs.writeFileSync(
      path.join(runDir, 'fill-response.json'),
      JSON.stringify(fillResponse, null, 2),
      'utf8'
    );

    // Download PDF
    const pdfPath = path.join(runDir, 'contract.pdf');
    await downloadPdf(fillResponse.signedUrl, pdfPath, log);

    // Render with pdftoppm
    const exe = resolvePdftoppm(log);
    const pngs = renderPdfToPngs(exe, pdfPath, runDir, log);

    // Build expected-fields.json
    const expected = buildExpectedFields(payload.form_type, payload.field_values, pngs.length);
    fs.writeFileSync(
      path.join(runDir, 'expected-fields.json'),
      JSON.stringify(expected, null, 2),
      'utf8'
    );
    log(`expected-fields.json: ${expected.field_count} fields tracked, ${pngs.length} pages`);

    log(`DONE — run dir: ${runDir}`);
    // Final line MUST be the run dir path so the parent agent can grep it.
    console.log(`RUN_DIR=${runDir}`);
    process.exit(0);
  } catch (err) {
    const msg = `FAILED: ${err && err.message ? err.message : err}`;
    if (log) log(msg); else console.error(msg);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
