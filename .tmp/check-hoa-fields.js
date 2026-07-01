const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  const fields = form.getFields();
  
  // Look for the resale cert checkboxes
  fields.forEach(field => {
    const name = field.getName();
    if (name.includes('does') || name.includes('resale')) {
      try {
        const val = field.getValue();
        console.log(`${name}: ${val}`);
      } catch (e) {
        console.log(`${name}: (read error)`);
      }
    }
  });
})();
