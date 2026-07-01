const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  const fields = form.getFields();
  console.log('Total fields:', fields.length);
  console.log('\nAll field names:');
  fields.forEach((f, i) => {
    console.log(`  ${i+1}. ${f.getName()}`);
  });
})();
