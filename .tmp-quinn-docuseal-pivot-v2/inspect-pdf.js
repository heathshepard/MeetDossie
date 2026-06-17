// Inspect the rendered PDF to see if any fields are filled
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

async function main() {
  const buf = fs.readFileSync('.tmp-quinn-docuseal-pivot-v2/docuseal-template-pdf.pdf');
  const pdf = await PDFDocument.load(buf, { ignoreEncryption: true });
  console.log('Page count:', pdf.getPageCount());
  let fields = [];
  try { fields = pdf.getForm().getFields(); } catch (e) { console.log('Form parse error (ok):', e.message); }
  console.log('AcroForm field count:', fields.length);
  let filledCount = 0;
  for (const f of fields.slice(0, 50)) {
    try {
      const name = f.getName();
      const type = f.constructor.name;
      let value = '';
      if (typeof f.getText === 'function') value = f.getText() || '';
      else if (typeof f.isChecked === 'function') value = f.isChecked() ? 'CHECKED' : '';
      if (value) {
        filledCount++;
        console.log(`  ${name} (${type}) = ${value.slice(0, 60)}`);
      }
    } catch {}
  }
  console.log(`\nFilled fields shown: ${filledCount}`);

  // Extract text via simple text-content scan
  console.log('\n--- First 800 bytes of binary (looking for fill marker)---');
  const bytes = buf.subarray(0, 2000);
  console.log('Contains "Heath":', buf.includes('Heath'));
  console.log('Contains "Shepherd":', buf.includes('Shepherd'));
  console.log('Contains "Josh":', buf.includes('Josh'));
  console.log('Contains "Sissam":', buf.includes('Sissam'));
  console.log('Contains "500000":', buf.includes('500000'));
  console.log('Contains "Kendall":', buf.includes('Kendall'));
  console.log('Contains "Kendall County Abstract":', buf.includes('Kendall County Abstract'));
}

main().catch(err => console.error('ERROR:', err));
