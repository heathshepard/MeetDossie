// Print every field's widget rectangle + page index for the TREC 39-11 form
// so we can re-coordinate the FIELDS map in api/draft-amendment.js after
// the 39-11 revision inserted a new lender-repairs paragraph (6), shifting
// all subsequent paragraphs by one.
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

(async () => {
  const bytes = fs.readFileSync(path.join(__dirname, 'trec-forms', '39-11.pdf'));
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages();
  const pageRefMap = new Map();
  pages.forEach((p, idx) => pageRefMap.set(p.ref.tag, idx));

  const form = doc.getForm();
  console.log('=== TREC 39-11 ACROFORM FIELD INVENTORY ===\n');
  
  const fields = [];
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
      
      fields.push({
        name, type, widget: wi, page: pageIdx,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    });
  }

  // Sort by page, then by y (top-to-bottom), then x (left-to-right)
  fields.sort((a, b) => {
    const pa = String(a.page).charCodeAt(0);
    const pb = String(b.page).charCodeAt(0);
    if (pa !== pb) return pa - pb;
    if (a.y !== b.y) return b.y - a.y; // Top-to-bottom (higher y first in PDF coords)
    return a.x - b.x;
  });

  // Print as JSON for easy parsing
  fields.forEach(f => {
    console.log(JSON.stringify(f));
  });

  // Print page heights so we know which y is "near top" vs "near bottom"
  console.log('\n=== PAGE DIMENSIONS ===\n');
  pages.forEach((p, i) => {
    const { width, height } = p.getSize();
    console.log('PAGE ' + i + ' size: ' + Math.round(width) + ' x ' + Math.round(height));
  });
})();
