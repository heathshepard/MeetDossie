const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  const fields = form.getFields();
  console.log('All checkboxes (subdivision options):');
  fields.forEach(f => {
    const name = f.getName();
    if (name.includes('Within') || name.includes('copy of the') || name.includes('Buyer has received') || name.includes('Buyer does not require delivery')) {
      try {
        const val = f.getValue();
        console.log(`  [${val ? 'X' : ' '}] ${name}`);
      } catch (e) {
        console.log(`  [ ] ${name}`);
      }
    }
  });
})();
