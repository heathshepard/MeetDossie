// api/_lib/notarization-required-forms.js
//
// 2026-09-22 CARTER — forms that carry a notary jurat/acknowledgment block.
// An ordinary e-signature is NOT a valid execution of these — the title
// company will reject the signed copy. This is the hard backstop: every path
// that can create a real DocuSeal submission (api/esign-create.js, both the
// single-document AND multi-document packet branches) and every path that
// can show a member a "ready to send" preview card (api/esign-packet-send.js)
// must check a document against this list before proceeding.
//
// Each entry was confirmed against the ACTUAL PDF text, not guessed from the
// form's name (see memory: acroform-field-names-lie — AcroForm field names
// and even form titles lie). The T-47 Affidavit's body reads: "Before me,
// the undersigned notary for the State of ___, personally appeared
// Affiant(s) who after by me being duly sworn, stated:" — that is a jurat,
// not a signature line.
//
// General mechanism, not a T-47 special case — add a row here for any other
// form later confirmed (by reading the PDF, same standard) to require
// notarization, e.g. a Power of Attorney or an HOA resale certificate
// affidavit. Every consumer reads this same list; nothing hardcodes "t47"
// outside this file.
//
// Match on BOTH document_type and form_type: the same document can arrive
// through two different pipelines that set a different pair of fields —
// api/fill-form.js writes document_type=config.documentType (underscore
// style, e.g. 't47_affidavit') with no form_type; api/dossiesign-prepare.js
// writes document_type='filled_form' with form_type=<hyphen slug, e.g.
// 't47-affidavit'>. See resolveEsignFieldMapForDoc's own comment in
// api/esign-create.js for the same split.
const NOTARIZATION_REQUIRED_FORMS = [
  {
    documentTypes: ['t47_affidavit'],
    formTypes: ['t47-affidavit'],
    label: 'T-47 Residential Real Property Affidavit',
    reason: 'has to be signed in front of a notary — an e-signature is not a valid execution of it, and the title company will reject it',
    // TREC 20-19 paragraph 6C names both; the T-47.1 exists specifically so
    // a seller who can furnish an existing survey does not need a notary.
    // Do NOT claim Dossie can fill/send a T-47.1 here — that form is not in
    // the form library yet (2026-09-22), so only the title-company question
    // is offered, not a Dossie action that doesn't exist.
    alternative: 'ask the title company whether they will accept a T-47.1 Declaration instead — TREC ¶6C allows either one, and the T-47.1 does not require a notary',
  },
];

function findNotarizationRequirement(doc) {
  if (!doc) return null;
  const documentType = String(doc.document_type || '').toLowerCase();
  const formType = String(doc.form_type || '').toLowerCase();
  return NOTARIZATION_REQUIRED_FORMS.find((entry) =>
    entry.documentTypes.includes(documentType) || entry.formTypes.includes(formType)
  ) || null;
}

// Full sentence for a refusal message — same wording everywhere this fires
// so the member sees one consistent explanation regardless of which path
// caught it.
function notarizationRefusalMessage(doc, requirement) {
  const req = requirement || findNotarizationRequirement(doc);
  if (!req) return null;
  const name = (doc && doc.file_name) || req.label;
  return `${name} ${req.reason}. It can't go out for e-signature — ${req.alternative}.`;
}

module.exports = {
  NOTARIZATION_REQUIRED_FORMS,
  findNotarizationRequirement,
  notarizationRefusalMessage,
};
