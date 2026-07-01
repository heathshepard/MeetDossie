// Dump the actual /On appearance stream for a checkbox widget
const { PDFDocument, PDFName, PDFRef } = require('pdf-lib');
const zlib = require('zlib');
const fs = require('fs');

(async () => {
  const inPath = process.argv[2];
  const fieldName = process.argv[3];
  const bytes = fs.readFileSync(inPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const field = form.getCheckBox(fieldName);
  const widgets = field.acroField.getWidgets();
  for (const w of widgets) {
    const ap = w.dict.get(PDFName.of('AP'));
    if (!ap) { console.log('No AP'); continue; }
    const n = ap.get(PDFName.of('N'));
    if (!n || n.constructor.name !== 'PDFDict') { console.log('N not a dict'); continue; }
    const keys = n.keys();
    for (const k of keys) {
      const v = n.get(k);
      console.log('Key:', k.toString());
      if (v.constructor.name === 'PDFRef') {
        const obj = doc.context.lookup(v);
        console.log('  obj type:', obj.constructor.name);
        if (obj && obj.dict) console.log('  dict:', obj.dict.toString().slice(0, 300));
        if (obj && obj.contents) {
          let raw = Buffer.from(obj.contents);
          let decoded;
          try { decoded = zlib.inflateSync(raw).toString('latin1'); }
          catch (e) { decoded = raw.toString('latin1'); }
          console.log('  contents:');
          console.log(decoded);
        }
      }
    }
  }
})();
