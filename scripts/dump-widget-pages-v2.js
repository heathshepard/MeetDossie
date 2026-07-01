// Alternative widget-page lookup using direct page array iteration via Annots
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

const ASSET = path.resolve(__dirname, '..', 'api', '_assets', 'trec-resale-base64.js');
const raw = require(ASSET);
const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;

(async () => {
  const pdfDoc = await PDFDocument.load(Buffer.from(base64, 'base64'), { ignoreEncryption: true });
  const pages = pdfDoc.getPages();

  // For each page, list its annotation widgets and resolve back to field name
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const annots = page.node.Annots();
    if (!annots) continue;
    const arr = annots.asArray();
    for (const ann of arr) {
      const dict = ann.lookup ? ann.lookup(PDFName.of('Parent')) : null;
      // ann is PDFRef; dereference
      const annDict = pdfDoc.context.lookup(ann);
      if (!annDict) continue;
      const subtype = annDict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.encodedName !== '/Widget') continue;
      // Get field name (traverse parent chain to find /T)
      let cur = annDict;
      let fieldName = null;
      while (cur) {
        const t = cur.get(PDFName.of('T'));
        if (t) { fieldName = t.decodeText(); break; }
        const parent = cur.get(PDFName.of('Parent'));
        if (!parent) break;
        cur = pdfDoc.context.lookup(parent);
      }
      const rect = annDict.get(PDFName.of('Rect'));
      let rectStr = '';
      if (rect && rect.asArray) {
        const r = rect.asArray().map(n => n.numberValue || 0);
        rectStr = `x=${Math.round(r[0])} y=${Math.round(r[1])} w=${Math.round(r[2]-r[0])} h=${Math.round(r[3]-r[1])}`;
      }
      console.log(`page=${i} ${rectStr} field=${JSON.stringify(fieldName)}`);
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
