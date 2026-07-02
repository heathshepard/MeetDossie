// api/_lib/pdf-regenerator.js
// Finds existing filled PDFs for a dossier and re-renders them after a field update.

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Find all filled PDF documents for a dossier.
 * Returns array of { id, filename, formType, storagePath }.
 */
async function findFilledPdfsForDossier(dossierId) {
  // documents.transaction_id joins to transactions.id (there is no dossier_id column).
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/documents?transaction_id=eq.${dossierId}&file_type=eq.application%2Fpdf`,
    {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );

  if (!res.ok) {
    console.error(
      `[pdf-regenerator] fetch filled PDFs failed: ${res.status}`,
      await res.text()
    );
    return [];
  }

  const docs = await res.json();
  return docs.map((d) => ({
    id: d.id,
    filename: d.filename,
    formType: d.form_type, // e.g., 'resale-contract'
    storagePath: d.storage_path, // e.g., 'documents/dossier-123/resale-contract.pdf'
  }));
}

/**
 * Trigger a re-fill + re-render of a PDF.
 * Fires an async POST to /api/fill-form with the updated transaction and form_type.
 * Does NOT wait for completion — just queues the work.
 */
async function queuePdfRegeneration(dossierId, formType, transactionData) {
  const FILL_FORM_URL = `${process.env.VERCEL_URL || 'https://meetdossie.com'}/api/fill-form`;

  // Fire-and-forget: POST the re-fill request but don't await it.
  // The fill-form handler will use the existing transaction data + new field values.
  fetch(FILL_FORM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      transaction_id: dossierId,
      form_type: formType,
      field_values: transactionData,
    }),
  }).catch((err) => {
    console.error(`[pdf-regenerator] fill-form queue failed:`, err.message);
  });
}

/**
 * Main entry point: called after update_deal_field in chat.js.
 * Finds all filled PDFs for the dossier and queues re-renders.
 */
async function regeneratePdfsForDossier(dossierId, fieldName, newValue) {
  try {
    const filledPdfs = await findFilledPdfsForDossier(dossierId);

    if (filledPdfs.length === 0) {
      console.log(`[pdf-regenerator] no filled PDFs found for dossier ${dossierId}`);
      return { regenerated: 0 };
    }

    console.log(
      `[pdf-regenerator] found ${filledPdfs.length} filled PDFs for dossier ${dossierId}`
    );

    // For now, queue re-renders for all filled PDFs.
    // In future, could be selective based on which forms actually use this field.
    for (const pdf of filledPdfs) {
      console.log(
        `[pdf-regenerator] queueing re-render for ${pdf.filename} (form: ${pdf.formType})`
      );
      // The fill-form API will fetch the updated transaction, merge in the new field,
      // and re-render the PDF under the same storage_path.
      await queuePdfRegeneration(dossierId, pdf.formType, {
        [fieldName]: newValue,
      });
    }

    return { regenerated: filledPdfs.length };
  } catch (err) {
    console.error(`[pdf-regenerator] error:`, err.message);
    return { error: err.message };
  }
}

module.exports = {
  findFilledPdfsForDossier,
  queuePdfRegeneration,
  regeneratePdfsForDossier,
};
