// Dump checkbox state including on/off appearance dictionary
const { PDFDocument, PDFName } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const inPath = process.argv[2];
  const fieldName = process.argv[3];
  const bytes = fs.readFileSync(inPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const field = form.getCheckBox(fieldName);
  if (!field) { console.log('not found'); return; }
  console.log('isChecked:', field.isChecked());
  const dict = field.acroField.dict;
  console.log('Field V:', dict.get(PDFName.of('V')));
  console.log('Field AS:', dict.get(PDFName.of('AS')));
  const widgets = field.acroField.getWidgets();
  for (const w of widgets) {
    const wd = w.dict;
    const Rect = wd.get(PDFName.of('Rect'));
    const V = wd.get(PDFName.of('V'));
    const AS = wd.get(PDFName.of('AS'));
    const AP = wd.get(PDFName.of('AP'));
    console.log('Widget Rect:', Rect ? Rect.toString().slice(0,60) : 'none');
    console.log('Widget V:', V);
    console.log('Widget AS:', AS ? AS.toString() : 'none');
    if (AP) {
      const N = AP.get(PDFName.of('N'));
      if (N && N.constructor.name === 'PDFDict') {
        console.log('AP /N keys:', N.keys().map(k => k.toString()));
      } else if (N) {
        console.log('AP /N:', N.toString().slice(0,100));
      }
    }
  }
})();
