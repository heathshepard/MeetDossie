// Probe field positions for TREC 20-17 Resale.
// For each AcroForm field, dump: name, type, page, rect [x1,y1,x2,y2], maxLen.
// Then we can correlate field names to physical paragraph locations.

const { PDFDocument } = require('pdf-lib');
const path = require('path');

(async () => {
  const assetPath = path.join('C:\\Users\\Heath Shepard\\Desktop\\MeetDossie', 'api', '_assets', 'trec-resale-base64.js');
  const base64 = require(assetPath);
  const pdfBytes = Buffer.from(base64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const pages = pdfDoc.getPages();

  const rows = [];
  for (const field of fields) {
    const name = field.getName();
    const type = field.constructor.name;
    let maxLen = '';
    try { const ml = field.getMaxLength && field.getMaxLength(); if (ml) maxLen = ml; } catch (e) {}

    // Get widget annotations -> page + rect
    let widgets = [];
    try { widgets = field.acroField.getWidgets(); } catch (e) { widgets = []; }
    for (const w of widgets) {
      const rect = w.getRectangle();
      // find page index
      let pageIdx = -1;
      try {
        const pRef = w.P();
        for (let i = 0; i < pages.length; i++) {
          if (pages[i].ref === pRef) { pageIdx = i; break; }
        }
      } catch (e) {}
      // alt: scan pages for matching annots
      if (pageIdx < 0) {
        for (let i = 0; i < pages.length; i++) {
          const annots = pages[i].node.Annots && pages[i].node.Annots();
          // skip — pdf-lib doesn't expose easily; fall through
        }
      }
      rows.push({ name, type, maxLen, page: pageIdx, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) });
    }
    if (widgets.length === 0) {
      rows.push({ name, type, maxLen, page: -1, x: '', y: '', w: '', h: '' });
    }
  }
  // sort by page then y descending then x ascending (top-down reading order)
  rows.sort((a, b) => (a.page - b.page) || (b.y - a.y) || (a.x - b.x));
  for (const r of rows) {
    console.log(`p${r.page}\ty=${r.y}\tx=${r.x}\tw=${r.w}\t[${r.type}]\t"${r.name}"${r.maxLen ? '\tmaxLen=' + r.maxLen : ''}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
