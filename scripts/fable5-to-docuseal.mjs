#!/usr/bin/env node
/**
 * scripts/fable5-to-docuseal.mjs
 *
 * Reusable Fable5 -> DocuSeal template pipeline with correct multi-party routing.
 *
 * FIXES the bug in .tmp/fable5-wire-fraud-demo.js where ALL fields collapsed to
 * a single "Seller 1" submitter. Root cause: Fable5 emits party="seller" for
 * BOTH seller_1 and seller_2 (co-signers), so the demo's plain PARTY_TO_ROLE
 * map buried the co-signer distinction. This script also inspects the field
 * NAME to detect _1 / _2 / _co / etc. co-party markers and routes them apart.
 *
 * Usage:
 *   node scripts/fable5-to-docuseal.mjs <pdf_path> <template_name>
 *
 * Output:
 *   - DocuSeal template with the CORRECT set of submitters (only those with
 *     >=1 field assigned).
 *   - One signer-preview submission per submitter (public URL Heath can click).
 *   - Report JSON written to .tmp/fable5-to-docuseal-<timestamp>.json
 *   - Console summary: template_id, submitter/field distribution, preview URLs.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// ENV LOADING
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = path.join(REPO_ROOT, '.env.local');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}
loadEnv();

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';

if (!DOCUSEAL_API_KEY) { console.error('Missing DOCUSEAL_API_KEY'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

// ---------------------------------------------------------------------------
// CONSTANTS: field sizes + role map + type map
// ---------------------------------------------------------------------------

// Standardized DocuSeal field sizes (fractional 0-1 of page).
const STD_SIZES = {
  signature: { w: 0.32, h: 0.05 },
  initials:  { w: 0.08, h: 0.04 },
  date:      { w: 0.16, h: 0.04 },
  text:      { h: 0.03 },
  checkbox:  { w: 0.02, h: 0.02 },
};

// Fable5 type -> DocuSeal type
const TYPE_MAP = {
  signature: 'signature',
  initial: 'initials',
  initials: 'initials',
  date: 'date',
  text: 'text',
  checkbox: 'checkbox',
  radio: 'radio',
  currency: 'text',
  percent: 'text',
  phone: 'text',
  email: 'text',
  number: 'text',
};

// Ordered list of standard DocuSeal submitter roles (signing order matters).
// Only roles with >=1 field assigned actually appear in the created template.
const SIGNING_ORDER = [
  'Buyer Broker',
  'Buyer 1',
  'Buyer 2',
  'Seller Broker',
  'Seller 1',
  'Seller 2',
];

// ---------------------------------------------------------------------------
// PARTY -> ROLE (with field-name post-processing for co-signers)
// ---------------------------------------------------------------------------

/**
 * Map a single Fable5 field to a DocuSeal submitter role.
 *
 * Recognizes:
 *   - explicit party values: buyer, seller, buyer_1, buyer_2, seller_1,
 *     seller_2, broker, listing_broker, listing_agent, buyer_broker,
 *     buyer_agent, tenant, landlord, either
 *   - name-embedded co-party markers when the party alone is generic:
 *     e.g. party="seller" + name contains "seller_2" or "seller2" or
 *     "co_seller" -> Seller 2 (not Seller 1).
 *
 * Returns a canonical role string from SIGNING_ORDER, or 'Buyer 1' as
 * conservative default (sender-owned).
 */
function fieldToRole(field) {
  const rawParty = (field.party || '').toLowerCase().trim();
  const name = (field.name || '').toLowerCase();

  // 1. Explicit co-signer party values from Fable5
  if (rawParty === 'buyer_2' || rawParty === 'buyer2') return 'Buyer 2';
  if (rawParty === 'seller_2' || rawParty === 'seller2') return 'Seller 2';
  if (rawParty === 'buyer_1' || rawParty === 'buyer1') return 'Buyer 1';
  if (rawParty === 'seller_1' || rawParty === 'seller1') return 'Seller 1';

  // 2. Broker parties (listing vs buyer side)
  if (rawParty === 'listing_broker' || rawParty === 'listing_agent') return 'Seller Broker';
  if (rawParty === 'buyer_broker' || rawParty === 'buyer_agent' || rawParty === 'buyers_agent') return 'Buyer Broker';

  // 3. Generic broker: infer from name — "listing" -> Seller side, "selling"/"other" -> Buyer side.
  //    Fall back: Seller Broker (listing side is the more common broker signature on
  //    seller-facing disclosure/wire-fraud forms).
  if (rawParty === 'broker') {
    if (/listing/.test(name)) return 'Seller Broker';
    if (/(selling|other|buyer)/.test(name)) return 'Buyer Broker';
    return 'Seller Broker';
  }

  // 4. Generic seller / buyer with co-signer disambiguation from field name.
  //    Fable5 emits BOTH `seller_2` and `seller2` (and same for buyer/tenant/landlord)
  //    so the regex accepts either. Anchor `_2` / `2` at a word boundary so
  //    "buyer_agent" doesn't accidentally match. Also matches synonyms Fable5
  //    sometimes uses on buyer-side forms: "consumer_2", "client_2".
  if (rawParty === 'seller' || rawParty === 'landlord') {
    if (/(seller|landlord|owner)[_-]?2(?:$|_|\b)/.test(name) || /co[_-]?(seller|landlord|owner)/.test(name)) return 'Seller 2';
    return 'Seller 1';
  }
  if (rawParty === 'buyer' || rawParty === 'tenant') {
    if (/(buyer|tenant|consumer|client|purchaser)[_-]?2(?:$|_|\b)/.test(name) || /co[_-]?(buyer|tenant|consumer|client|purchaser)/.test(name)) return 'Buyer 2';
    return 'Buyer 1';
  }

  // 5. Escrow / attorney / system / either — sender-owned by default.
  return 'Buyer 1';
}

// ---------------------------------------------------------------------------
// FIELD CONVERSION (Fable5 -> DocuSeal shape)
// ---------------------------------------------------------------------------

function convertFieldToDocuSeal(f) {
  const type = (f.type || 'text').toLowerCase();
  const dsType = TYPE_MAP[type] || 'text';

  let x = (f.x_pct || 0) / 100;
  let y = (f.y_pct || 0) / 100;
  let w = (f.w_pct || 0) / 100;
  let h = (f.h_pct || 0) / 100;

  const std = STD_SIZES[dsType];
  if (std) {
    if (std.w !== undefined) w = std.w;
    if (std.h !== undefined) h = std.h;
  }

  x = Math.max(0, Math.min(0.99, x));
  y = Math.max(0, Math.min(0.99, y));
  w = Math.max(0.01, Math.min(1 - x, w));
  h = Math.max(0.01, Math.min(1 - y, h));

  const role = fieldToRole(f);
  // DocuSeal pages are 1-indexed (must be > 0), same as Fable5.
  const page = Math.max(1, Number(f.page) || 1);

  return {
    name: f.name || 'field',
    type: dsType,
    role,
    required: !!f.required,
    areas: [{ x, y, w, h, page }],
    _fable5: {
      party: f.party,
      rationale: f.rationale,
      paragraph: f.paragraph,
    },
  };
}

// ---------------------------------------------------------------------------
// DOCUSEAL HTTP
// ---------------------------------------------------------------------------

function dsJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(DOCUSEAL_BASE + urlPath);
    const bodyBuf = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      Accept: 'application/json',
    };
    if (bodyBuf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyBuf.length;
    }
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method,
      headers,
      timeout: 180000,
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(chunks)); }
          catch { resolve(chunks); }
        } else {
          reject(new Error(`DocuSeal ${method} ${urlPath} HTTP ${res.statusCode}: ${chunks.slice(0, 800)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`Timeout ${method} ${urlPath}`)));
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// MAIN PIPELINE
// ---------------------------------------------------------------------------

export async function fable5ToDocuSeal(pdfPath, templateName, opts = {}) {
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);

  console.log('[1/5] Loading PDF...');
  const pdfBuffer = fs.readFileSync(pdfPath);
  console.log(`      Path: ${pdfPath}`);
  console.log(`      Size: ${pdfBuffer.length} bytes`);

  console.log('[2/5] Calling Fable5...');
  // Dynamically import the CommonJS module. Node ESM supports `import()` on
  // CJS files but returns the module.exports on `.default` OR as `namespace`.
  const mapperModule = await import(pathToFileURL(path.join(REPO_ROOT, 'api', '_lib', 'fable5-field-mapper.js')).href);
  const callFable5Chunked = mapperModule.callFable5Chunked || mapperModule.default?.callFable5Chunked;
  if (typeof callFable5Chunked !== 'function') throw new Error('callFable5Chunked not found in fable5-field-mapper.js');

  const t0 = Date.now();
  const slug = (templateName || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
  const fableResult = await callFable5Chunked(
    [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBuffer.toString('base64') } }],
    slug,
    { vertical: 'residential' },
  );
  const fableMs = Date.now() - t0;
  const fields = fableResult.parsed?.fields || [];
  const fableCostCents = fableResult.model_cost_cents || 0;
  console.log(`      Fable5: ${fields.length} fields, cost ${fableCostCents}c ($${(fableCostCents / 100).toFixed(4)}), ${fableMs}ms`);
  console.log(`      Form: ${fableResult.parsed?.form_name || '(unknown)'} / ${fableResult.parsed?.form_number || '(unknown)'}`);

  if (fields.length === 0) throw new Error('Fable5 returned zero fields — cannot proceed');

  console.log('[3/5] Converting fields + computing submitter distribution...');
  const dsFields = fields.map(convertFieldToDocuSeal);

  // Aggregate role -> count and role -> list of fields (for reporting)
  const roleCounts = {};
  const roleFields = {};
  for (const f of dsFields) {
    roleCounts[f.role] = (roleCounts[f.role] || 0) + 1;
    if (!roleFields[f.role]) roleFields[f.role] = [];
    roleFields[f.role].push(f.name);
  }

  // Assemble submitters in canonical signing order — ONLY those with >=1 field.
  const activeRoles = SIGNING_ORDER.filter((r) => roleCounts[r] > 0);
  // Include any custom / unexpected roles (shouldn't happen, but safe).
  for (const r of Object.keys(roleCounts)) {
    if (!activeRoles.includes(r)) activeRoles.push(r);
  }

  console.log(`      ${dsFields.length} fields -> ${activeRoles.length} submitters:`);
  for (const r of activeRoles) console.log(`        ${r.padEnd(16)} ${roleCounts[r]} fields`);

  const submitterPlaceholders = activeRoles.map((name) => ({ name }));

  console.log('[4/5] Creating DocuSeal template via POST /templates/pdf...');
  const base64Pdf = pdfBuffer.toString('base64');
  const pdfName = path.basename(pdfPath);
  const tmplBody = {
    name: templateName,
    documents: [{
      name: pdfName,
      file: `data:application/pdf;base64,${base64Pdf}`,
      // Strip the private _fable5 debug key before sending to DocuSeal
      fields: dsFields.map(({ _fable5, ...clean }) => clean),
    }],
    submitters: submitterPlaceholders,
  };
  const createResp = await dsJson('POST', '/templates/pdf', tmplBody);
  const templateId = createResp.id;
  const createdFieldCount = (createResp.fields || []).length;
  const createdSubmitters = createResp.submitters || [];
  console.log(`      Template ID: ${templateId}`);
  console.log(`      DocuSeal accepted ${createdFieldCount} fields`);
  console.log(`      DocuSeal created ${createdSubmitters.length} submitters:`);
  for (const s of createdSubmitters) console.log(`        ${s.name.padEnd(16)} uuid=${s.uuid}`);

  // ---------------------------------------------------------------------------
  // Cross-check: DocuSeal maps each field to a submitter by role NAME at create
  // time. Verify each of DocuSeal's created fields has the submitter_uuid we
  // expect, and PATCH (via full-template PUT) if any are wrong.
  // ---------------------------------------------------------------------------
  const roleToUuid = {};
  for (const s of createdSubmitters) roleToUuid[s.name] = s.uuid;

  const createdFields = createResp.fields || [];
  const mismatched = [];
  // DocuSeal returns fields in the same order we submitted them.
  for (let i = 0; i < createdFields.length && i < dsFields.length; i++) {
    const expected = dsFields[i];
    const got = createdFields[i];
    const wantUuid = roleToUuid[expected.role];
    if (wantUuid && got.submitter_uuid !== wantUuid) {
      mismatched.push({ idx: i, name: expected.name, role: expected.role, wantUuid, gotUuid: got.submitter_uuid });
    }
  }

  if (mismatched.length > 0) {
    console.log(`      ${mismatched.length} fields have wrong submitter_uuid; PATCHing via PUT /templates/${templateId}...`);
    const fixedFields = createdFields.map((f, i) => {
      const expected = dsFields[i];
      const wantUuid = expected ? roleToUuid[expected.role] : f.submitter_uuid;
      return { ...f, submitter_uuid: wantUuid || f.submitter_uuid };
    });
    const putBody = { submitters: createdSubmitters, fields: fixedFields };
    const putResp = await dsJson('PUT', `/templates/${templateId}`, putBody);
    console.log(`      PUT complete: ${(putResp.fields || []).length} fields, ${(putResp.submitters || []).length} submitters`);
  } else {
    console.log(`      All ${createdFields.length} fields correctly routed on create — no PATCH needed.`);
  }

  console.log('[5/5] Creating signer-preview submissions (one per submitter)...');
  const previews = [];
  for (const role of activeRoles) {
    const emailSlug = role.toLowerCase().replace(/\s+/g, '');
    const subBody = {
      template_id: templateId,
      send_email: false,
      submitters: [{
        role,
        email: `preview.${emailSlug}@mailinator.com`,
        name: `Preview ${role}`,
      }],
    };
    try {
      const subResp = await dsJson('POST', '/submissions', subBody);
      const submitters = Array.isArray(subResp) ? subResp : (subResp.submitters || []);
      const s = submitters[0] || {};
      const url = s.slug ? `https://docuseal.com/s/${s.slug}` : null;
      previews.push({ role, slug: s.slug || null, url, email: `preview.${emailSlug}@mailinator.com`, field_count: roleCounts[role] });
      console.log(`      ${role.padEnd(16)} ${url || '(no url)'}`);
    } catch (e) {
      console.log(`      ${role.padEnd(16)} FAILED: ${e.message}`);
      previews.push({ role, slug: null, url: null, error: e.message, field_count: roleCounts[role] });
    }
  }

  const report = {
    ok: true,
    ts: new Date().toISOString(),
    pdf_path: pdfPath,
    template_name: templateName,
    fable5: {
      field_count: fields.length,
      cost_cents: fableCostCents,
      cost_usd: (fableCostCents / 100).toFixed(4),
      duration_ms: fableMs,
      form_name: fableResult.parsed?.form_name,
      form_number: fableResult.parsed?.form_number,
      chunks_processed: fableResult.parsed?._chunks_processed || 1,
      salvaged_from_truncation: fableResult.parsed?._salvaged_from_truncated_response || false,
      all_fields: fields,
    },
    docuseal: {
      template_id: templateId,
      template_name: templateName,
      edit_url: `https://docuseal.com/templates/${templateId}/edit`,
      fields_created: createdFieldCount,
      submitters: createdSubmitters,
      role_counts: roleCounts,
      role_fields: roleFields,
      mismatched_on_create: mismatched.length,
    },
    signer_previews: previews,
  };

  // Write report
  const reportDir = path.join(REPO_ROOT, '.tmp');
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `fable5-to-docuseal-${templateId}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n      Report: ${reportPath}`);

  return report;
}

// ---------------------------------------------------------------------------
// CLI ENTRY
// ---------------------------------------------------------------------------

const isCli = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isCli) {
  const [pdfPath, ...nameParts] = process.argv.slice(2);
  const templateName = nameParts.join(' ');
  if (!pdfPath || !templateName) {
    console.error('Usage: node scripts/fable5-to-docuseal.mjs <pdf_path> <template_name>');
    process.exit(1);
  }
  fable5ToDocuSeal(pdfPath, templateName)
    .then((r) => {
      console.log('\nDONE.');
      console.log(`  Template: https://docuseal.com/templates/${r.docuseal.template_id}/edit`);
      for (const p of r.signer_previews) {
        if (p.url) console.log(`  ${p.role}: ${p.url}`);
      }
    })
    .catch((e) => {
      console.error('\nFAILED:', e.message);
      console.error(e.stack);
      process.exit(1);
    });
}
