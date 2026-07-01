const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const pdfBytes = fs.readFileSync('.tmp/carter-hoa-retest.pdf');
  const doc = await PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  
  const fields = form.getFields();
  console.log('All checkbox fields (complete):');
  fields.forEach(f => {
    const name = f.getName();
    if (name.includes('checkbox') || name.match(/^[0-9]/) || name.match(/Check/)) {
      try {
        const val = f.getValue();
        console.log(`  [${val ? 'X' : ' '}] ${name.substring(0, 80)}`);
      } catch (e) {
        console.log(`  [ ] ${name.substring(0, 80)}`);
      }
    }
  });
})();
