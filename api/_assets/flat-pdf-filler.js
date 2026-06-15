// Utility functions for filling FLAT PDFs (no AcroForm fields) using coordinate-based text drawing
// These PDFs have no form fields, so we draw text directly at specified coordinates using pdf-lib.

const { rgb, StandardFonts } = require('pdf-lib');

let cachedHelvetica = null;

/**
 * Helper to draw a checkmark at checkbox coordinates.
 */
async function drawCheckmarkAtCoords(pdfDoc, page_num, field_config) {
  if (!pdfDoc || !field_config) return;

  const pages = pdfDoc.getPages();
  if (page_num < 1 || page_num > pages.length) {
    console.warn(`[flat-pdf-filler] Invalid page ${page_num} for checkbox (PDF has ${pages.length} pages)`);
    return;
  }

  const page = pages[page_num - 1];
  const { height } = page.getSize();

  const x = field_config.x || 0;
  const y_design = field_config.y || 0;
  const size = 10;

  // Center the checkmark within the checkbox field
  const y_pdf = height - y_design - size;

  try {
    if (!cachedHelvetica) {
      cachedHelvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }
    page.drawText('X', {
      x: x + 1,
      y: y_pdf - 2,
      size,
      color: rgb(0, 0, 0),
      font: cachedHelvetica,
    });
  } catch (err) {
    console.warn(`[flat-pdf-filler] Could not draw checkmark at [${x}, ${y_design}]:`, err.message);
  }
}

/**
 * Helper to write text at specific coordinates on a PDF page.
 * Note: PDF y-coordinates are from bottom-left; we need to convert from top-left design coords.
 */
async function drawTextAtCoords(pdfDoc, page_num, field_config, text_value) {
  if (!text_value || text_value === '') return;

  const pages = pdfDoc.getPages();
  if (page_num < 1 || page_num > pages.length) {
    console.warn(`[flat-pdf-filler] Invalid page ${page_num} (PDF has ${pages.length} pages)`);
    return;
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
    // Embed font once and cache it
    if (!cachedHelvetica) {
      cachedHelvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
    }

    page.drawText(display_text, {
      x,
      y: y_pdf,
      size: fontSize,
      color: rgb(0, 0, 0),
      font: cachedHelvetica,
    });
  } catch (err) {
    console.warn(`[flat-pdf-filler] Could not draw text at [${x}, ${y_design}]:`, err.message);
  }
}

/**
 * Fill all fields from a field map onto a FLAT PDF.
 * Iterates through field_config and draws each field value at its coordinates.
 */
async function fillFlatPdfFromMap(pdfDoc, fv, field_map) {
  const { fields } = field_map;

  for (const [logical_name, field_config] of Object.entries(fields)) {
    if (field_config.type === 'checkbox') {
      const value = fv[logical_name];
      if (value === true) {
        await drawCheckmarkAtCoords(pdfDoc, field_config.page, field_config);
      }
      continue;
    }

    const value = fv[logical_name];
    if (!value || value === '') continue;

    try {
      await drawTextAtCoords(pdfDoc, field_config.page, field_config, String(value));
    } catch (err) {
      console.warn(`[flat-pdf-filler] Error filling ${logical_name}:`, err.message);
    }
  }
}

module.exports = {
  drawTextAtCoords,
  drawCheckmarkAtCoords,
  fillFlatPdfFromMap,
};
