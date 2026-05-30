// Extract complete AcroForm field coordinate map from TREC 20-17 resale contract.
// Outputs JSON + human-readable text sorted by page → y (top to bottom) → x (left to right).
// Run: node scripts/inspect_trec20-17_coords.js

const { PDFDocument, PDFName } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

const ASSET_PATH = path.join(__dirname, '..', 'api', '_assets', 'trec-resale-base64.js');
const JSON_OUT   = path.join(__dirname, 'trec-20-17-field-map.json');
const TEXT_OUT   = path.join(__dirname, 'trec-20-17-field-map-readable.txt');

async function main() {
  const base64 = require(ASSET_PATH);
  const pdfBytes = Buffer.from(base64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });

  const pages = pdfDoc.getPages();
  const form  = pdfDoc.getForm();
  const fields = form.getFields();

  // Build page-ref → 1-indexed page number map
  const pageRefToIndex = new Map();
  for (let i = 0; i < pages.length; i++) {
    pageRefToIndex.set(pages[i].ref.toString(), i + 1);
  }

  // Page dimensions (all 612×792 for this PDF but compute per-page to be safe)
  const pageSizes = pages.map(p => p.getSize());

  const records = [];

  for (const field of fields) {
    const name = field.getName();
    const type = field.constructor.name.replace('PDF', ''); // TextField, CheckBox, etc.

    const widgets = field.acroField.getWidgets();
    for (const widget of widgets) {
      // Determine page number
      const pRef = widget.dict.get(PDFName.of('P'));
      const pageNum = pRef ? (pageRefToIndex.get(pRef.toString()) || null) : null;
      const pageIdx = pageNum ? pageNum - 1 : 0;
      const pageW = pageSizes[pageIdx].width;
      const pageH = pageSizes[pageIdx].height;

      // Bounding rect in PDF points (origin = bottom-left)
      const rect = widget.getRectangle();
      const xPts = rect.x;
      const yPts = rect.y; // bottom of field in PDF coords
      const wPts = rect.width;
      const hPts = rect.height;

      // Convert to fractions of page (y=0 at TOP for reading-order sort)
      const xFrac = xPts / pageW;
      const yFromTop = (pageH - yPts - hPts) / pageH; // top edge of field, 0=top
      const wFrac = wPts / pageW;
      const hFrac = hPts / pageH;

      const record = {
        name,
        type,
        page: pageNum,
        x: Math.round(xFrac * 10000) / 10000,
        y: Math.round(yFromTop * 10000) / 10000,
        w: Math.round(wFrac * 10000) / 10000,
        h: Math.round(hFrac * 10000) / 10000,
        maxLength: null,
        defaultValue: '',
      };

      // Type-specific extras
      if (type === 'TextField') {
        try {
          const ml = field.getMaxLength();
          record.maxLength = ml != null ? ml : null;
        } catch (_) {}
        try {
          const val = field.getText();
          record.defaultValue = val || '';
        } catch (_) {}
      } else if (type === 'CheckBox') {
        try {
          record.defaultValue = field.isChecked() ? 'checked' : '';
        } catch (_) {}
        record.onValue = 'On';
      } else if (type === 'RadioGroup') {
        try {
          record.options = field.getOptions();
          record.defaultValue = field.getSelected() || '';
        } catch (_) {}
      } else if (type === 'Dropdown') {
        try {
          record.options = field.getOptions();
          record.defaultValue = field.getSelected() ? field.getSelected()[0] : '';
        } catch (_) {}
      }

      records.push(record);
    }
  }

  // Sort: page asc → y asc (top to bottom) → x asc (left to right)
  records.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > 0.005) return a.y - b.y;
    return a.x - b.x;
  });

  // Write JSON
  fs.writeFileSync(JSON_OUT, JSON.stringify(records, null, 2));
  console.log('Wrote', JSON_OUT);

  // Write human-readable
  const lines = [];
  let lastPage = null;
  const typeCounts = {};
  const pageCounts = {};

  for (const r of records) {
    if (r.page !== lastPage) {
      if (lastPage !== null) lines.push('');
      lines.push('--- Page ' + r.page + ' ---');
      lastPage = r.page;
    }

    typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
    pageCounts[r.page] = (pageCounts[r.page] || 0) + 1;

    const pageStr  = ('Page ' + r.page).padEnd(7);
    const xStr     = ('x=' + r.x.toFixed(4)).padEnd(10);
    const yStr     = ('y=' + r.y.toFixed(4)).padEnd(10);
    const typeStr  = r.type.padEnd(12);
    const nameStr  = JSON.stringify(r.name);
    let extras = '';
    if (r.type === 'TextField') {
      extras = r.maxLength != null ? '  [maxLen: ' + r.maxLength + ']' : '  [maxLen: null]';
      if (r.defaultValue) extras += '  [default: ' + JSON.stringify(r.defaultValue.slice(0, 40)) + ']';
    } else if (r.type === 'CheckBox') {
      if (r.defaultValue === 'checked') extras = '  [checked]';
    } else if (r.type === 'RadioGroup') {
      extras = '  [options: ' + JSON.stringify(r.options) + ']';
    }

    lines.push(pageStr + '  ' + xStr + ' ' + yStr + '  ' + typeStr + '  ' + nameStr + extras);
  }

  lines.push('');
  lines.push('--- Summary ---');
  lines.push('Total fields: ' + records.length);
  lines.push('');
  lines.push('By type:');
  for (const [t, n] of Object.entries(typeCounts).sort()) {
    lines.push('  ' + t.padEnd(14) + n);
  }
  lines.push('');
  lines.push('By page:');
  for (const [p, n] of Object.entries(pageCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push('  Page ' + p.padEnd(4) + n + ' fields');
  }

  fs.writeFileSync(TEXT_OUT, lines.join('\n'));
  console.log('Wrote', TEXT_OUT);

  // Print summary to stdout
  console.log('\nTotal fields:', records.length);
  console.log('\nBy type:');
  for (const [t, n] of Object.entries(typeCounts).sort()) {
    console.log(' ', t.padEnd(14), n);
  }
  console.log('\nBy page:');
  for (const [p, n] of Object.entries(pageCounts).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log('  Page', p, '->', n, 'fields');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
