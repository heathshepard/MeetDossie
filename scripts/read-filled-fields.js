// Read field values back from a filled PDF to verify what value each field name actually holds
// Usage: node scripts/read-filled-fields.js <path-to-pdf>

const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const filePath = process.argv[2];
  if (!filePath) { console.error('Usage: node read-filled-fields.js <pdf>'); process.exit(1); }
  const bytes = fs.readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  console.log(`Field count: ${fields.length}`);
  for (const f of fields) {
    const name = f.getName();
    const type = f.constructor.name.replace('PDF', '');
    let v = '';
    try {
      if (type === 'TextField') v = f.getText() || '';
      else if (type === 'CheckBox') v = f.isChecked() ? 'CHECKED' : '';
    } catch (e) { v = `<err: ${e.message}>`; }
    if (v) console.log(`  [${type}] ${JSON.stringify(name)} = ${JSON.stringify(v)}`);
  }
})();
