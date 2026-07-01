const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  // Get the A.1 checkbox
  const a1Field = form.getField('1 Within');
  
  try {
    const val = a1Field.getValue();
    if (val === 'On' || val === 'Yes' || val === 'X') {
      console.log('✓ A.1 "1 Within" is CHECKED');
    } else {
      console.log(`A.1 "1 Within" value: "${val}" (may be checked depending on value format)`);
    }
  } catch (e) {
    console.log(`Could not read A.1 value: ${e.message}`);
  }
})();
