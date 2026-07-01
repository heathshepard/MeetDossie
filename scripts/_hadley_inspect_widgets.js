// Inspect widget DAs + values to diagnose appearance rendering issues
const { PDFDocument, PDFName } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const PDF_PATH = process.argv[2] || path.join('C:', 'tmp', 'hadley-gate', 'iter6', 'resale-contract.pdf');
const FILTER = process.argv[3] || 'Contract Concerning|Address of Property|Texas known as|Addition City of|Received by';
const filterRe = new RegExp(FILTER);

(async () => {
  const bytes = fs.readFileSync(PDF_PATH);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const form = doc.getForm();
  const fields = form.getFields();
  for (const f of fields) {
    const n = f.getName();
    if (!filterRe.test(n)) continue;
    const dict = f.acroField.dict;
    const da = dict.get(PDFName.of('DA'));
    let v = '';
    try {
      if (f.constructor.name === 'PDFTextField') v = f.getText() || '';
      else if (f.constructor.name === 'PDFCheckBox') v = f.isChecked() ? 'CHECKED' : '';
    } catch (e) {}
    const widgets = f.acroField.getWidgets();
    for (const w of widgets) {
      const r = w.getRectangle();
      const wDA = w.dict.get(PDFName.of('DA'));
      const ap = w.dict.get(PDFName.of('AP'));
      console.log(`${n} | type=${f.constructor.name} | rect=${r.x.toFixed(0)},${r.y.toFixed(0)} w=${r.width.toFixed(0)} h=${r.height.toFixed(0)} | fieldDA=${da ? da.toString() : 'none'} | widgetDA=${wDA ? wDA.toString() : 'inherits'} | hasAP=${ap ? 'yes' : 'NO'} | V="${v}"`);
    }
  }
})();
