const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

(async () => {
  const pdfPath = path.join(__dirname, '../api/_assets/trec-20-18-raw.pdf');
  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBuffer);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  const fieldsList = fields.map(f => ({
    name: f.getName(),
    type: f.constructor.name
  }));

  const result = JSON.stringify({ total: fieldsList.length, fields: fieldsList }, null, 2);
  console.log(result);
  fs.writeFileSync(path.join(__dirname, '.trec-20-18-acroform-raw.json'), result, 'utf8');
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
