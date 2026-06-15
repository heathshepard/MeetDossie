// Utility functions for filling FLAT PDFs (no AcroForm fields) using coordinate-based text drawing
// These PDFs have no form fields, so we draw text directly at specified coordinates using pdf-lib.

const { rgb, StandardFonts } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

let cachedHelvetica = null;

/**
 * Helper to write text at specific coordinates on a PDF page.
 * Note: field_map coordinates are already in PDF coords (bottom-left origin).
 */
async function drawTextAtCoords(pdfDoc, page_num, field_config, text_value) {
  if (!text_value || text_value === '') return;

  const pages = pdfDoc.getPages();
  if (page_num < 1 || page_num > pages.length) {
    console.warn(`[flat-pdf-filler] Invalid page ${page_num} (PDF has ${pages.length} pages)`);
    return;
  }

  const page = pages[page_num - 1]; // Convert 1-indexed to 0-indexed

  // Field config coordinates (x, y already in PDF coords: bottom-left origin)
  const x = field_config.x || 0;
  const y_pdf = field_config.y || 0;
  const fontSize = field_config.font_size || 10;
  const max_width = field_config.width || 300;

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
    console.warn(`[flat-pdf-filler] Could not draw text at [${x}, ${y_pdf}]:`, err.message);
  }
}

/**
 * Fill all fields from a field map onto a FLAT PDF.
 * Iterates through field_config and draws each field value at its coordinates.
 */
async function fillFlatPdfFromMap(pdfDoc, fv, field_map) {
  const { fields } = field_map;

  const nonEmptyCount = Object.values(fv).filter(v => v && v !== '').length;
  console.log('[fillFlatPdfFromMap] fv has', nonEmptyCount, 'non-empty values; cash_portion:', fv.cash_portion, 'financing_amount:', fv.financing_amount, 'sales_price:', fv.sales_price);

  const filledFields = [];
  const skippedFields = [];

  for (const [logical_name, field_config] of Object.entries(fields)) {
    // Skip checkboxes and other non-text fields for now
    if (field_config.type === 'checkbox') continue;

    const value = fv[logical_name];
    if (!value || value === '') {
      skippedFields.push({ name: logical_name, reason: 'no_value' });
      continue;
    }

    try {
      filledFields.push({ name: logical_name, value: String(value).slice(0, 50), page: field_config.page });
      await drawTextAtCoords(pdfDoc, field_config.page, field_config, String(value));
    } catch (err) {
      console.warn(`[flat-pdf-filler] Error filling ${logical_name}:`, err.message);
      filledFields.push({ name: logical_name, error: err.message });
    }
  }

  // Write debug log to tmp file so we can see what happened
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logPath = path.join('.', `fillFlatPdfFromMap-${timestamp}.json`);
    fs.writeFileSync(logPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      nonEmptyValues: nonEmptyCount,
      filledCount: filledFields.length,
      filled: filledFields,
      skippedCount: skippedFields.length
    }, null, 2));
    console.log('[fillFlatPdfFromMap] Wrote debug log to ' + logPath);
  } catch (logErr) {
    console.warn('[fillFlatPdfFromMap] Could not write debug log:', logErr && logErr.message);
  }
}

module.exports = {
  drawTextAtCoords,
  fillFlatPdfFromMap,
};
