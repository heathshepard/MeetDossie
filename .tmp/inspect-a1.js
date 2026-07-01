const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  const a1Field = form.getField('1 Within');
  
  console.log('A.1 field type:', a1Field.constructor.name);
  console.log('A.1 field properties:', Object.keys(a1Field));
})();
