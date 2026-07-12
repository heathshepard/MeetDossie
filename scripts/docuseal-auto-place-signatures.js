#!/usr/bin/env node
/**
 * scripts/docuseal-auto-place-signatures.js
 *
 * DocuSeal signature/initial/date field auto-placement pipeline.
 *
 * Two modes:
 *   1) AUDIT — compare live DocuSeal template's signature/initial/date coords
 *      against Heath's manually-mapped ground truth files (docuseal-*.json in repo
 *      root). Reports MATCH / DRIFT / MISSING per field. Never mutates.
 *      Validates that our algorithm's coordinate model matches Heath's manual work.
 *
 *   2) PLACE — for templates that lack proper Buyer/Seller submitter role split
 *      or lack signature/initial fields entirely, place them using the coordinate
 *      template derived from Heath's 20-19 map (34% buyer / 57% seller x-coords
 *      for bottom-page initials; 11.7% / 51.3% x-coords for last-page signatures).
 *      Dry-run by default; --apply to actually PUT to DocuSeal.
 *
 * Usage:
 *   node scripts/docuseal-auto-place-signatures.js --audit               # audit all mapped
 *   node scripts/docuseal-auto-place-signatures.js --plan                # dry-run all placements
 *   node scripts/docuseal-auto-place-signatures.js --apply --template 4111325   # apply to one
 *   node scripts/docuseal-auto-place-signatures.js --apply --all-unmapped        # apply to all needing sigs
 *
 * Constraints:
 *   - No LLM calls. Pure coordinate math + DocuSeal REST.
 *   - Idempotent: --apply strips existing sig/initial/date fields before re-placing.
 *   - Respects Heath's manually-mapped templates: audit-only for those.
 *   - Never touches TREC 20-18 envelope template 4814503 (Heath's canonical).
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const DOCUSEAL_API_KEY =
  process.env.DOCUSEAL_API_KEY ||
  (fs.existsSync(path.join(__dirname, '..', '.env.local'))
    ? (fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
        .match(/DOCUSEAL_API_KEY="?([^"\n]+)"?/) || [])[1]
    : null);

if (!DOCUSEAL_API_KEY) {
  console.error('ERROR: DOCUSEAL_API_KEY not found (env or .env.local)');
  process.exit(1);
}

const BASE = 'https://api.docuseal.com';
const REPO_ROOT = path.join(__dirname, '..');

// The top 15 forms Heath sends, and their DocuSeal template IDs.
// Populated from live DocuSeal API inventory (2026-07-12).
const TARGETS = [
  // Heath's 7 manually-mapped templates — audit-only
  { id: 4952172, form: 'TREC 20-19 Resale',            groundTruth: 'docuseal-fields.json',                        state: 'mapped' }, // 2026-07-12: swapped to fillable PDF template; old 4111319 archived
  { id: 4023463, form: 'TREC 40-11 Financing',         groundTruth: 'docuseal-financing-fields.json',              state: 'mapped' },
  { id: 4023470, form: 'OP-H Sellers Disclosure',      groundTruth: 'docuseal-sellers-disclosure-fields.json',     state: 'mapped' },
  { id: 4023472, form: 'TREC 49-1 Lender Appraisal',   groundTruth: 'docuseal-trec-49-1-right-to-terminate-fields.json', state: 'mapped' },
  { id: 4111320, form: 'TREC 39-11 Amendment',         groundTruth: 'docuseal-amendment-fields.json',              state: 'mapped' },
  { id: 4111321, form: 'TREC 36-11 HOA (May 2026)',    groundTruth: 'docuseal-trec-36-11-hoa-addendum-fields.json', state: 'mapped' },
  { id: 4023469, form: 'OP-L Lead-Based Paint',        groundTruth: 'docuseal-lead-paint-addendum-op-l-fields.json', state: 'mapped' },

  // Templates on Heath's account needing proper Buyer/Seller split (currently "First Party" only)
  { id: 4023578, form: 'TREC 11-8 Backup Contract',    groundTruth: null, state: 'needs-role-split', pages: 2 },
  { id: 4111325, form: 'TREC 25-17 Farm & Ranch',      groundTruth: null, state: 'needs-role-split', pages: 9 },
  { id: 4111326, form: 'TREC 23-20 New Home Incomplete', groundTruth: null, state: 'needs-role-split', pages: 8 },
  { id: 4111327, form: 'TREC 24-20 New Home Complete',   groundTruth: null, state: 'needs-role-split', pages: 8 },
  { id: 4111324, form: 'TREC 30-18 Condo Contract',      groundTruth: null, state: 'needs-role-split', pages: 10 },
  { id: 4023573, form: 'TREC 26 Seller Financing',       groundTruth: null, state: 'needs-role-split', pages: 2 },
  { id: 4111323, form: 'TREC 11-9 Backup Contract',      groundTruth: null, state: 'needs-role-split', pages: 2 },
  { id: 4111328, form: 'TREC 61-0 Groundwater',          groundTruth: null, state: 'needs-role-split', pages: 1 },
];

// ---------------------------------------------------------------------------
// COORDINATE MODEL — Heath's canonical placement rules
// ---------------------------------------------------------------------------
//
// Derived by inspecting Heath's manually-mapped docuseal-fields.json (TREC 20-19)
// and cross-referencing trec-20-18-esign-coords.json. All coords are 0-1
// normalized, top-left origin (DocuSeal convention).
//
// CANONICAL COORDINATES — calibrated from Heath's live TREC 40-11 template
// (docuseal-financing-fields.json, verified PASS in audit vs. live DocuSeal 4023463).
// These are the PROVEN placements that render correctly in DocuSeal UI.
//
// PAGE-FOOTER INITIALS (every page except last signature page):
//   Buyer 1  : x=0.336, y=0.958, w=0.045, h=0.02
//   Buyer 2  : x=0.388, y=0.958, w=0.045, h=0.02
//   Seller 1 : x=0.532, y=0.958, w=0.045, h=0.02
//   Seller 2 : x=0.594, y=0.958, w=0.045, h=0.02
//
// LAST-PAGE SIGNATURE BLOCK (top row = signer 1, bottom row = signer 2):
//   Buyer 1  Signature : x=0.091, y=0.749, w=0.399, h=0.04
//   Seller 1 Signature : x=0.509, y=0.749, w=0.39,  h=0.04
//   Buyer Date  1      : x=0.091, y=0.793, w=0.20,  h=0.016
//   Seller Date 1      : x=0.509, y=0.793, w=0.20,  h=0.016
//   Buyer 2  Signature : x=0.09,  y=0.816, w=0.398, h=0.04
//   Seller 2 Signature : x=0.51,  y=0.816, w=0.391, h=0.04
//
// Notes:
//   - `page` is 0-indexed in DocuSeal API.
//   - Initials go on EVERY page except the sig page.
//   - Some forms (Farm & Ranch, Condo) use wider outer margins.
//     Heath's live 4111325 uses x=0.08 buyer / x=0.65 seller at y=0.94.
//     `FARM_RANCH_INITIAL_OVERRIDES` handles these outliers.
//   - Groundwater (61-0) is single-page — no initials, sig on same page.

const COORD_TEMPLATE = {
  initials_buyer1:  { x: 0.336, y: 0.958, w: 0.045, h: 0.02 },
  initials_buyer2:  { x: 0.388, y: 0.958, w: 0.045, h: 0.02 },
  initials_seller1: { x: 0.532, y: 0.958, w: 0.045, h: 0.02 },
  initials_seller2: { x: 0.594, y: 0.958, w: 0.045, h: 0.02 },

  signature_buyer1: { x: 0.091, y: 0.749, w: 0.399, h: 0.04 },
  signature_seller1:{ x: 0.509, y: 0.749, w: 0.39,  h: 0.04 },
  signature_buyer2: { x: 0.09,  y: 0.816, w: 0.398, h: 0.04 },
  signature_seller2:{ x: 0.51,  y: 0.816, w: 0.391, h: 0.04 },

  date_buyer:  { x: 0.091, y: 0.793, w: 0.20, h: 0.016 },
  date_seller: { x: 0.509, y: 0.793, w: 0.20, h: 0.016 },
};

// Farm & Ranch, New Home, Condo use wider outer-margin initial positions
const FARM_RANCH_INITIAL_OVERRIDES = {
  initials_buyer1:  { x: 0.08, y: 0.94, w: 0.08, h: 0.025 },
  initials_seller1: { x: 0.65, y: 0.94, w: 0.08, h: 0.025 },
};

// ---------------------------------------------------------------------------
// DocuSeal REST helpers
// ---------------------------------------------------------------------------

async function ds(pathname, opts = {}) {
  const url = `${BASE}${pathname}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`DocuSeal ${opts.method || 'GET'} ${pathname} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return body;
}

async function getTemplate(id) {
  return ds(`/templates/${id}`);
}

async function putTemplateFields(id, fields, submitters) {
  const body = { fields };
  if (submitters) body.submitters = submitters;
  return ds(`/templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// AUDIT — compare live template signature/initial coords vs. ground truth
// ---------------------------------------------------------------------------

function loadGroundTruth(filename) {
  const p = path.join(REPO_ROOT, filename);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  // Normalize to a flat array of {name, type, areas}. Some files are already
  // arrays; some are dicts keyed by role.
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    // Handle formats like {fields:[...]} or role-keyed
    if (Array.isArray(raw.fields)) return raw.fields;
    // Role-keyed dict — flatten
    const flat = [];
    for (const [role, roleFields] of Object.entries(raw)) {
      if (Array.isArray(roleFields)) {
        for (const f of roleFields) flat.push({ ...f, _role: role });
      }
    }
    return flat;
  }
  return null;
}

function isSignatureField(f) {
  return f && ['signature', 'initials', 'date'].includes(f.type);
}

function coordDelta(a, b) {
  if (!a || !b) return null;
  return {
    dx: Math.abs((a.x || 0) - (b.x || 0)),
    dy: Math.abs((a.y || 0) - (b.y || 0)),
    dw: Math.abs((a.w || 0) - (b.w || 0)),
    dh: Math.abs((a.h || 0) - (b.h || 0)),
    dpage: Math.abs((a.page || 0) - (b.page || 0)),
  };
}

const MATCH_TOLERANCE = 0.02;  // 2% of page width/height

function coordsMatch(a, b) {
  const d = coordDelta(a, b);
  if (!d) return false;
  if (d.dpage !== 0) return false;
  return d.dx < MATCH_TOLERANCE && d.dy < MATCH_TOLERANCE
    && d.dw < MATCH_TOLERANCE && d.dh < MATCH_TOLERANCE;
}

function auditTemplate(liveTemplate, groundTruthFields) {
  const liveSigFields = liveTemplate.fields.filter(isSignatureField);
  const truthSigFields = groundTruthFields.filter(isSignatureField);

  const results = {
    matched: [],
    drifted: [],
    missingFromLive: [],
    extraInLive: [],
  };

  // For each ground-truth field, look for a live field with same name AND matching coords.
  const usedLiveIdxs = new Set();
  for (const gt of truthSigFields) {
    const gtArea = (gt.areas || [])[0];
    if (!gtArea) continue;
    // Look for live field with matching name (case-insensitive) and page
    const liveIdx = liveSigFields.findIndex((lf, i) => {
      if (usedLiveIdxs.has(i)) return false;
      if ((lf.name || '').toLowerCase() !== (gt.name || '').toLowerCase()) return false;
      if (lf.type !== gt.type) return false;
      return true;
    });
    if (liveIdx < 0) {
      results.missingFromLive.push({ name: gt.name, type: gt.type, expected: gtArea });
      continue;
    }
    usedLiveIdxs.add(liveIdx);
    const liveArea = (liveSigFields[liveIdx].areas || [])[0];
    if (coordsMatch(gtArea, liveArea)) {
      results.matched.push({ name: gt.name, type: gt.type });
    } else {
      results.drifted.push({
        name: gt.name,
        type: gt.type,
        expected: gtArea,
        actual: liveArea,
        delta: coordDelta(gtArea, liveArea),
      });
    }
  }
  liveSigFields.forEach((lf, i) => {
    if (!usedLiveIdxs.has(i)) results.extraInLive.push({ name: lf.name, type: lf.type });
  });

  return results;
}

// ---------------------------------------------------------------------------
// PLACEMENT PLAN — generate DocuSeal field payload for a template
// ---------------------------------------------------------------------------

function generatePlacementPlan(template, options = {}) {
  const totalPages = options.pages || Math.max(...template.fields.flatMap(f =>
    (f.areas || []).map(a => (a.page || 0) + 1)), 1);
  const sigPage = totalPages - 1;  // 0-indexed last page
  const isSinglePage = totalPages === 1;
  // Wide-margin forms use outer initial positions (Farm & Ranch, New Home, Condo)
  const isWideMargin = /farm|ranch|new home|condo/i.test(template.name);
  const initCoords = isWideMargin ? { ...COORD_TEMPLATE, ...FARM_RANCH_INITIAL_OVERRIDES } : COORD_TEMPLATE;

  // Attachment uuid — grab from first field's areas, or from documents[0]
  const attachmentUuid =
    (template.fields[0]?.areas?.[0]?.attachment_uuid) ||
    (template.documents?.[0]?.uuid);

  if (!attachmentUuid) {
    throw new Error(`Cannot determine attachment_uuid for template ${template.id}`);
  }

  // Determine submitter UUIDs. If the template only has "First Party", we
  // create a plan to REPLACE submitters with Buyer 1 / Seller 1 / Buyer 2 / Seller 2.
  // We generate stable-ish UUIDs (DocuSeal will assign real ones on save).
  const crypto = require('crypto');
  const genUuid = () => crypto.randomUUID();

  const submitterMap = {};
  const submitters = [];

  // Reuse existing submitter UUIDs where names match
  for (const roleName of ['Buyer 1', 'Seller 1', 'Buyer 2', 'Seller 2']) {
    const existing = template.submitters.find(s => s.name.toLowerCase() === roleName.toLowerCase());
    if (existing) {
      submitterMap[roleName] = existing.uuid;
      submitters.push({ name: roleName, uuid: existing.uuid });
    } else {
      const uuid = genUuid();
      submitterMap[roleName] = uuid;
      submitters.push({ name: roleName, uuid });
    }
  }

  // Build sig/initial/date field list
  const newSigFields = [];

  // Initials on every page except sig page (single-page forms have no initials)
  for (let p = 0; p < sigPage; p++) {
    newSigFields.push({
      uuid: genUuid(),
      submitter_uuid: submitterMap['Buyer 1'],
      name: `Buyer Initials P${p + 1}`,
      type: 'initials',
      required: true,
      areas: [{ ...initCoords.initials_buyer1, page: p, attachment_uuid: attachmentUuid }],
    });
    newSigFields.push({
      uuid: genUuid(),
      submitter_uuid: submitterMap['Seller 1'],
      name: `Seller Initials P${p + 1}`,
      type: 'initials',
      required: true,
      areas: [{ ...initCoords.initials_seller1, page: p, attachment_uuid: attachmentUuid }],
    });
    // Buyer 2 / Seller 2 optional
    newSigFields.push({
      uuid: genUuid(),
      submitter_uuid: submitterMap['Buyer 2'],
      name: `Buyer 2 Initials P${p + 1}`,
      type: 'initials',
      required: false,
      areas: [{ ...COORD_TEMPLATE.initials_buyer2, page: p, attachment_uuid: attachmentUuid }],
    });
    newSigFields.push({
      uuid: genUuid(),
      submitter_uuid: submitterMap['Seller 2'],
      name: `Seller 2 Initials P${p + 1}`,
      type: 'initials',
      required: false,
      areas: [{ ...COORD_TEMPLATE.initials_seller2, page: p, attachment_uuid: attachmentUuid }],
    });
  }

  // Last-page signatures + dates
  newSigFields.push({
    uuid: genUuid(),
    submitter_uuid: submitterMap['Buyer 1'],
    name: 'Buyer Signature',
    type: 'signature',
    required: true,
    areas: [{ ...COORD_TEMPLATE.signature_buyer1, page: sigPage, attachment_uuid: attachmentUuid }],
  });
  newSigFields.push({
    uuid: genUuid(),
    submitter_uuid: submitterMap['Buyer 1'],
    name: 'Buyer Date',
    type: 'date',
    required: true,
    areas: [{ ...COORD_TEMPLATE.date_buyer, page: sigPage, attachment_uuid: attachmentUuid }],
  });
  newSigFields.push({
    uuid: genUuid(),
    submitter_uuid: submitterMap['Seller 1'],
    name: 'Seller Signature',
    type: 'signature',
    required: true,
    areas: [{ ...COORD_TEMPLATE.signature_seller1, page: sigPage, attachment_uuid: attachmentUuid }],
  });
  newSigFields.push({
    uuid: genUuid(),
    submitter_uuid: submitterMap['Seller 1'],
    name: 'Seller Date',
    type: 'date',
    required: true,
    areas: [{ ...COORD_TEMPLATE.date_seller, page: sigPage, attachment_uuid: attachmentUuid }],
  });
  newSigFields.push({
    uuid: genUuid(),
    submitter_uuid: submitterMap['Buyer 2'],
    name: 'Buyer 2 Signature',
    type: 'signature',
    required: false,
    areas: [{ ...COORD_TEMPLATE.signature_buyer2, page: sigPage, attachment_uuid: attachmentUuid }],
  });
  newSigFields.push({
    uuid: genUuid(),
    submitter_uuid: submitterMap['Seller 2'],
    name: 'Seller 2 Signature',
    type: 'signature',
    required: false,
    areas: [{ ...COORD_TEMPLATE.signature_seller2, page: sigPage, attachment_uuid: attachmentUuid }],
  });

  // Keep non-sig fields, re-map their submitter_uuid to Buyer 1 (safest default;
  // Heath can re-assign in DocuSeal UI later). Drop existing sig/initial/date fields.
  const preservedNonSig = template.fields.filter(f => !isSignatureField(f)).map(f => ({
    ...f,
    submitter_uuid: submitterMap['Buyer 1'],
  }));

  return {
    fields: [...preservedNonSig, ...newSigFields],
    submitters,
    stats: {
      totalPages,
      sigPage: sigPage + 1,  // human-readable 1-indexed
      preservedNonSigCount: preservedNonSig.length,
      newSigFieldsCount: newSigFields.length,
      newSubmitters: submitters.map(s => s.name),
    },
  };
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    audit: argv.includes('--audit'),
    plan: argv.includes('--plan'),
    apply: argv.includes('--apply'),
    allUnmapped: argv.includes('--all-unmapped'),
    template: (() => {
      const i = argv.indexOf('--template');
      return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : null;
    })(),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
  };

  const noArgs = !opts.audit && !opts.plan && !opts.apply;
  if (noArgs) {
    console.log('Usage:');
    console.log('  --audit                              Audit mapped templates vs. ground truth');
    console.log('  --plan                               Dry-run placement for needs-role-split templates');
    console.log('  --apply --template <id>              Apply placement to one template');
    console.log('  --apply --all-unmapped               Apply to all needs-role-split templates');
    console.log('');
    console.log('Templates:');
    for (const t of TARGETS) {
      console.log(`  ${t.id}  ${t.form.padEnd(38)}  state=${t.state}`);
    }
    return;
  }

  const report = {
    timestamp: new Date().toISOString(),
    mode: opts.apply ? 'APPLY' : opts.plan ? 'PLAN' : 'AUDIT',
    templates: {},
    summary: {
      mapped: 0,
      audited_match: 0,
      audited_drifted: 0,
      placed: 0,
      skipped: 0,
      errors: 0,
    },
  };

  // AUDIT MODE — validate ground truth against live
  if (opts.audit || !opts.apply) {
    console.log('\n=== AUDIT: Heath\'s manually-mapped templates vs. live DocuSeal ===\n');
    for (const target of TARGETS.filter(t => t.state === 'mapped')) {
      report.summary.mapped++;
      try {
        const live = await getTemplate(target.id);
        const groundTruth = target.groundTruth ? loadGroundTruth(target.groundTruth) : null;
        if (!groundTruth) {
          console.log(`  [SKIP] ${target.id} ${target.form}: no ground truth file (${target.groundTruth})`);
          report.templates[target.id] = { form: target.form, audit: 'no-ground-truth' };
          report.summary.skipped++;
          continue;
        }
        const audit = auditTemplate(live, groundTruth);
        const matched = audit.matched.length;
        const drifted = audit.drifted.length;
        const missing = audit.missingFromLive.length;
        const extra = audit.extraInLive.length;
        const status = drifted === 0 && missing === 0 ? 'PASS' : 'DRIFT';
        console.log(`  [${status}] ${target.id} ${target.form.padEnd(35)}  matched=${matched}  drifted=${drifted}  missing_from_live=${missing}  extra_in_live=${extra}`);
        if (opts.verbose && drifted > 0) {
          audit.drifted.slice(0, 3).forEach(d => {
            console.log(`     DRIFT: ${d.name} (${d.type}) dx=${d.delta.dx.toFixed(3)} dy=${d.delta.dy.toFixed(3)}`);
          });
        }
        report.templates[target.id] = { form: target.form, audit: { status, matched, drifted, missing, extra, details: audit } };
        if (status === 'PASS') report.summary.audited_match++;
        else report.summary.audited_drifted++;
      } catch (err) {
        console.log(`  [ERR] ${target.id} ${target.form}: ${err.message.slice(0, 200)}`);
        report.templates[target.id] = { form: target.form, audit: 'error', error: err.message };
        report.summary.errors++;
      }
    }
  }

  // PLACEMENT MODE (plan or apply)
  if (opts.plan || opts.apply) {
    console.log(`\n=== ${opts.apply ? 'APPLY' : 'PLAN'}: signature placement for needs-role-split templates ===\n`);
    const toProcess = TARGETS.filter(t => {
      if (t.state !== 'needs-role-split') return false;
      if (opts.template) return t.id === opts.template;
      if (opts.allUnmapped) return true;
      return opts.plan;  // plan mode processes all
    });

    for (const target of toProcess) {
      try {
        const live = await getTemplate(target.id);
        const plan = generatePlacementPlan(live, { pages: target.pages });
        console.log(`  ${target.id} ${target.form}`);
        console.log(`     total_pages=${plan.stats.totalPages}  sig_page=${plan.stats.sigPage}  preserved=${plan.stats.preservedNonSigCount}  new_sig_fields=${plan.stats.newSigFieldsCount}`);
        console.log(`     new_submitters=${plan.stats.newSubmitters.join(', ')}`);

        if (opts.apply) {
          const result = await putTemplateFields(target.id, plan.fields, plan.submitters);
          console.log(`     APPLIED. edit_url=https://docuseal.com/templates/${target.id}/edit`);
          report.templates[target.id] = { form: target.form, applied: true, plan: plan.stats };
          report.summary.placed++;
        } else {
          console.log(`     (dry-run — pass --apply --template ${target.id} to write)`);
          report.templates[target.id] = { form: target.form, planned: true, plan: plan.stats };
        }
      } catch (err) {
        console.log(`  [ERR] ${target.id} ${target.form}: ${err.message.slice(0, 200)}`);
        report.templates[target.id] = { form: target.form, error: err.message };
        report.summary.errors++;
      }
    }
  }

  // WRITE REPORT
  const reportPath = path.join(REPO_ROOT, '.tmp', `docuseal-auto-place-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nFull report: ${reportPath}`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
