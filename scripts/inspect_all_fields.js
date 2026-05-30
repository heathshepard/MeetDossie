// Enumerate all AcroForm fields in every TREC/TAR base64 PDF asset.
// Run: node scripts/inspect_all_fields.js
// Output: field name, type, and max length for every field in every form.

const { PDFDocument } = require('pdf-lib');
const path = require('path');

const ASSETS = [
  { key: 'resale-contract',        file: 'trec-resale-base64.js' },
  { key: 'financing-addendum',     file: 'trec-financing-base64.js' },
  { key: 'termination-notice',     file: 'trec-termination-base64.js' },
  { key: 'wire-fraud-warning',     file: 'tar-wire-fraud-base64.js' },
  { key: 'hoa-addendum',           file: 'trec-hoa-addendum-base64.js' },
  { key: 'lead-paint-addendum',    file: 'trec-lead-paint-base64.js' },
  { key: 'sellers-disclosure',     file: 'trec-sellers-disclosure-base64.js' },
  { key: 'amendment',              file: 'trec-39-10-base64.js' },
  { key: 'buyer-rep-agreement',    file: 'tar-buyer-rep-base64.js' },
  { key: 'appraisal-termination',  file: 'trec-49-1-base64.js' },
  { key: 't47-affidavit',          file: 't47-affidavit-base64.js' },
  { key: 'unimproved-property',    file: 'trec-unimproved-property-base64.js' },
  { key: 'new-home-incomplete',    file: 'trec-new-home-incomplete-base64.js' },
  { key: 'new-home-complete',      file: 'trec-new-home-complete-base64.js' },
  { key: 'farm-ranch',             file: 'trec-farm-ranch-base64.js' },
];

async function inspect(key, file) {
  const assetPath = path.join(__dirname, '..', 'api', '_assets', file);
  let base64;
  try {
    base64 = require(assetPath);
  } catch (e) {
    console.log('\n=== ' + key + ' (' + file + ') ===');
    console.log('  LOAD ERROR: ' + e.message);
    return;
  }

  const pdfBytes = Buffer.from(base64, 'base64');
  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  } catch (e) {
    console.log('\n=== ' + key + ' (' + file + ') ===');
    console.log('  PDF LOAD ERROR: ' + e.message);
    return;
  }

  const form = pdfDoc.getForm();
  const fields = form.getFields();

  console.log('\n=== ' + key + ' (' + file + ') === ' + fields.length + ' fields');
  if (fields.length === 0) {
    console.log('  (no AcroForm fields — flat PDF)');
    return;
  }

  for (const field of fields) {
    const name = field.getName();
    const type = field.constructor.name;
    let extra = '';
    try {
      if (type === 'PDFTextField') {
        const max = field.getMaxLength();
        extra = max ? ' [maxLen=' + max + ']' : '';
        const val = field.getText();
        if (val) extra += ' [default=' + JSON.stringify(val.slice(0, 40)) + ']';
      } else if (type === 'PDFCheckBox') {
        const checked = field.isChecked();
        if (checked) extra = ' [checked]';
      } else if (type === 'PDFRadioGroup') {
        const opts = field.getOptions();
        extra = ' [options=' + JSON.stringify(opts) + ']';
      } else if (type === 'PDFDropdown') {
        const opts = field.getOptions();
        extra = ' [options=' + JSON.stringify(opts.slice(0, 5)) + (opts.length > 5 ? '...' : '') + ']';
      }
    } catch (e) {
      extra = ' [inspect-err: ' + e.message + ']';
    }
    console.log('  [' + type.replace('PDF', '') + '] ' + JSON.stringify(name) + extra);
  }
}

(async function main() {
  for (const asset of ASSETS) {
    await inspect(asset.key, asset.file);
  }
  console.log('\n--- done ---');
})();
