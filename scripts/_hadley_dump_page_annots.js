// Dump page annotations including widget rectangle and AP refs
const { PDFDocument, PDFName, PDFRef } = require('pdf-lib');
const fs = require('fs');

(async () => {
  const inPath = process.argv[2];
  const pageNum = parseInt(process.argv[3] || '9', 10);
  const bytes = fs.readFileSync(inPath);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const page = doc.getPages()[pageNum - 1];
  const annotsArr = page.node.Annots();
  if (!annotsArr) { console.log('no annots'); return; }
  const arr = annotsArr.asArray ? annotsArr.asArray() : annotsArr;
  console.log('Page', pageNum, 'annots count:', arr.length);
  for (let i = 0; i < arr.length; i++) {
    let annot = arr[i];
    let ref = annot;
    if (annot.constructor.name === 'PDFRef') {
      annot = doc.context.lookup(ref);
    }
    if (!annot || !annot.get) continue;
    const subtype = annot.get(PDFName.of('Subtype'));
    const T = annot.get(PDFName.of('T'));
    const Rect = annot.get(PDFName.of('Rect'));
    const Parent = annot.get(PDFName.of('Parent'));
    let parentT = null;
    if (Parent && Parent.constructor.name === 'PDFRef') {
      const p = doc.context.lookup(Parent);
      parentT = p ? p.get(PDFName.of('T')) : null;
    }
    const AP = annot.get(PDFName.of('AP'));
    const V = annot.get(PDFName.of('V'));
    console.log(`  [${i}] subtype=${subtype} T=${T} parentT=${parentT} V=${V} Rect=${Rect ? Rect.toString().slice(0,60) : 'none'} AP=${AP ? 'yes' : 'no'}`);
  }
})();
