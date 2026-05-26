// Fill every field with its own name as the value so we can visually identify
// which field maps to which paragraph on the form.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

(async () => {
  const src = path.join(__dirname, 'trec-forms', '39-10.pdf');
  const out = path.join(__dirname, 'trec-forms', '39-10-mapped.pdf');
  const doc = await PDFDocument.load(fs.readFileSync(src));
  const form = doc.getForm();
  for (const f of form.getFields()) {
    const name = f.getName();
    const t = f.constructor.name;
    try {
      if (t === 'PDFTextField') {
        f.setText('<<' + name + '>>');
      }
    } catch (e) {
      console.log('Skip ' + name + ': ' + e.message);
    }
  }
  // Don't flatten — keep fields editable so positions are clear
  fs.writeFileSync(out, await doc.save());
  console.log('Wrote ' + out);
})();
