const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  const fields = form.getFields();
  fields.forEach(f => {
    if (f.getName() === '1 Within') {
      console.log('A.1 field found');
      try {
        // Check if it's marked/checked
        const widget = f.acroField;
        if (widget && widget.V) {
          console.log('  V (value):', widget.V);
        }
        if (widget && widget.AP) {
          console.log('  Has appearance stream');
        }
      } catch (e) {
        console.log('  Error checking:', e.message);
      }
    }
  });
})();
