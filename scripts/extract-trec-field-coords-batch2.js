#!/usr/bin/env node
/**
 * scripts/extract-trec-field-coords-batch2.js
 *
 * Extends the Interactive Editor's coordinate coverage beyond the original 4
 * forms (see extract-trec-field-coords.js) to the additional TREC/TAR forms
 * whose PDF bytes are already checked into api/_assets/*-base64.js.
 *
 * IMPORTANT: unlike the original script, this one does NOT read raw PDF
 * files from disk (they aren't committed to the repo — see CLAUDE.md
 * instructions: never re-download from trec.texas.gov, form numbers drift).
 * Instead it requires() the base64 asset module directly and decodes it,
 * exactly like api/_lib/resolve-blank-template-pdf.js does at runtime.
 *
 * Output JSON files land in api/_assets/ and follow the exact same shape as
 * the original script's output (see that file's header comment for the
 * field-level shape documentation).
 *
 * Run: "/mnt/c/Program Files/nodejs/node.exe" scripts/extract-trec-field-coords-batch2.js
 * (bare `node` is not on PATH in this WSL shell.)
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

const ASSETS = path.join(__dirname, '..', 'api', '_assets');

// Some *-base64.js assets export a bare string, others export
// { base64Pdf: '...' } (see trec-unimproved-property-base64.js,
// trec-farm-ranch-base64.js, trec-new-home-*-base64.js). Handle both, same
// as api/_lib/resolve-blank-template-pdf.js's loader() callers do implicitly
// by only ever using the bare-string ones — we need both here.
function loadBase64(assetFile) {
  const mod = require(path.join(ASSETS, assetFile));
  if (typeof mod === 'string') return mod;
  if (mod && typeof mod.base64Pdf === 'string') return mod.base64Pdf;
  if (mod && typeof mod.base64 === 'string') return mod.base64;
  throw new Error(`${assetFile}: unrecognized export shape (expected string or {base64Pdf})`);
}

// Minimal, cheap "friendly key" maps — only built where a field's raw
// pdf_field_name is unambiguous plain English (native AcroForm forms, not
// XFA-derived). Forms with only generic/XFA field names (TextField3[47], …)
// intentionally ship with reverseMap: {} — same precedent as the original
// 4-form script's financing-addendum/hoa-addendum/lead-paint-addendum
// entries. A form with no fieldmap still works for coordinate purposes; it
// just won't have canonical `key`/`label` annotations on its fields.
const REVERSE_MAPS = {
  // XFA-derived form (generic TextField1[0] names — see note on the
  // sellers-disclosure template below). The one exception: TextField1[0] is
  // reliably the top-of-page-1 "CONCERNING THE PROPERTY AT" blank (verified
  // visually — widest field on the page, y_pct ~12.6%, directly under the
  // form title). Confirmed via rendered-PDF + overlay screenshot.
  'sellers-disclosure': {
    'form1[0].#subform[0].TextField1[0]': { key: 'property_address', label: 'Property Address' },
  },
  'amendment': {
    'Street Address and City': { key: 'property_address', label: 'Property Address' },
  },
  'unimproved-property': {
    '1 PARTIES The parties to this contract are': { key: 'buyer_name', label: 'Buyer Name' },
    'Address of Property': { key: 'property_address', label: 'Property Address' },
    'A The closing of the sale will be on or before': { key: 'closing_date', label: 'Closing Date' },
    'earnest money of': { key: 'earnest_money', label: 'Earnest Money' },
  },
  'buyers-temp-lease': {
    'address': { key: 'property_address', label: 'Property Address' },
  },
  'sellers-temp-lease': {
    'address': { key: 'property_address', label: 'Property Address' },
  },
};

// Every other form below gets a 1-field reverseMap auto-detected at extract
// time: the first field whose pdf_field_name looks like a property-address
// blank (see ADDRESS_FIELD_PATTERNS). This is deliberately narrow — cheap,
// low-risk, and gives every form at least one real, verifiable overlay near
// the top of page 1.
const ADDRESS_FIELD_PATTERNS = [
  /^street address and city$/i,
  /^address of property$/i,
];

const TEMPLATES = [
  // --- Priority 1-3: listing-intake forms Heath asked for first ---
  {
    form_type: 'sellers-disclosure',
    asset_file: 'trec-sellers-disclosure-55-1-base64.js',
    out_file: 'trec-sellers-disclosure-55-1-coords.json',
    note: 'TREC 55-1 (current/primary — matches resolve-blank-template-pdf.js + dossiesign-prepare.js wiring; supersedes OP-H per ask-hadley.js). XFA-derived generic field names (TextField3[47] etc.) — no cheap reverseMap possible.',
  },
  {
    form_type: 'sellers-disclosure-op-h-legacy',
    asset_file: 'trec-sellers-disclosure-base64.js',
    out_file: 'trec-sellers-disclosure-op-h-coords.json',
    note: 'TREC 55-0/OP-H (legacy — still what fill-form.js FORM_CONFIGS actually fills for the chat auto-fill path via TREC_SELLERS_DISCLOSURE_B64). Generated for comparison/reference only; NOT wired into interactive-editor-init.js COORDS_FILES (see report — this is a pre-existing form-version mismatch bug, not something this task fixes).',
  },
  {
    form_type: 'amendment',
    asset_file: 'trec-amendment-39-11-base64.js',
    out_file: 'trec-amendment-39-11-coords.json',
  },
  // --- Priority 5: rest, roughly biggest-value first ---
  { form_type: 'unimproved-property', asset_file: 'trec-unimproved-property-base64.js', out_file: 'trec-unimproved-property-coords.json' },
  { form_type: 'buyers-temp-lease', asset_file: 'trec-buyers-temp-lease-base64.js', out_file: 'trec-buyers-temp-lease-coords.json' },
  { form_type: 'sellers-temp-lease', asset_file: 'trec-sellers-temp-lease-base64.js', out_file: 'trec-sellers-temp-lease-coords.json' },
  { form_type: 'seller-financing', asset_file: 'trec-seller-financing-base64.js', out_file: 'trec-seller-financing-coords.json' },
  { form_type: 'loan-assumption', asset_file: 'trec-loan-assumption-base64.js', out_file: 'trec-loan-assumption-coords.json' },
  { form_type: 'fixture-leases', asset_file: 'trec-fixture-leases-base64.js', out_file: 'trec-fixture-leases-coords.json' },
  { form_type: 'residential-leases', asset_file: 'trec-residential-leases-base64.js', out_file: 'trec-residential-leases-coords.json' },
  { form_type: 'backup-contract', asset_file: 'trec-backup-contract-11-9-base64.js', out_file: 'trec-backup-contract-coords.json' },
  { form_type: 'appraisal-termination', asset_file: 'trec-49-1-base64.js', out_file: 'trec-49-1-coords.json' },
  { form_type: 'sale-other-property', asset_file: 'trec-sale-other-property-base64.js', out_file: 'trec-sale-other-property-coords.json' },
  { form_type: 'oil-gas-minerals', asset_file: 'trec-oil-gas-minerals-base64.js', out_file: 'trec-oil-gas-minerals-coords.json' },
  { form_type: 'hydrostatic-testing', asset_file: 'trec-hydrostatic-testing-base64.js', out_file: 'trec-hydrostatic-testing-coords.json' },
  { form_type: 'environmental', asset_file: 'trec-environmental-base64.js', out_file: 'trec-environmental-coords.json' },
  { form_type: 'propane-gas', asset_file: 'trec-propane-gas-base64.js', out_file: 'trec-propane-gas-coords.json' },
  { form_type: 'coastal-area', asset_file: 'trec-coastal-area-base64.js', out_file: 'trec-coastal-area-coords.json' },
  { form_type: 'improvement-district', asset_file: 'trec-improvement-district-base64.js', out_file: 'trec-improvement-district-coords.json' },
  { form_type: 'short-sale', asset_file: 'trec-short-sale-base64.js', out_file: 'trec-short-sale-coords.json' },
  { form_type: 'gulf-waterway', asset_file: 'trec-gulf-waterway-base64.js', out_file: 'trec-gulf-waterway-coords.json' },
];

function fieldTypeFromPdfLibType(fieldConstructorName) {
  switch (fieldConstructorName) {
    case 'PDFTextField': return 'text';
    case 'PDFCheckBox':  return 'checkbox';
    case 'PDFRadioGroup':return 'radio';
    case 'PDFDropdown':  return 'dropdown';
    case 'PDFOptionList':return 'list';
    case 'PDFSignature': return 'signature';
    default:             return 'text';
  }
}

function round(n, digits) {
  const mul = Math.pow(10, digits);
  return Math.round(n * mul) / mul;
}

async function extractOne(template) {
  const b64 = loadBase64(template.asset_file);
  const bytes = Buffer.from(b64, 'base64');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const pageSizes = pages.map((p, i) => {
    const { width, height } = p.getSize();
    return { page: i + 1, width_pt: width, height_pt: height };
  });

  const pageRefToIndex = new Map();
  pages.forEach((p, i) => pageRefToIndex.set(p.ref, i + 1));

  const form = doc.getForm();
  const rawFields = form.getFields();

  // Build reverseMap: explicit entry from REVERSE_MAPS, else auto-detect an
  // address field (see ADDRESS_FIELD_PATTERNS) if this form has no explicit
  // map at all.
  let reverseMap = REVERSE_MAPS[template.form_type] || null;
  if (!reverseMap) {
    reverseMap = {};
    for (const field of rawFields) {
      const name = field.getName();
      if (ADDRESS_FIELD_PATTERNS.some((re) => re.test(name.trim()))) {
        reverseMap[name] = { key: 'property_address', label: 'Property Address' };
        break; // first match wins
      }
    }
  }

  const outFields = [];
  let fieldCountByType = {};

  for (const field of rawFields) {
    const pdfFieldName = field.getName();
    const type = fieldTypeFromPdfLibType(field.constructor.name);
    fieldCountByType[type] = (fieldCountByType[type] || 0) + 1;
    const widgets = field.acroField.getWidgets();

    for (let wi = 0; wi < widgets.length; wi += 1) {
      const widget = widgets[wi];
      const rect = widget.getRectangle();
      if (!rect) continue;

      let pageIndex = 1;
      const widgetPRef =
        widget.dict && typeof widget.dict.get === 'function'
          ? widget.dict.get(PDFName.of('P'))
          : null;
      if (widgetPRef && pageRefToIndex.has(widgetPRef)) {
        pageIndex = pageRefToIndex.get(widgetPRef);
      } else {
        for (let pi = 0; pi < pages.length; pi += 1) {
          const annots = pages[pi].node.Annots && pages[pi].node.Annots();
          if (!annots) continue;
          const size = annots.size ? annots.size() : (annots.array ? annots.array.length : 0);
          for (let ai = 0; ai < size; ai += 1) {
            const annot = annots.lookup ? annots.lookup(ai) : null;
            if (annot === widget.dict) {
              pageIndex = pi + 1;
              break;
            }
          }
        }
      }

      const pageSize = pageSizes[pageIndex - 1] || { width_pt: 612, height_pt: 792 };
      const { x, y, width: w, height: h } = rect;

      const x_pct = (x / pageSize.width_pt) * 100;
      const y_pct_topleft = ((pageSize.height_pt - y - h) / pageSize.height_pt) * 100;
      const w_pct = (w / pageSize.width_pt) * 100;
      const h_pct = (h / pageSize.height_pt) * 100;

      const mapEntry = reverseMap[pdfFieldName] || null;

      outFields.push({
        pdf_field_name: pdfFieldName,
        widget_index: wi,
        type,
        page: pageIndex,
        x_pt: round(x, 2),
        y_pt: round(y, 2),
        w_pt: round(w, 2),
        h_pt: round(h, 2),
        x_pct: round(x_pct, 3),
        y_pct: round(y_pct_topleft, 3),
        w_pct: round(w_pct, 3),
        h_pct: round(h_pct, 3),
        key: mapEntry ? mapEntry.key : null,
        label: mapEntry ? mapEntry.label : null,
        category: mapEntry ? mapEntry.category || null : null,
      });
    }
  }

  const out = {
    form_type: template.form_type,
    generated_at: new Date().toISOString(),
    source_asset: template.asset_file,
    page_count: pages.length,
    page_sizes: pageSizes.map((p) => ({
      page: p.page,
      width_pt: round(p.width_pt, 2),
      height_pt: round(p.height_pt, 2),
    })),
    field_count: outFields.length,
    field_count_by_type: fieldCountByType,
    mapped_field_count: outFields.filter((f) => f.key).length,
    fields: outFields,
  };
  if (template.note) out.note = template.note;

  const outPath = path.join(ASSETS, template.out_file);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `[ok] ${template.form_type}: ${outFields.length} widgets (${pages.length}pg), ${out.mapped_field_count} mapped -> ${template.out_file}`
  );
  return out;
}

async function main() {
  const results = [];
  for (const t of TEMPLATES) {
    try {
      results.push(await extractOne(t));
    } catch (err) {
      console.error(`[fail] ${t.form_type}: ${err.message}`);
    }
  }
  console.log(`\n[done] ${results.length}/${TEMPLATES.length} templates extracted.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
