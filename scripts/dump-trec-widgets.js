// Dump every AcroForm widget with PAGE INDEX + POSITION + TYPE + NAME
// for the priority TREC forms. Output is the ground-truth basis for the
// new _acroform fill modules.
//
// Usage: node scripts/dump-trec-widgets.js [form-name]
//
// Output: console + writes JSON to Shepard-Ventures/Engineering/trec-acroform-inventories/<form>.json

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const FORMS = {
  'trec-20-18': 'api/_assets/trec-resale-base64.js',
  'trec-40':    'api/_assets/trec-financing-base64.js',
  'trec-36-11': 'api/_assets/trec-hoa-addendum-base64.js',
  'op-l':       'api/_assets/trec-lead-paint-base64.js',
  'trec-39-10': 'api/_assets/trec-39-10-base64.js',
  'trec-49-1':  'api/_assets/trec-49-1-base64.js',
};

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = 'C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\Engineering\\trec-acroform-inventories';

async function dump(formKey) {
  const relPath = FORMS[formKey];
  if (!relPath) {
    console.error('Unknown form:', formKey);
    process.exit(1);
  }
  const assetPath = path.join(ROOT, relPath);
  const raw = require(assetPath);
  const base64 = (raw && typeof raw === 'object' && raw.base64Pdf) ? raw.base64Pdf : raw;
  const pdfBytes = Buffer.from(base64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  const pages = pdfDoc.getPages();

  const widgets = [];
  for (const field of fields) {
    const name = field.getName();
    const type = field.constructor.name.replace('PDF', '');
    let maxLen = null;
    try { if (type === 'TextField') maxLen = field.getMaxLength() || null; } catch (e) { /* */ }

    // Each field can have multiple widgets (per page). Iterate them.
    const widgetList = field.acroField.getWidgets();
    for (const widget of widgetList) {
      const rect = widget.getRectangle();
      // Determine which page this widget is on
      const pageRef = widget.dict.get(require('pdf-lib').PDFName.of('P'));
      let pageIndex = -1;
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].ref === pageRef) { pageIndex = i; break; }
      }
      widgets.push({
        name,
        type,
        maxLen,
        page: pageIndex,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }
  }

  // sort by page then y descending (PDF y starts from bottom) then x
  widgets.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (b.y !== a.y) return b.y - a.y;
    return a.x - b.x;
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, formKey + '-widgets.json');
  fs.writeFileSync(outPath, JSON.stringify(widgets, null, 2));
  console.log('Wrote', widgets.length, 'widgets to', outPath);

  // Also print compact summary by page
  let lastPage = -1;
  for (const w of widgets) {
    if (w.page !== lastPage) {
      console.log('\n=== Page ' + w.page + ' ===');
      lastPage = w.page;
    }
    const max = w.maxLen ? ` maxLen=${w.maxLen}` : '';
    console.log(`  p${w.page} y=${w.y} x=${w.x} w=${w.w}h=${w.h} [${w.type}]${max} ${JSON.stringify(w.name)}`);
  }
}

(async () => {
  const arg = process.argv[2];
  if (arg && arg !== 'all') {
    await dump(arg);
  } else {
    for (const key of Object.keys(FORMS)) {
      await dump(key);
      console.log('\n');
    }
  }
})().catch(e => { console.error(e); process.exit(1); });
