// Flatten a PDF (regenerate appearances + lock fields)
// Strategy: re-set each text-field value to force pdf-lib to rebuild appearance stream
const { PDFDocument, PDFName } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const inPath = process.argv[2];
  const outPath = process.argv[3];
  if (!inPath || !outPath) {
    console.error('usage: node _hadley_flatten_pdf.js <in.pdf> <out.pdf>');
    process.exit(1);
  }
  const bytes = fs.readFileSync(inPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields();

  // 1) For every text field, drop the AP dict on widgets + re-set text — forces regeneration
  for (const f of fields) {
    if (f.constructor.name !== 'PDFTextField') continue;
    const name = f.getName();
    let v = '';
    try { v = f.getText() || ''; } catch (e) { continue; }
    // Remove pre-existing AP dict so pdf-lib must regenerate
    const widgets = f.acroField.getWidgets();
    for (const w of widgets) {
      try { w.dict.delete(PDFName.of('AP')); } catch (e) {}
    }
    // Re-set text (re-marks field needsAppearancesUpdate)
    try { f.setText(v); } catch (e) {}
  }

  try {
    form.updateFieldAppearances();
  } catch (e) {
    console.warn('updateFieldAppearances failed:', e.message);
  }
  try {
    form.flatten();
  } catch (e) {
    console.warn('flatten failed:', e.message);
  }
  const out = await doc.save();
  fs.writeFileSync(outPath, out);
  console.log('wrote', outPath);
})();
