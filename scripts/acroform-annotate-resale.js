// Atlas: AcroForm field annotator for TREC Resale 20-19
// 1) Loads the base64 PDF
// 2) Extracts every AcroForm widget rect by page
// 3) Draws a red outline + field name at each position
// 4) Writes annotated PDF + JSON inventory
//
// Run: node scripts/acroform-annotate-resale.js

const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

const BASE_DIR = path.resolve(__dirname, '..');
const PDF_B64_MODULE = path.join(BASE_DIR, 'api', '_assets', 'trec-resale-20-19-base64.js');
const OUT_PDF = path.join(BASE_DIR, '.tmp-acroform-annotated.pdf');
const OUT_INVENTORY = path.join(BASE_DIR, '.tmp-acroform-inventory.json');

async function main() {
  // Load base64 PDF
  const mod = require(PDF_B64_MODULE);
  const b64 = mod.default || mod.base64 || mod.pdf || mod.pdfBase64 || mod.TREC_RESALE_20_19_BASE64 || mod;
  const b64Str = typeof b64 === 'string' ? b64 : (b64 && b64.toString ? b64.toString() : null);
  if (!b64Str || b64Str.length < 1000) {
    console.error('Could not extract base64 from module — exports:', Object.keys(mod));
    process.exit(1);
  }
  const cleanB64 = b64Str.replace(/^data:application\/pdf;base64,/, '');
  const pdfBytes = Buffer.from(cleanB64, 'base64');
  console.log(`Loaded PDF: ${pdfBytes.length} bytes`);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  const fields = form.getFields();
  console.log(`Total AcroForm fields: ${fields.length}`);

  const pages = pdfDoc.getPages();
  console.log(`Total pages: ${pages.length}`);

  const helv = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const inventory = [];

  // Pages map: page index -> array of {name, type, rect}
  const byPage = new Map();

  for (const field of fields) {
    const name = field.getName();
    const type = field.constructor.name; // PDFTextField, PDFCheckBox, etc.
    let widgets = [];
    try {
      widgets = field.acroField.getWidgets();
    } catch (e) {
      console.warn(`No widgets for field "${name}": ${e.message}`);
      continue;
    }

    widgets.forEach((widget, widgetIdx) => {
      let rect;
      try {
        rect = widget.getRectangle();
      } catch (e) {
        console.warn(`No rect for widget on "${name}": ${e.message}`);
        return;
      }

      // Locate the page this widget lives on
      const pageRef = widget.P();
      let pageIndex = -1;
      pages.forEach((p, idx) => {
        if (p.ref === pageRef) pageIndex = idx;
      });

      if (pageIndex < 0) {
        // Fallback: try matching against page.node.dict
        pages.forEach((p, idx) => {
          if (p.ref && pageRef && p.ref.toString() === pageRef.toString()) pageIndex = idx;
        });
      }

      const entry = {
        name,
        type,
        widgetIdx,
        pageIndex,
        rect: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          x2: rect.x + rect.width,
          y2: rect.y + rect.height,
        },
      };
      inventory.push(entry);

      if (pageIndex >= 0) {
        if (!byPage.has(pageIndex)) byPage.set(pageIndex, []);
        byPage.get(pageIndex).push(entry);
      }
    });
  }

  console.log(`Total widget rects collected: ${inventory.length}`);
  console.log('Per-page widget counts:');
  [...byPage.entries()].sort((a, b) => a[0] - b[0]).forEach(([pg, arr]) => {
    console.log(`  page ${pg}: ${arr.length} widgets`);
  });

  // Draw page index header on every page
  pages.forEach((page, idx) => {
    const { width: pw, height: ph } = page.getSize();
    page.drawRectangle({
      x: 0,
      y: ph - 22,
      width: 140,
      height: 22,
      color: rgb(1, 1, 0.6),
      borderColor: rgb(0, 0, 0),
      borderWidth: 0.5,
    });
    page.drawText(`PAGE INDEX ${idx} (1-based: pg ${idx + 1})`, {
      x: 4,
      y: ph - 16,
      size: 9,
      font: helvBold,
      color: rgb(0, 0, 0),
    });
  });

  // Annotate widgets
  for (const entry of inventory) {
    if (entry.pageIndex < 0) continue;
    const page = pages[entry.pageIndex];
    const { x, y, width, height } = entry.rect;

    // Red rectangle outline
    page.drawRectangle({
      x,
      y,
      width,
      height,
      borderColor: rgb(1, 0, 0),
      borderWidth: 0.8,
      opacity: 0,
      borderOpacity: 0.9,
    });

    // Label: field name above the rect
    // Truncate long names so they don't run across the whole page
    let label = entry.name;
    if (label.length > 55) label = label.slice(0, 52) + '...';

    const labelY = y + height + 1;
    const labelSize = 5;
    const labelWidth = helv.widthOfTextAtSize(label, labelSize);

    // Background for label so we can read it
    page.drawRectangle({
      x: x,
      y: labelY,
      width: Math.min(labelWidth + 2, 200),
      height: labelSize + 2,
      color: rgb(1, 1, 0.7),
      opacity: 0.85,
    });

    page.drawText(label, {
      x: x + 1,
      y: labelY + 1,
      size: labelSize,
      font: helv,
      color: rgb(0.8, 0, 0),
    });
  }

  const outBytes = await pdfDoc.save();
  fs.writeFileSync(OUT_PDF, outBytes);
  console.log(`Wrote ${OUT_PDF} (${outBytes.length} bytes)`);

  fs.writeFileSync(OUT_INVENTORY, JSON.stringify(inventory, null, 2));
  console.log(`Wrote ${OUT_INVENTORY}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
