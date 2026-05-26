// Print every field's widget rectangle + page index so we can correlate to
// the visual layout of the TREC 39-10 form.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'trec-forms', '39-10.pdf'));
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const pageRefMap = new Map();
  pages.forEach((p, idx) => pageRefMap.set(p.ref.tag, idx));

  const form = doc.getForm();
  for (const f of form.getFields()) {
    const name = f.getName();
    const type = f.constructor.name;
    const widgets = f.acroField.getWidgets();
    widgets.forEach((w, wi) => {
      const rect = w.getRectangle();
      const pageRef = w.P() || w.dict.get(require('pdf-lib').PDFName.of('P'));
      let pageIdx = '?';
      try {
        const ref = w.dict.get(require('pdf-lib').PDFName.of('P'));
        if (ref && ref.tag) pageIdx = pageRefMap.get(ref.tag) ?? '?';
      } catch (e) {}
      console.log(JSON.stringify({
        name, type,
        widget: wi,
        page: pageIdx,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      }));
    });
  }

  // Print page heights so we know which y is "near top" vs "near bottom"
  console.log('---');
  pages.forEach((p, i) => {
    const { width, height } = p.getSize();
    console.log('PAGE ' + i + ' size: ' + Math.round(width) + ' x ' + Math.round(height));
  });
})();
