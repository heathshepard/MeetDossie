// Dump the actual appearance stream of a widget
const { PDFDocument, PDFName, PDFRef } = require('pdf-lib');
const zlib = require('zlib');
const fs = require('fs');

(async () => {
  const inPath = process.argv[2];
  const fieldName = process.argv[3];
  const bytes = fs.readFileSync(inPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const field = form.getTextField(fieldName);
  const widgets = field.acroField.getWidgets();
  for (const w of widgets) {
    const ap = w.dict.get(PDFName.of('AP'));
    if (!ap) { console.log('No AP'); continue; }
    const n = ap.get(PDFName.of('N'));
    if (n && n.constructor.name === 'PDFRef') {
      const nObj = doc.context.lookup(n);
      console.log('N stream type:', nObj ? nObj.constructor.name : 'null');
      const dict = nObj.dict;
      console.log('Stream dict:', dict ? dict.toString().slice(0, 400) : 'none');
      if (nObj && nObj.contents) {
        let raw = Buffer.from(nObj.contents);
        let decoded;
        try {
          decoded = zlib.inflateSync(raw).toString('latin1');
        } catch (e) {
          decoded = raw.toString('latin1');
        }
        console.log('--- CONTENT START ---');
        console.log(decoded);
        console.log('--- CONTENT END ---');
      }
    } else if (n) {
      console.log('Inline N:', n.toString().slice(0, 200));
    }
  }
})();
