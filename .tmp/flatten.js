const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  
  // Flatten all form fields
  doc.flatten();
  
  const pdfBytesFlat = await doc.save();
  fs.writeFileSync('.tmp/carter-hoa-retest-flat.pdf', pdfBytesFlat);
  console.log('Flattened PDF saved');
})();
