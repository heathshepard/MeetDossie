// Inspect AcroForm fields on the TREC 39-9 fillable PDF
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

(async () => {
  const pdfPath = path.join(__dirname, 'trec-forms', '39-9-fillable.pdf');
  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();

  console.log(`Total fields: ${fields.length}\n`);
  fields.forEach((f, i) => {
    const type = f.constructor.name;
    const name = f.getName();
    let extra = '';
    try {
      if (type === 'PDFTextField') {
        extra = `  default=${JSON.stringify(f.getText() || '')}  maxLen=${f.getMaxLength() ?? 'none'}`;
      } else if (type === 'PDFCheckBox') {
        extra = `  checked=${f.isChecked()}`;
      }
    } catch (e) { /* ignore */ }
    console.log(`${i + 1}. [${type}] ${name}${extra}`);
  });
})();
