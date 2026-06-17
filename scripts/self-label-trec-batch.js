// scripts/self-label-trec-batch.js
// Batch self-labeling tool: for each target TREC form, fill every AcroForm text field
// with its own name, save the PDF, and render each page to PNG via pdftoppm.
//
// Forms WITHOUT AcroForm fields are logged as "flat — needs coordinate fill" and skipped.
// Forms whose base64 module is not present are logged as "not found".
//
// Output per form (form-id is a short slug):
//   .tmp-self-labeled-{id}.pdf
//   .tmp-self-labeled-{id}/pg-*.png
//   .tmp-self-labeled-{id}-fieldnames.json (only when AcroForm fields present)
//
// Summary report: .tmp-self-labeling-summary.md
//
// Atlas — 2026-06-16 — batch visual field-name identification

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');
const ASSETS = path.join(REPO, 'api', '_assets');
const PDFTOPPM = 'C:\\Users\\Heath Shepard\\AppData\\Local\\Microsoft\\WinGet\\Packages\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\\poppler-25.07.0\\Library\\bin\\pdftoppm.exe';

// Form catalog — id, display name, candidate base64 module filenames (first found wins).
const FORMS = [
  { id: '40',     name: 'TREC 40 Financing Addendum',          candidates: ['trec-financing-base64.js'] },
  { id: '38-7',   name: 'TREC 38-7 Termination Notice',        candidates: ['trec-termination-base64.js'] },
  { id: '39-10',  name: 'TREC 39-10 Amendment',                candidates: ['trec-39-10-base64.js', 'trec-amendment-39-11-base64.js'] },
  { id: '23-20',  name: 'TREC 23-20 New Home Incomplete',      candidates: ['trec-new-home-incomplete-23-20-base64.js', 'trec-new-home-incomplete-base64.js'] },
  { id: '24-20',  name: 'TREC 24-20 New Home Completed',       candidates: ['trec-new-home-complete-24-20-base64.js', 'trec-new-home-complete-base64.js'] },
  { id: '25-17',  name: 'TREC 25-17 Farm & Ranch',             candidates: ['trec-farm-ranch-25-17-base64.js', 'trec-farm-ranch-base64.js'] },
  { id: '36-11',  name: 'TREC 36-11 HOA Addendum',             candidates: ['trec-hoa-addendum-36-11-base64.js', 'trec-hoa-addendum-base64.js'] },
  { id: '11-7',   name: 'TREC 11-7 Backup Contract',           candidates: ['trec-backup-contract-11-9-base64.js', 'trec-backup-contract-base64.js'] },
  { id: 'op-l',   name: 'OP-L Lead-Based Paint',               candidates: ['trec-lead-paint-base64.js'] },
  { id: 'op-h',   name: "OP-H Seller's Disclosure",            candidates: ['trec-sellers-disclosure-55-1-base64.js', 'trec-sellers-disclosure-base64.js'] },
];

function loadBase64(modulePath) {
  // Clear require cache so we don't keep huge strings in memory across loops
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  let b64 = null;
  if (typeof mod === 'string') b64 = mod;
  else if (mod && typeof mod.default === 'string') b64 = mod.default;
  else if (mod && typeof mod.base64 === 'string') b64 = mod.base64;
  else if (mod && typeof mod.PDF_BASE64 === 'string') b64 = mod.PDF_BASE64;
  else if (mod) {
    for (const k of Object.keys(mod)) {
      if (typeof mod[k] === 'string' && mod[k].length > 1000) { b64 = mod[k]; break; }
    }
  }
  if (!b64) throw new Error('No base64 string export found. Keys: ' + Object.keys(mod || {}).slice(0, 20).join(','));
  if (b64.startsWith('data:')) b64 = b64.split(',')[1];
  return b64;
}

function findCandidate(candidates) {
  for (const c of candidates) {
    const p = path.join(ASSETS, c);
    if (fs.existsSync(p)) return { file: c, path: p };
  }
  return null;
}

async function processForm(form) {
  const result = {
    id: form.id,
    name: form.name,
    status: 'unknown',
    moduleFile: null,
    textFieldCount: 0,
    totalFields: 0,
    fieldTypes: {},
    pages: 0,
    outPdf: null,
    outDir: null,
    error: null,
  };

  const found = findCandidate(form.candidates);
  if (!found) {
    result.status = 'not_found';
    result.error = `none of [${form.candidates.join(', ')}] exist in api/_assets/`;
    return result;
  }
  result.moduleFile = found.file;

  try {
    const b64 = loadBase64(found.path);
    const bytes = Buffer.from(b64, 'base64');
    console.log(`[${form.id}] PDF bytes:`, bytes.length);

    const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const formObj = pdfDoc.getForm();
    const fields = formObj.getFields();
    result.totalFields = fields.length;

    const textFieldNames = [];
    for (const field of fields) {
      const t = field.constructor.name;
      result.fieldTypes[t] = (result.fieldTypes[t] || 0) + 1;
      if (t === 'PDFTextField') {
        const name = field.getName();
        textFieldNames.push(name);
        try {
          field.setText(name);
          result.textFieldCount++;
        } catch (e) {
          console.warn(`[${form.id}] setText failed on '${name}':`, e.message);
        }
      }
    }

    console.log(`[${form.id}] field types:`, JSON.stringify(result.fieldTypes));
    console.log(`[${form.id}] text fields labeled:`, result.textFieldCount);

    if (result.textFieldCount === 0) {
      // Either flat PDF with no AcroForm, or has only checkboxes/radio (still useful to render but no labels)
      result.status = result.totalFields === 0 ? 'flat_no_acroform' : 'acroform_no_text_fields';
    } else {
      result.status = 'acroform_labeled';
    }

    // Update appearances so the labels actually render in the rasterized output
    try {
      const helv = await pdfDoc.embedFont('Helvetica');
      formObj.updateFieldAppearances(helv);
    } catch (e) {
      console.warn(`[${form.id}] updateFieldAppearances failed:`, e.message);
    }

    const outPdf = path.join(REPO, `.tmp-self-labeled-${form.id}.pdf`);
    const out = await pdfDoc.save();
    fs.writeFileSync(outPdf, out);
    result.outPdf = outPdf;
    console.log(`[${form.id}] wrote`, path.basename(outPdf), out.length, 'bytes');

    const outDir = path.join(REPO, `.tmp-self-labeled-${form.id}`);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    // Clean prior pages
    for (const f of fs.readdirSync(outDir)) {
      if (f.endsWith('.png')) fs.unlinkSync(path.join(outDir, f));
    }
    const prefix = path.join(outDir, 'pg');
    console.log(`[${form.id}] rendering pages…`);
    execFileSync(PDFTOPPM, ['-r', '150', '-png', outPdf, prefix], { stdio: 'inherit' });
    const pngs = fs.readdirSync(outDir).filter(f => f.endsWith('.png')).sort();
    result.pages = pngs.length;
    result.outDir = outDir;
    console.log(`[${form.id}] pages rendered:`, pngs.length);

    if (result.textFieldCount > 0) {
      fs.writeFileSync(
        path.join(REPO, `.tmp-self-labeled-${form.id}-fieldnames.json`),
        JSON.stringify({ id: form.id, name: form.name, totalTextFields: result.textFieldCount, names: textFieldNames }, null, 2)
      );
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message;
    console.error(`[${form.id}] FATAL:`, e.message);
  }

  return result;
}

(async () => {
  const results = [];
  for (const form of FORMS) {
    console.log(`\n=== Processing ${form.id} — ${form.name} ===`);
    const r = await processForm(form);
    results.push(r);
  }

  // Build summary report
  const withAcroForm = results.filter(r => r.status === 'acroform_labeled');
  const noTextOnly = results.filter(r => r.status === 'acroform_no_text_fields');
  const flat = results.filter(r => r.status === 'flat_no_acroform');
  const notFound = results.filter(r => r.status === 'not_found');
  const errored = results.filter(r => r.status === 'error');

  const lines = [];
  lines.push('# Self-Labeled TREC PDFs — 2026-06-16');
  lines.push('');
  lines.push('Generated by `scripts/self-label-trec-batch.js`. Each form was loaded with pdf-lib; every');
  lines.push('AcroForm text field was filled with its own field name, the form appearances were updated,');
  lines.push('and pages were rasterized to PNG at 150 DPI via `pdftoppm`.');
  lines.push('');

  lines.push('## Forms with AcroForm text fields (ready for visual mapping)');
  lines.push('');
  if (withAcroForm.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const r of withAcroForm) {
      lines.push(`- **${r.name}** (id \`${r.id}\`) — ${r.textFieldCount} text fields labeled, ${r.pages} pages → \`.tmp-self-labeled-${r.id}/pg-*.png\``);
      lines.push(`  - Module: \`api/_assets/${r.moduleFile}\``);
      lines.push(`  - Field types: ${JSON.stringify(r.fieldTypes)}`);
      lines.push(`  - Field-name list: \`.tmp-self-labeled-${r.id}-fieldnames.json\``);
    }
  }
  lines.push('');

  lines.push('## Forms with AcroForm but no text fields (checkboxes/radios only — partial mapping)');
  lines.push('');
  if (noTextOnly.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const r of noTextOnly) {
      lines.push(`- **${r.name}** (id \`${r.id}\`) — ${r.totalFields} fields total, 0 text → \`.tmp-self-labeled-${r.id}/pg-*.png\``);
      lines.push(`  - Module: \`api/_assets/${r.moduleFile}\``);
      lines.push(`  - Field types: ${JSON.stringify(r.fieldTypes)}`);
    }
  }
  lines.push('');

  lines.push('## Forms WITHOUT AcroForm (flat PDFs — need coordinate fill, separate workflow)');
  lines.push('');
  if (flat.length === 0) {
    lines.push('_(none)_');
  } else {
    for (const r of flat) {
      lines.push(`- **${r.name}** (id \`${r.id}\`) — flat PDF, ${r.pages} pages rendered for reference at \`.tmp-self-labeled-${r.id}/pg-*.png\``);
      lines.push(`  - Module: \`api/_assets/${r.moduleFile}\``);
    }
  }
  lines.push('');

  lines.push('## Forms not found in `api/_assets/`');
  lines.push('');
  if (notFound.length === 0) {
    lines.push('_(none — all candidate modules located)_');
  } else {
    for (const r of notFound) {
      lines.push(`- **${r.name}** (id \`${r.id}\`) — ${r.error}`);
    }
  }
  lines.push('');

  if (errored.length > 0) {
    lines.push('## Errors during processing');
    lines.push('');
    for (const r of errored) {
      lines.push(`- **${r.name}** (id \`${r.id}\`) — module \`${r.moduleFile}\` — error: ${r.error}`);
    }
    lines.push('');
  }

  lines.push('## Counts');
  lines.push('');
  lines.push(`- With AcroForm text fields: **${withAcroForm.length}**`);
  lines.push(`- AcroForm but no text fields: **${noTextOnly.length}**`);
  lines.push(`- Flat (no AcroForm): **${flat.length}**`);
  lines.push(`- Not found: **${notFound.length}**`);
  lines.push(`- Errored: **${errored.length}**`);
  lines.push('');

  const summaryPath = path.join(REPO, '.tmp-self-labeling-summary.md');
  fs.writeFileSync(summaryPath, lines.join('\n'));
  console.log('\nSummary written to', summaryPath);

  // One-line console recap
  console.log(`\n=== DONE ===`);
  console.log(`AcroForm w/ text: ${withAcroForm.length} | AcroForm no text: ${noTextOnly.length} | Flat: ${flat.length} | Not found: ${notFound.length} | Errors: ${errored.length}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
