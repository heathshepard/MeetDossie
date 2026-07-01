/**
 * api/_lib/pdf-to-images.js
 *
 * Historically this helper rasterized PDFs to PNGs so Claude could see them
 * as image blocks. That path requires Poppler / canvas / pdfjs-dist —
 * heavy on Vercel serverless.
 *
 * Anthropic's messages API natively accepts PDF via the "document" content
 * block (base64 PDF, media_type: application/pdf). Claude Fable 5 renders
 * the pages internally. We short-circuit here: we don't rasterize; we hand
 * back the PDF bytes wrapped as a single document block. The caller can
 * treat it as a 1-element array of "page blocks" without any code changes
 * downstream.
 *
 * Usage:
 *   const { pdfToImages } = require('./pdf-to-images.js');
 *   const contentBlocks = await pdfToImages(pdfBuffer);
 *   // contentBlocks = [ { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '...' } } ]
 */

const PDFDocument = require('pdf-lib').PDFDocument;

/**
 * Wrap a PDF buffer as an Anthropic document content block.
 * We still probe the PDF with pdf-lib to (a) validate it's a real PDF and
 * (b) return the page count for downstream cost / batching logic.
 *
 * @param {Buffer} pdfBuffer - PDF file bytes
 * @param {Object} opts - unused, kept for backward-compatible signature
 * @returns {Promise<{blocks: Array, pageCount: number}>} document-block array
 */
async function pdfToImages(pdfBuffer /* , opts = {} */) {
  if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length < 4) {
    throw new Error('pdfToImages: input is not a valid PDF buffer');
  }
  // Sanity: PDF magic bytes are %PDF
  if (pdfBuffer.slice(0, 4).toString() !== '%PDF') {
    throw new Error('pdfToImages: buffer does not look like a PDF (missing %PDF header)');
  }

  let pageCount = 0;
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
    pageCount = pdfDoc.getPageCount();
  } catch (e) {
    throw new Error(`pdfToImages: pdf-lib failed to parse PDF: ${e.message}`);
  }

  if (pageCount === 0) {
    throw new Error('pdfToImages: PDF has no pages');
  }

  const documentBlock = {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: pdfBuffer.toString('base64'),
    },
  };

  return { blocks: [documentBlock], pageCount };
}

module.exports = { pdfToImages };
