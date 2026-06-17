// scripts/self-label-resale.js
// Self-labeling research tool: fill every AcroForm text field with its own name,
// save the PDF, then render each page to PNG via poppler pdftoppm.
//
// Output:
//   .tmp-self-labeled-resale.pdf
//   .tmp-self-labeled-resale/pg-*.png
//
// Atlas — 2026-06-15 — visual field-name identification

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');
const BASE64_MODULE = path.join(REPO, 'api', '_assets', 'trec-resale-20-19-base64.js');
const OUT_PDF = path.join(REPO, '.tmp-self-labeled-resale.pdf');
const OUT_DIR = path.join(REPO, '.tmp-self-labeled-resale');
const PDFTOPPM = 'C:\\Users\\Heath Shepard\\AppData\\Local\\Microsoft\\WinGet\\Packages\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\\poppler-25.07.0\\Library\\bin\\pdftoppm.exe';

(async () => {
  // 1. Load base64 module
  const mod = require(BASE64_MODULE);
  // The module may export differently — figure it out.
  let b64 = null;
  if (typeof mod === 'string') b64 = mod;
  else if (mod && typeof mod.default === 'string') b64 = mod.default;
  else if (mod && typeof mod.base64 === 'string') b64 = mod.base64;
  else if (mod && typeof mod.PDF_BASE64 === 'string') b64 = mod.PDF_BASE64;
  else {
    // Find first string-valued property that's long
    for (const k of Object.keys(mod || {})) {
      if (typeof mod[k] === 'string' && mod[k].length > 1000) { b64 = mod[k]; break; }
    }
  }
  if (!b64) throw new Error('Could not locate base64 string export in ' + BASE64_MODULE + '. Keys: ' + Object.keys(mod || {}).join(','));

  // Strip data: prefix if present
  if (b64.startsWith('data:')) b64 = b64.split(',')[1];

  const bytes = Buffer.from(b64, 'base64');
  console.log('PDF bytes:', bytes.length);

  // 2. Load with pdf-lib
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  console.log('Total form fields:', fields.length);

  const types = {};
  let textFieldCount = 0;
  const textFieldNames = [];

  for (const field of fields) {
    const t = field.constructor.name;
    types[t] = (types[t] || 0) + 1;
    if (t === 'PDFTextField') {
      const name = field.getName();
      textFieldNames.push(name);
      try {
        field.setText(name);
        textFieldCount++;
      } catch (e) {
        console.warn('Could not setText on', name, '-', e.message);
      }
    }
  }

  console.log('Field types:', JSON.stringify(types, null, 2));
  console.log('Text fields labeled:', textFieldCount);

  // Flatten? No — keep editable, but we want the text visible when rendered.
  // pdftoppm will rasterize the field appearance. Need form.updateFieldAppearances() so the text actually renders.
  try {
    const helv = await pdfDoc.embedFont('Helvetica');
    form.updateFieldAppearances(helv);
    console.log('Updated field appearances with Helvetica');
  } catch (e) {
    console.warn('updateFieldAppearances failed:', e.message);
  }

  // 3. Save
  const out = await pdfDoc.save();
  fs.writeFileSync(OUT_PDF, out);
  console.log('Wrote', OUT_PDF, out.length, 'bytes');

  // 4. Render pages
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const prefix = path.join(OUT_DIR, 'pg');
  console.log('Rendering via pdftoppm…');
  execFileSync(PDFTOPPM, ['-r', '150', '-png', OUT_PDF, prefix], { stdio: 'inherit' });
  const pngs = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png')).sort();
  console.log('Rendered pages:', pngs.length);
  for (const p of pngs) console.log(' -', p);

  // Save the field-name list for cross-reference
  fs.writeFileSync(
    path.join(REPO, '.tmp-self-labeled-resale-fieldnames.json'),
    JSON.stringify({ totalTextFields: textFieldCount, names: textFieldNames }, null, 2)
  );
  console.log('Wrote .tmp-self-labeled-resale-fieldnames.json');
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
