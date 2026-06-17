/**
 * Atlas verification harness for Carter's AcroForm refactor (commit 6dfe23d).
 *
 * Loads field-map-resale-acroform.js, fills a test PDF via the same logic Carter
 * placed into fillResaleContractDocuSeal, writes .tmp-atlas-acroform-verify.pdf,
 * then dumps the actual list of AcroForm field names that exist in the PDF so
 * we can confirm whether Carter's mapped names are real.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIELD_MAP = require(path.join(REPO_ROOT, 'api/_assets/field-map-resale-acroform.js'));
const TREC_RESALE_B64 = require(path.join(REPO_ROOT, 'api/_assets/trec-resale-20-19-base64.js'));

const OUT_PDF = path.join(REPO_ROOT, '.tmp-atlas-acroform-verify.pdf');
const FIELDS_DUMP = path.join(REPO_ROOT, '.tmp-atlas-acroform-fields.json');

function formatMoney(value) {
  const n = Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (Number.isNaN(n)) return String(value);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatDate(value) {
  if (!value) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return String(value);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[parseInt(m[2], 10) - 1] + ' ' + parseInt(m[3], 10) + ', ' + m[1];
}

// Replicates Carter's fillResaleContractDocuSeal (second definition, line 509)
async function fillResaleContractDocuSeal(pdfDoc, fv) {
  const form = pdfDoc.getForm();
  const stats = { filled: [], notFound: [], errors: [] };

  for (const [semanticName, acroformName] of Object.entries(FIELD_MAP)) {
    const value = fv[semanticName];
    if (value === undefined || value === null || value === '') continue;

    try {
      const field = form.getField(acroformName);
      if (!field) {
        stats.notFound.push({ semanticName, acroformName });
        continue;
      }
      const fieldType = field.constructor.name;

      if (fieldType === 'PDFCheckBox') {
        if (value === true || value === 'true' || value === 1 || value === '1' || value === 'yes' || value === 'Yes') {
          field.check();
          stats.filled.push({ semanticName, acroformName, type: 'checkbox', value: 'CHECKED' });
        }
      } else if (fieldType === 'PDFTextField') {
        let displayValue = String(value);
        if (semanticName.includes('money') || semanticName.includes('amount') || semanticName.includes('price') || semanticName.includes('payment')) {
          displayValue = formatMoney(value);
        } else if (semanticName.includes('date')) {
          displayValue = formatDate(value);
        }
        field.setText(displayValue);
        stats.filled.push({ semanticName, acroformName, type: 'text', value: displayValue });
      } else {
        field.setText(String(value));
        stats.filled.push({ semanticName, acroformName, type: fieldType, value: String(value) });
      }
    } catch (e) {
      stats.errors.push({ semanticName, acroformName, error: e.message });
    }
  }

  return { pdfDoc, stats };
}

async function main() {
  const testFv = {
    buyer_name: 'Heath Shepard',
    seller_name: 'Josh Sissam',
    property_address: '123 Main St',
    sales_price: '500000',
    sale_price: '500000',
    earnest_money: '5000',
    earnest_money_amount: '5000',
    option_period_days: '10',
    option_days: '10',
    option_fee: '100',
    title_company_name: 'Kendall County Abstract',
    title_company: 'Kendall County Abstract',
    closing_date: '2026-07-16',
  };

  console.log('=== ATLAS VERIFY: Carter AcroForm refactor (commit 6dfe23d) ===\n');

  // Step 1: dump ALL real AcroForm field names in PDF
  const pdfBytes = Buffer.from(TREC_RESALE_B64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const allFields = form.getFields().map((f) => ({
    name: f.getName(),
    type: f.constructor.name,
  }));
  fs.writeFileSync(FIELDS_DUMP, JSON.stringify(allFields, null, 2));
  console.log(`AcroForm field count in PDF: ${allFields.length}`);
  console.log(`Field dump saved: ${FIELDS_DUMP}\n`);

  // Step 2: verify every name Carter mapped actually exists
  const mappedFieldNames = Object.values(FIELD_MAP);
  const realNames = new Set(allFields.map((f) => f.name));
  const carterClaimedButMissing = mappedFieldNames.filter((n) => !realNames.has(n));
  console.log(`Carter mapped ${mappedFieldNames.length} field names total.`);
  console.log(`Of those, ${carterClaimedButMissing.length} DO NOT EXIST in the actual PDF:`);
  carterClaimedButMissing.forEach((n) => {
    const semantic = Object.entries(FIELD_MAP).find(([k, v]) => v === n)?.[0];
    console.log(`  - "${n}"  (semantic: ${semantic})`);
  });
  console.log('');

  // Step 3: fill PDF
  const { pdfDoc: filled, stats } = await fillResaleContractDocuSeal(pdfDoc, testFv);

  console.log(`Filled count: ${stats.filled.length}`);
  stats.filled.forEach((f) => console.log(`  + ${f.semanticName} -> "${f.acroformName}" [${f.type}] = ${f.value}`));
  console.log(`\nNot-found count: ${stats.notFound.length}`);
  stats.notFound.forEach((f) => console.log(`  ? ${f.semanticName} -> "${f.acroformName}" NOT IN PDF`));
  console.log(`\nError count: ${stats.errors.length}`);
  stats.errors.forEach((f) => console.log(`  ! ${f.semanticName} -> "${f.acroformName}" :: ${f.error}`));

  const outBytes = await filled.save();
  fs.writeFileSync(OUT_PDF, outBytes);
  console.log(`\nFilled PDF written: ${OUT_PDF}  (${outBytes.length} bytes)`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
