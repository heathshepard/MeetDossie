#!/usr/bin/env node
/**
 * scripts/extract-trec-field-coords.js
 *
 * One-time (re-runnable) extraction of AcroForm field coordinates from the
 * four TREC PDF templates used by the Interactive Editor:
 *   - trec-20-18-raw.pdf  (One-to-Four Family Residential Contract)
 *   - trec-40-raw.pdf     (Third-Party Financing Addendum, aka 40-11)
 *   - trec-36-11-raw.pdf  (HOA Addendum)
 *   - op-l-raw.pdf        (Lead-Based Paint Addendum)
 *
 * Output JSON files land in api/_assets/:
 *   - trec-20-18-coords.json
 *   - trec-40-11-coords.json
 *   - trec-36-11-coords.json
 *   - op-l-coords.json
 *
 * Shape (per template):
 *   {
 *     "form_type": "resale-contract",
 *     "page_count": 16,
 *     "page_sizes": [{ page: 1, width_pt: 612, height_pt: 792 }, ...],
 *     "fields": [
 *       {
 *         "pdf_field_name": "buyer_name_1",
 *         "type": "text" | "checkbox" | "radio",
 *         "page": 1,
 *         "x_pt": 100, "y_pt": 200,        // PDF-native (origin bottom-left)
 *         "w_pt": 300, "h_pt": 20,
 *         "x_pct": 16.3, "y_pct": 74.7,    // top-left origin, percentage of page
 *         "w_pct": 49, "h_pct": 2.5,
 *         "key": "buyer_name",             // canonical column (if mapped)
 *         "label": "Buyer name"            // human label (if mapped)
 *       },
 *       ...
 *     ]
 *   }
 *
 * pct coordinates are what the frontend needs (matches FieldOverlay's
 * x_pct/y_pct/w_pct/h_pct contract). PDF-native pt coords are kept for
 * debugging and future server-side rendering.
 */

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const ASSETS = path.join(__dirname, '..', 'api', '_assets');

// Load the 20-18 friendly-key -> pdfFieldName map so we can annotate coords
// with `key` + `label` for fields we recognize semantically.
const trec2018FieldMap = require(path.join(ASSETS, 'trec-20-18-pdflib-fieldmap.js'));

// Build reverse index: pdfFieldName -> { key, label, category }
const trec2018Reverse = {};
for (const [friendlyKey, entry] of Object.entries(trec2018FieldMap)) {
  if (!entry || !entry.pdfFieldName) continue;
  trec2018Reverse[entry.pdfFieldName] = {
    key: friendlyKey,
    label: friendlyKey.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    category: entry.category || null,
  };
}

// Templates to process.
const TEMPLATES = [
  {
    form_type: 'resale-contract',
    pdf_file: 'trec-20-18-raw.pdf',
    out_file: 'trec-20-18-coords.json',
    reverseMap: trec2018Reverse,
  },
  {
    form_type: 'financing-addendum',
    pdf_file: 'trec-40-raw.pdf',
    out_file: 'trec-40-11-coords.json',
    reverseMap: {},
  },
  {
    form_type: 'hoa-addendum',
    pdf_file: 'trec-36-11-raw.pdf',
    out_file: 'trec-36-11-coords.json',
    reverseMap: {},
  },
  {
    form_type: 'lead-paint-addendum',
    pdf_file: 'op-l-raw.pdf',
    out_file: 'op-l-coords.json',
    reverseMap: {},
  },
];

function fieldTypeFromPdfLibType(fieldConstructorName) {
  // pdf-lib field classes: PDFTextField, PDFCheckBox, PDFRadioGroup,
  // PDFDropdown, PDFOptionList, PDFSignature.
  switch (fieldConstructorName) {
    case 'PDFTextField': return 'text';
    case 'PDFCheckBox':  return 'checkbox';
    case 'PDFRadioGroup':return 'radio';
    case 'PDFDropdown':  return 'dropdown';
    case 'PDFOptionList':return 'list';
    case 'PDFSignature': return 'signature';
    default:             return 'text';
  }
}

async function extractOne(template) {
  const pdfPath = path.join(ASSETS, template.pdf_file);
  if (!fs.existsSync(pdfPath)) {
    console.warn(`[skip] ${template.pdf_file} not found`);
    return null;
  }
  const bytes = fs.readFileSync(pdfPath);
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pages = doc.getPages();
  const pageSizes = pages.map((p, i) => {
    const { width, height } = p.getSize();
    return { page: i + 1, width_pt: width, height_pt: height };
  });

  // Map page ref -> page index (1-based) for widget -> page lookup.
  const pageRefToIndex = new Map();
  pages.forEach((p, i) => {
    pageRefToIndex.set(p.ref, i + 1);
  });

  const form = doc.getForm();
  const rawFields = form.getFields();
  const outFields = [];

  for (const field of rawFields) {
    const pdfFieldName = field.getName();
    const type = fieldTypeFromPdfLibType(field.constructor.name);
    const widgets = field.acroField.getWidgets();

    for (let wi = 0; wi < widgets.length; wi += 1) {
      const widget = widgets[wi];
      const rect = widget.getRectangle();
      if (!rect) continue;

      // Determine which page this widget lives on.
      // Widget dict has an entry P pointing to the page ref (for widgets that
      // are attached to a specific page).
      let pageIndex = 1;
      const widgetPRef =
        widget.dict && typeof widget.dict.get === 'function'
          ? widget.dict.get(require('pdf-lib').PDFName.of('P'))
          : null;
      if (widgetPRef && pageRefToIndex.has(widgetPRef)) {
        pageIndex = pageRefToIndex.get(widgetPRef);
      } else {
        // Fallback: linear scan pages for this widget ref
        for (let pi = 0; pi < pages.length; pi += 1) {
          const annots = pages[pi].node.Annots && pages[pi].node.Annots();
          if (!annots) continue;
          const size = annots.size ? annots.size() : (annots.array ? annots.array.length : 0);
          for (let ai = 0; ai < size; ai += 1) {
            const annot = annots.lookup ? annots.lookup(ai) : null;
            if (annot === widget.dict) {
              pageIndex = pi + 1;
              break;
            }
          }
        }
      }

      const pageSize = pageSizes[pageIndex - 1] || { width_pt: 612, height_pt: 792 };
      const { x, y, width: w, height: h } = rect;

      // PDF origin is bottom-left. Convert to top-left origin, percent-of-page.
      const x_pct = (x / pageSize.width_pt) * 100;
      const y_pct_topleft = ((pageSize.height_pt - y - h) / pageSize.height_pt) * 100;
      const w_pct = (w / pageSize.width_pt) * 100;
      const h_pct = (h / pageSize.height_pt) * 100;

      const mapEntry = template.reverseMap[pdfFieldName] || null;

      outFields.push({
        pdf_field_name: pdfFieldName,
        widget_index: wi,
        type,
        page: pageIndex,
        x_pt: round(x, 2),
        y_pt: round(y, 2),
        w_pt: round(w, 2),
        h_pt: round(h, 2),
        x_pct: round(x_pct, 3),
        y_pct: round(y_pct_topleft, 3),
        w_pct: round(w_pct, 3),
        h_pct: round(h_pct, 3),
        key: mapEntry ? mapEntry.key : null,
        label: mapEntry ? mapEntry.label : null,
        category: mapEntry ? mapEntry.category : null,
      });
    }
  }

  const out = {
    form_type: template.form_type,
    generated_at: new Date().toISOString(),
    source_pdf: template.pdf_file,
    page_count: pages.length,
    page_sizes: pageSizes.map((p) => ({
      page: p.page,
      width_pt: round(p.width_pt, 2),
      height_pt: round(p.height_pt, 2),
    })),
    field_count: outFields.length,
    mapped_field_count: outFields.filter((f) => f.key).length,
    fields: outFields,
  };

  const outPath = path.join(ASSETS, template.out_file);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(
    `[ok] ${template.form_type}: ${outFields.length} widgets, ${out.mapped_field_count} mapped -> ${template.out_file}`
  );
  return out;
}

function round(n, digits) {
  const mul = Math.pow(10, digits);
  return Math.round(n * mul) / mul;
}

async function main() {
  for (const t of TEMPLATES) {
    try {
      await extractOne(t);
    } catch (err) {
      console.error(`[fail] ${t.form_type}: ${err.message}`);
      console.error(err.stack);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
