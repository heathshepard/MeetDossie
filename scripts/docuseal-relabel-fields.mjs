#!/usr/bin/env node
/**
 * scripts/docuseal-relabel-fields.mjs
 *
 * DocuSeal AcroForm field re-labeler.
 *
 * PROBLEM: DocuSeal auto-imports AcroForm PDFs but keeps generic field names
 * ("Text1", "Check Box2", "undefined") or truncated label fragments ("A LAND Lot",
 * "1 PARTIES The parties"). Heath sees fields in correct POSITIONS but with
 * useless labels — makes it impossible to prefill via DocuSeal API.
 *
 * SOLUTION: For each field, look at its (x, y) position on the page, find the
 * nearest text label to the LEFT or ABOVE, derive a semantic name from the label
 * text, and update via DocuSeal API. Also auto-assign submitter roles (Buyer 1 /
 * Seller 1 / Buyer 2 / Seller 2 / shared) based on section context.
 *
 * Usage:
 *   node scripts/docuseal-relabel-fields.mjs --template <id>            # dry-run preview
 *   node scripts/docuseal-relabel-fields.mjs --template <id> --apply    # write to DocuSeal
 *   node scripts/docuseal-relabel-fields.mjs --template <id> --verbose  # show per-field derivations
 *
 * Constraints:
 *   - No LLM calls. Pure positional-nearest-neighbor + heuristic pattern matching.
 *   - Preserves existing signature/initial/date fields (they're placed by
 *     docuseal-auto-place-signatures.js — leave them alone).
 *   - Idempotent: safe to re-run. Fields already having "good" names (semantic
 *     tokens like "Buyer's Name", "Sales Price") are left alone unless --force.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

function loadApiKey() {
  if (process.env.DOCUSEAL_API_KEY) return process.env.DOCUSEAL_API_KEY;
  const envPath = path.join(REPO_ROOT, '.env.local');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/DOCUSEAL_API_KEY="?([^"\n]+)"?/);
    if (m) return m[1];
  }
  throw new Error('DOCUSEAL_API_KEY not found');
}

const DOCUSEAL_API_KEY = loadApiKey();
const BASE = 'https://api.docuseal.com';

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

// ---------------------------------------------------------------------------
// PDF text extraction with positions
// ---------------------------------------------------------------------------

async function extractPositionalText(pdfBytes) {
  const pdf = await getDocument({
    data: new Uint8Array(pdfBytes),
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  // Returns: { pages: [{ width, height, tokens: [{ str, x, y, w, h }] }] }
  //   where x, y are BOTTOM-LEFT origin, normalized 0-1 to page dimensions
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // Assemble tokens; pdfjs items have transform=[a,b,c,d,e,f] where e=x,f=y (baseline)
    // Height ~= item.height (font size).
    const tokens = content.items
      .filter(it => it.str && it.str.trim())
      .map(it => {
        const x = it.transform[4];
        const y = it.transform[5];
        return {
          str: it.str,
          x: x / vp.width,
          y: y / vp.height,
          w: (it.width || 0) / vp.width,
          h: (it.height || 12) / vp.height,
        };
      });
    pages.push({ width: vp.width, height: vp.height, tokens });
  }
  return pages;
}

// Convert DocuSeal field area (top-left, 0-1) to bottom-left 0-1 for comparison
function dsAreaToBL(area) {
  return {
    x: area.x,
    y: 1 - area.y - area.h, // bottom of field in bottom-left coords
    yTop: 1 - area.y, // top of field
    w: area.w,
    h: area.h,
    page: area.page || 0,
  };
}

// ---------------------------------------------------------------------------
// LABEL DERIVATION — find nearest label text for a field's position
// ---------------------------------------------------------------------------

/**
 * For a field at (fx, fy, fw, fh), find the label text.
 * Strategy:
 *   1. Look for text tokens immediately to the LEFT on the same visual row
 *      (baseline within field's vertical range).
 *   2. If none found, look ABOVE (within one line height).
 *   3. If still none, look for text overlapping the field (rare — placeholder text).
 * Assemble contiguous tokens into a phrase.
 */
function findLabelForField(field, pageTokens, pageWidth, pageHeight) {
  const area = (field.areas || [])[0];
  if (!area) return null;
  const bl = dsAreaToBL(area);
  // Field center + bounds
  const fyCenter = bl.y + bl.h / 2;
  const fxLeft = bl.x;
  const fxRight = bl.x + bl.w;
  const rowTol = Math.max(bl.h * 0.7, 0.012); // row tolerance in fractional units

  // Filter tokens: same page, baseline near field vertical center
  const onSameRow = pageTokens.filter(tk => Math.abs(tk.y - fyCenter) < rowTol);
  const leftOfField = onSameRow
    .filter(tk => tk.x + tk.w < fxLeft + 0.005)
    .sort((a, b) => a.x - b.x);

  if (leftOfField.length > 0) {
    // Take the contiguous phrase closest to the field (rightmost tokens before field)
    const phrase = takeTrailingContiguousPhrase(leftOfField);
    if (phrase) return { text: phrase, source: 'left' };
  }

  // Try ABOVE: tokens whose baseline is above field top but within ~1 line
  const lineH = 0.016; // approx line height fraction
  const aboveBand = pageTokens
    .filter(tk => tk.y > bl.yTop && tk.y - bl.yTop < lineH * 1.5)
    .filter(tk => tk.x + tk.w > fxLeft - 0.02 && tk.x < fxRight + 0.02)
    .sort((a, b) => a.x - b.x);
  if (aboveBand.length > 0) {
    const phrase = collectLineTokens(aboveBand);
    if (phrase) return { text: phrase, source: 'above' };
  }

  // Overlapping (placeholder text)
  const overlapping = pageTokens
    .filter(tk => tk.y > bl.y - 0.005 && tk.y < bl.yTop + 0.005)
    .filter(tk => tk.x + tk.w > fxLeft - 0.005 && tk.x < fxRight + 0.005)
    .sort((a, b) => a.x - b.x);
  if (overlapping.length > 0) {
    const phrase = collectLineTokens(overlapping);
    if (phrase) return { text: phrase, source: 'overlap' };
  }

  return null;
}

// From tokens sorted by x, take the trailing contiguous phrase (allowing small gaps)
// PREFERS SHORT LABELS: stops as soon as a colon is encountered (":" typically
// ends a label), also stops on section markers like "1.", "A.", "B."
function takeTrailingContiguousPhrase(tokens) {
  if (tokens.length === 0) return '';
  const gapTol = 0.02;
  const result = [tokens[tokens.length - 1]];
  for (let i = tokens.length - 2; i >= 0; i--) {
    const prev = result[0];
    const curEnd = tokens[i].x + tokens[i].w;
    if (prev.x - curEnd > gapTol) break;
    // Stop at colon (end of a label like "Address:") or section markers
    if (/[:]/.test(tokens[i].str) && result.length > 0) break;
    if (/^\d+\.\s*$/.test(tokens[i].str)) break; // "1."
    result.unshift(tokens[i]);
  }
  const joined = result.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim();
  // Cap phrase length — over-long labels are almost never the right label
  if (joined.length > 60) return joined.slice(-60);
  return joined;
}

function collectLineTokens(tokens) {
  return tokens.map(t => t.str).join('').replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// SEMANTIC NAME DERIVATION
// ---------------------------------------------------------------------------

/**
 * Given a raw label text (from PDF) + field type + position, derive a clean
 * semantic name. Handles TREC-specific patterns:
 *   - "Seller" / "Buyer" party-name fields
 *   - "Lot", "Block", "Addition", "City of", "County of" property fields
 *   - "Sales Price" cash / financing amounts
 *   - "Sellers Contribution" seller concessions
 *   - "Option Fee" / "Termination Option"
 *   - Signature block "Buyer" / "Seller" labels
 * Falls back to snake-cased cleaned label.
 */
// TREC page-header / page-footer boilerplate — never use as label
const BOILERPLATE_RX = [
  /contract concerning/i,
  /address of property/i,
  /^page\s*\d/i,
  /promulgated by/i,
  /trec no\./i,
  /initialed for identification/i,
];

function isBoilerplate(text) {
  if (!text) return true;
  return BOILERPLATE_RX.some(rx => rx.test(text));
}

function deriveSemanticName(rawLabel, field, ctx) {
  if (!rawLabel) rawLabel = '';
  const clean = rawLabel
    .replace(/\(.*?\)/g, ' ') // remove parenthetical hints
    .replace(/[_:$*.,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const lower = clean.toLowerCase();

  // Reject boilerplate — return null to skip
  if (isBoilerplate(clean)) return null;

  // CONSERVATIVE mode: only high-confidence TREC patterns get renamed.
  // Otherwise return null (keep existing name).
  // This is set via ctx.conservative flag from --conservative CLI arg.
  const conservative = ctx.conservative;

  // Only high-confidence matches — require SPECIFIC label patterns AND
  // a plausible field context (right type, right position on page).
  const area = ctx.field.areas[0];

  // TREC "PARTIES: The parties to this contract are (Seller) and (Buyer)"
  // — only fires for text fields at top of page 1
  if (/parties.*to this contract/i.test(lower) && area.page === 0 && area.y < 0.16 && field.type === 'text') {
    return area.x < 0.5 ? "Seller's Name" : "Buyer's Name";
  }
  // "(Seller) and" label sits just before the Buyer blank on same line
  if (/^and$/i.test(clean) && area.page === 0 && area.y < 0.16 && field.type === 'text') {
    return "Buyer's Name";
  }

  // Property description fields (page 0 top ~y=0.21)
  if (area.page === 0 && area.y > 0.19 && area.y < 0.25) {
    if (/^lot$/i.test(clean) || /a land lot/i.test(lower)) return 'Lot';
    if (/^block$/i.test(clean)) return 'Block';
    if (/^addition city of$/i.test(lower)) return area.x < 0.35 ? 'Addition' : 'City';
    if (/^county of$/i.test(lower)) return 'County';
    if (/^texas known as$/i.test(lower)) return 'Property Address';
  }

  // Financing amounts — narrow to page 0 middle
  if (area.page === 0 && field.type === 'text' && area.y > 0.55 && area.y < 0.75) {
    if (/cash portion of sales price/i.test(lower)) return 'Cash Portion of Sales Price';
  }
  if (field.type === 'checkbox' && /sum of all financing/i.test(lower)) return 'Financing Amount';

  // Sales price — only exact
  if (/^sales price$/i.test(clean) && field.type === 'text') return 'Sales Price';

  // Earnest money — only exact
  if (/^earnest money$/i.test(clean) && field.type === 'text') return 'Earnest Money Amount';

  // Option fee — only when label is exactly "Option Fee" nearby
  if (/^option fee$/i.test(clean) && field.type === 'text') return 'Option Fee';
  if (/^option fee in the form of$/i.test(lower) && field.type === 'text') return 'Option Fee';

  // Closing date — exact only
  if (/^closing date$/i.test(clean) && field.type === 'text') return 'Closing Date';

  // Title company — only match exact label
  if (/^title company$/i.test(clean) && field.type === 'text') return 'Title Company';

  // Broker — only exact patterns
  if (/^listing broker firm$/i.test(lower) && field.type === 'text') return 'Listing Broker Firm';
  if (/^other broker firm$/i.test(lower) && field.type === 'text') return 'Other Broker Firm';

  // Signature block role labels — signature-field context only
  if (/^buyer$/i.test(clean)) {
    return field.type === 'signature' ? 'Buyer Signature'
      : field.type === 'date' ? 'Buyer Date'
      : field.type === 'initials' ? 'Buyer Initials'
      : null;
  }
  if (/^seller$/i.test(clean)) {
    return field.type === 'signature' ? 'Seller Signature'
      : field.type === 'date' ? 'Seller Date'
      : field.type === 'initials' ? 'Seller Initials'
      : null;
  }

  // Conservative mode: skip everything not matched above
  if (conservative) return null;

  // Fallback — clean up whatever text we found; cap length
  if (clean && clean.length <= 60 && clean.length >= 3) {
    return titleCase(clean.slice(0, 60));
  }

  // Last resort — use field type + coords hash
  return null; // caller will skip
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// SUBMITTER ROLE ASSIGNMENT
// ---------------------------------------------------------------------------

/**
 * Determine which submitter (Buyer 1 / Seller 1 / Buyer 2 / Seller 2 / shared)
 * a field belongs to. Rules:
 *   1. Signature/initial/date fields — respect what auto-place-signatures set
 *      (Buyer* fields go to Buyer 1 by name convention)
 *   2. Party name fields ("Seller's Name" / "Buyer's Name") — go to Seller 1 /
 *      Buyer 1 respectively
 *   3. Amount fields (Sales Price, Financing, Earnest) — Buyer 1 (buyer pays)
 *   4. Property fields (Lot, Block, City) — Buyer 1 (buyer's agent typically
 *      populates the property description in the offer)
 *   5. Title/closing/broker fields — Buyer 1 by default (interior deal info
 *      typically populated once, shared to both sides at signing)
 *   6. Signature-block "Seller" labels — Seller 1
 *   7. Signature-block "Buyer" labels — Buyer 1
 */
function deriveSubmitterRole(semanticName, field, ctx) {
  const lower = (semanticName || '').toLowerCase();
  // Sig fields: honor existing name convention
  if (['signature', 'initials', 'date'].includes(field.type)) {
    if (/seller 2/i.test(lower)) return 'Seller 2';
    if (/buyer 2/i.test(lower)) return 'Buyer 2';
    if (/seller/i.test(lower)) return 'Seller 1';
    if (/buyer/i.test(lower)) return 'Buyer 1';
    // Fallback for footer initials by X position
    return field.areas[0].x < 0.5 ? 'Buyer 1' : 'Seller 1';
  }
  // Seller name field
  if (/^seller'?s name/i.test(lower)) return 'Seller 1';
  if (/^buyer'?s name/i.test(lower)) return 'Buyer 1';
  // Everything else — Buyer 1 (buyer's agent typically fills the deal doc)
  return 'Buyer 1';
}

// ---------------------------------------------------------------------------
// IS FIELD "SIGNATURE-ISH" (leave alone — placed by auto-place-signatures)
// ---------------------------------------------------------------------------

function isSignatureField(f) {
  return ['signature', 'initials', 'date'].includes(f.type);
}

// Is the current name already "good enough"?
function hasSemanticName(name) {
  if (!name) return false;
  const bad = [
    /^text\d+$/i,
    /^check\s*box\d+$/i,
    /^undefined$/i,
    /^field\d+$/i,
    /^\d+$/,
    /^untitled/i,
  ];
  if (bad.some(rx => rx.test(name.trim()))) return false;
  // If it's a fragment starting with a section number, treat as low quality
  if (/^\d+\s+[A-Z]/i.test(name)) return false;
  // Very short — probably not semantic
  if (name.trim().length < 3) return false;
  return true;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const opts = {
    template: (() => {
      const i = argv.indexOf('--template');
      return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) : null;
    })(),
    apply: argv.includes('--apply'),
    verbose: argv.includes('--verbose') || argv.includes('-v'),
    force: argv.includes('--force'),
    includeSig: argv.includes('--include-sig'),
    conservative: argv.includes('--conservative'),
  };

  if (!opts.template) {
    console.log('Usage: node scripts/docuseal-relabel-fields.mjs --template <id> [--apply] [--verbose] [--force]');
    console.log('');
    console.log('  --template <id>   DocuSeal template ID to relabel');
    console.log('  --apply           Write changes to DocuSeal (default: dry-run)');
    console.log('  --verbose         Show per-field label derivation');
    console.log('  --force           Relabel fields that already have "good" names');
    console.log('  --include-sig     Also touch signature/initial/date fields');
    console.log('  --conservative    Only rename fields matching high-confidence TREC patterns');
    process.exit(1);
  }

  console.log(`\n=== DocuSeal field relabeler — template ${opts.template} ===`);
  console.log(`Mode: ${opts.apply ? 'APPLY (will write)' : 'DRY-RUN'}\n`);

  // Fetch template
  const tpl = await ds(`/templates/${opts.template}`);
  console.log(`Template: ${tpl.name}`);
  console.log(`Fields: ${tpl.fields.length}`);
  console.log(`Submitters: ${tpl.submitters.map(s => s.name).join(', ')}`);
  console.log(`Documents: ${tpl.documents.map(d => d.filename).join(', ')}`);

  // Ensure we have 4 canonical submitters — Buyer 1 / Seller 1 / Buyer 2 / Seller 2
  // (docuseal-auto-place-signatures.js creates these; if missing, we'll add them)
  const ROLES = ['Buyer 1', 'Seller 1', 'Buyer 2', 'Seller 2'];
  const submitterMap = {};
  const submitters = [];
  const crypto = await import('crypto');
  for (const roleName of ROLES) {
    const existing = tpl.submitters.find(s => s.name.toLowerCase() === roleName.toLowerCase());
    if (existing) {
      submitterMap[roleName] = existing.uuid;
      submitters.push({ name: roleName, uuid: existing.uuid });
    } else {
      const uuid = crypto.randomUUID();
      submitterMap[roleName] = uuid;
      submitters.push({ name: roleName, uuid });
      console.log(`  (creating new submitter: ${roleName})`);
    }
  }

  // Download PDF
  const docUrl = tpl.documents[0].url;
  if (!docUrl) throw new Error('No document URL on template');
  console.log(`\nDownloading PDF: ${docUrl.slice(0, 70)}...`);
  const pdfRes = await fetch(docUrl);
  const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
  console.log(`PDF size: ${pdfBytes.length} bytes`);

  // Extract text with positions
  console.log('Extracting positional text via pdfjs-dist...');
  const pages = await extractPositionalText(pdfBytes);
  console.log(`Pages: ${pages.length}`);

  // Relabel loop
  const changes = [];
  let relabeledCount = 0;
  let submitterChangedCount = 0;
  let skippedNoLabel = 0;
  let skippedAlreadyGood = 0;
  let skippedSig = 0;

  // Track which submitter UUIDs exist in the incoming template. Any field pointing
  // to a UUID NOT in our new submitters list will be reassigned to Buyer 1 (default)
  // — otherwise it becomes an orphan (invisible in DocuSeal UI).
  const newSubmitterUuids = new Set(Object.values(submitterMap));
  const defaultUuid = submitterMap['Buyer 1'];

  const newFields = tpl.fields.map(f => {
    // Always remap orphaned submitter UUIDs to Buyer 1 default
    const currentSubmitterUuid = f.submitter_uuid;
    const isOrphan = !newSubmitterUuids.has(currentSubmitterUuid);

    // Skip sig fields unless --include-sig
    if (isSignatureField(f) && !opts.includeSig) {
      skippedSig++;
      // Even for skipped sig fields, if orphaned, default to Buyer 1 by X position
      if (isOrphan) {
        const sigRole = f.areas[0]?.x < 0.5 ? 'Buyer 1' : 'Seller 1';
        return { ...f, submitter_uuid: submitterMap[sigRole] };
      }
      return f;
    }
    // Skip if already good and not --force
    if (!opts.force && hasSemanticName(f.name)) {
      skippedAlreadyGood++;
      if (isOrphan) return { ...f, submitter_uuid: defaultUuid };
      return f;
    }

    const area = (f.areas || [])[0];
    if (!area) {
      if (isOrphan) return { ...f, submitter_uuid: defaultUuid };
      return f;
    }
    const pageIdx = area.page || 0;
    const pageData = pages[pageIdx];
    if (!pageData) return f;

    const labelResult = findLabelForField(f, pageData.tokens, pageData.width, pageData.height);
    const rawLabel = labelResult ? labelResult.text : '';
    const semanticName = deriveSemanticName(rawLabel, f, { field: f, conservative: opts.conservative });
    if (!semanticName) {
      skippedNoLabel++;
      if (opts.verbose) {
        console.log(`  [SKIP no-label] ${f.type} p=${pageIdx} x=${area.x.toFixed(3)} y=${area.y.toFixed(3)}  raw="${rawLabel.slice(0, 40)}"  name="${f.name}"`);
      }
      if (isOrphan) return { ...f, submitter_uuid: defaultUuid };
      return f;
    }

    const newRole = deriveSubmitterRole(semanticName, f, { field: f });
    const newSubmitterUuid = submitterMap[newRole];
    const currentRole = tpl.submitters.find(s => s.uuid === currentSubmitterUuid)?.name || '(none)';

    const nameChanged = semanticName !== f.name;
    const roleChanged = newSubmitterUuid !== currentSubmitterUuid;
    if (nameChanged) relabeledCount++;
    if (roleChanged) submitterChangedCount++;

    if (nameChanged || roleChanged) {
      changes.push({
        pageIdx,
        oldName: f.name,
        newName: semanticName,
        oldRole: currentRole,
        newRole,
        rawLabel: rawLabel.slice(0, 60),
        labelSource: labelResult?.source,
        type: f.type,
      });
      if (opts.verbose) {
        console.log(`  p${pageIdx + 1} ${f.type.padEnd(8)} y=${area.y.toFixed(3)} x=${area.x.toFixed(3)}  "${f.name.slice(0, 30).padEnd(30)}" -> "${semanticName.padEnd(30)}"  role: ${currentRole} -> ${newRole}`);
      }
    }
    return {
      ...f,
      name: semanticName,
      submitter_uuid: newSubmitterUuid,
    };
  });

  // Deduplicate names: if two fields end up with same name, append _p{page}_{n}
  const nameCounts = {};
  newFields.forEach(f => {
    if (f.name && !isSignatureField(f)) {
      nameCounts[f.name] = (nameCounts[f.name] || 0) + 1;
    }
  });
  const dupTracker = {};
  for (let i = 0; i < newFields.length; i++) {
    const f = newFields[i];
    if (!f.name || isSignatureField(f)) continue;
    if (nameCounts[f.name] > 1) {
      dupTracker[f.name] = (dupTracker[f.name] || 0) + 1;
      const page = (f.areas[0]?.page || 0) + 1;
      const suffix = ` p${page}#${dupTracker[f.name]}`;
      newFields[i] = { ...f, name: f.name + suffix };
    }
  }
  const dedupedCount = Object.values(dupTracker).reduce((a, b) => a + b, 0);

  console.log(`\n=== SUMMARY ===`);
  console.log(`Deduplicated names: ${dedupedCount}`);
  console.log(`Total fields: ${tpl.fields.length}`);
  console.log(`Names changed: ${relabeledCount}`);
  console.log(`Submitters reassigned: ${submitterChangedCount}`);
  console.log(`Skipped (already good name): ${skippedAlreadyGood}`);
  console.log(`Skipped (no label found): ${skippedNoLabel}`);
  console.log(`Skipped (signature field): ${skippedSig}`);

  // Write dry-run report
  const reportPath = path.join(REPO_ROOT, '.tmp', `docuseal-relabel-${opts.template}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify({
    templateId: opts.template,
    templateName: tpl.name,
    mode: opts.apply ? 'APPLY' : 'DRY-RUN',
    totalFields: tpl.fields.length,
    relabeledCount,
    submitterChangedCount,
    skippedAlreadyGood,
    skippedNoLabel,
    skippedSig,
    changes,
  }, null, 2));
  console.log(`\nReport: ${reportPath}`);

  if (!opts.apply) {
    console.log('\n(dry-run — pass --apply to write to DocuSeal)');
    return;
  }

  // PUT to DocuSeal
  console.log('\nWriting to DocuSeal...');
  const putBody = { fields: newFields, submitters };
  await ds(`/templates/${opts.template}`, {
    method: 'PUT',
    body: JSON.stringify(putBody),
  });
  console.log(`APPLIED. Edit URL: https://docuseal.com/templates/${opts.template}/edit`);
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
