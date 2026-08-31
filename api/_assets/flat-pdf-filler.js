// Utility functions for filling FLAT PDFs (no AcroForm fields) using coordinate-based text drawing
// These PDFs have no form fields, so we draw text directly at specified coordinates using pdf-lib.

const { rgb, StandardFonts } = require('pdf-lib');

// 2026-08-31 CARTER — font cache MUST be keyed per-pdfDoc, not a single
// module-level variable. A Vercel lambda instance stays warm across
// requests, and module-level state (this file is required once at cold
// start) persists between them. A single cached PDFFont embedded into
// PDFDocument A does not transfer to PDFDocument B -- pdf-lib registers the
// font as a resource inside the document it was embedded into, so reusing
// that same PDFFont object against a different document's pages produces a
// font resource entry that points nowhere. Confirmed via pdftoppm render:
// "Unknown font tag 'Helvetica-<n>' / No font in show" on every page whose
// text was drawn using a font embedded into an earlier document in the same
// process -- i.e. exactly what a warm lambda serving two different flat-PDF
// fill requests back-to-back would hit. WeakMap-per-pdfDoc fixes it.
const helveticaCache = new WeakMap();
async function getCachedHelvetica(pdfDoc) {
  let font = helveticaCache.get(pdfDoc);
  if (!font) {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    helveticaCache.set(pdfDoc, font);
  }
  return font;
}

/**
 * Helper to write text at specific coordinates on a PDF page.
 * Note: PDF y-coordinates are from bottom-left; we need to convert from top-left design coords.
 */
async function drawTextAtCoords(pdfDoc, page_num, field_config, text_value) {
  if (!text_value || text_value === '') return false;

  const pages = pdfDoc.getPages();
  if (page_num < 1 || page_num > pages.length) {
    console.warn(`[flat-pdf-filler] Invalid page ${page_num} (PDF has ${pages.length} pages)`);
    return false;
  }

  const page = pages[page_num - 1]; // Convert 1-indexed to 0-indexed
  const { height } = page.getSize();

  // Field config coordinates (x, y from top-left)
  const x = field_config.x || 0;
  const y_design = field_config.y || 0;
  const fontSize = field_config.font_size || 10;
  const max_width = field_config.width || 300;

  // Convert from design coords (top-left) to PDF coords (bottom-left)
  const y_pdf = height - y_design - fontSize;

  // Truncate text if it exceeds estimated width
  const max_chars = Math.floor(max_width / (fontSize * 0.55));
  const display_text = String(text_value).slice(0, max_chars);

  try {
    // Embed font once per pdfDoc and cache it (see helveticaCache note above).
    const font = await getCachedHelvetica(pdfDoc);

    page.drawText(display_text, {
      x,
      y: y_pdf,
      size: fontSize,
      color: rgb(0, 0, 0),
      font,
    });
    return true;
  } catch (err) {
    console.warn(`[flat-pdf-filler] Could not draw text at [${x}, ${y_design}]:`, err.message);
    return false;
  }
}

/**
 * Fill all fields from a field map onto a FLAT PDF.
 * Iterates through field_config and draws each field value at its coordinates.
 *
 * Returns diagnostics instead of nothing so callers can detect a silent
 * no-op fill (see fillFlatPdfFromMapStrict below) -- the exact failure mode
 * that let 45dbdaa0 ship four forms that produced blank PDFs with a 200.
 *
 * @returns {{ matchedFields: string[], drawnFields: string[] }}
 *   matchedFields: logical names present in both `fv` (non-empty) and the map
 *   drawnFields:   subset of matchedFields that page.drawText() actually accepted
 */
async function fillFlatPdfFromMap(pdfDoc, fv, field_map) {
  const fields = field_map && field_map.fields;
  const matchedFields = [];
  const drawnFields = [];
  if (!fields) return { matchedFields, drawnFields };

  for (const [logical_name, field_config] of Object.entries(fields)) {
    // Skip checkboxes and other non-text fields for now
    if (field_config.type === 'checkbox') continue;

    const value = fv[logical_name];
    if (!value || value === '') continue;
    matchedFields.push(logical_name);

    try {
      const ok = await drawTextAtCoords(pdfDoc, field_config.page, field_config, String(value));
      if (ok) drawnFields.push(logical_name);
    } catch (err) {
      console.warn(`[flat-pdf-filler] Error filling ${logical_name}:`, err.message);
    }
  }
  return { matchedFields, drawnFields };
}

/**
 * Same as fillFlatPdfFromMap, but throws (loudly, before the caller can ever
 * return a 200 with an attached PDF) instead of silently shipping a blank
 * document. Mirrors the spirit of the assertPlausibleResaleFieldCount() gate
 * added to api/esign-create.js in cd8a39ca -- a fill result that LOOKS
 * successful (no thrown error, valid PDF bytes) but placed zero text must
 * never reach a member.
 *
 * Three cases this blocks:
 *   1. field_map is missing/empty -- the map lookup itself found nothing.
 *   2. Caller supplied real (non-empty) field values but NONE of their keys
 *      matched a logical name in the map -- the exact wiring-mismatch shape
 *      of the 45dbdaa0 bug (safeSetText silently found 0 AcroForm fields).
 *   3. Values matched the map but drawText() failed for all of them.
 */
async function fillFlatPdfFromMapStrict(pdfDoc, fv, field_map, formLabel) {
  const label = formLabel || (field_map && field_map.form_id) || 'unknown form';

  if (!field_map || !field_map.fields || Object.keys(field_map.fields).length === 0) {
    throw new Error(
      `[flat-pdf-filler] ${label}: field map is missing or empty -- refusing to produce a silently blank PDF.`
    );
  }

  const providedKeys = Object.keys(fv || {}).filter((k) => fv[k] != null && fv[k] !== '');
  const { matchedFields, drawnFields } = await fillFlatPdfFromMap(pdfDoc, fv, field_map);

  if (providedKeys.length > 0 && matchedFields.length === 0) {
    throw new Error(
      `[flat-pdf-filler] ${label}: ${providedKeys.length} field value(s) were supplied ` +
      `(${providedKeys.slice(0, 10).join(', ')}${providedKeys.length > 10 ? ', ...' : ''}) but none matched ` +
      `a logical field name in the map (map has ${Object.keys(field_map.fields).length} fields: ` +
      `${Object.keys(field_map.fields).slice(0, 10).join(', ')}${Object.keys(field_map.fields).length > 10 ? ', ...' : ''}). ` +
      `This is the exact silent-blank-PDF failure mode -- refusing to ship it.`
    );
  }

  if (matchedFields.length > 0 && drawnFields.length === 0) {
    throw new Error(
      `[flat-pdf-filler] ${label}: ${matchedFields.length} field(s) matched the map but 0 were actually ` +
      `drawn onto the PDF (page/coordinate failure) -- refusing to ship a blank result.`
    );
  }

  return { matchedFields, drawnFields };
}

module.exports = {
  drawTextAtCoords,
  fillFlatPdfFromMap,
  fillFlatPdfFromMapStrict,
};
