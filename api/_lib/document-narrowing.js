// api/_lib/document-narrowing.js
//
// 2026-09-22 CARTER — resolves "the agent named ONE document" down to that
// document, instead of a keyword loosely matching everything on the file.
//
// Real incident: "23 Nopalito, send the t47 to the whites to be completed"
// went out as a 10-document packet with subject "23 Nopalito — documents" —
// api/send-compliance-packet.js had no document selector at all, it always
// attached every document on the transaction. Mirrors the same tokenizer
// used client-side in Dossie/dossie-app.jsx's send_for_signature handler —
// keep both in sync if the matching rule changes.
//
// Exact-token matching, not substring: "t-47", "t47" and "t 47" all
// normalize to the same token, while "t-47" and "t-47.1" stay distinct
// (the T-47 Affidavit and a hypothetical T-47.1 Declaration are different
// documents — see api/_lib/notarization-required-forms.js).
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'and', 'for', 'of', 'is', 'are', 'that',
  'this', 'these', 'those', 'them', 'it', 'its', 'i', 'you', 'your',
  'we', 'our', 'us', 'me', 'on', 'in', 'at', 'be', 'been', 'has',
  'have', 'had', 'will', 'would', 'can', 'could', 'should', 'so',
  'please', 'just', 'need', 'needs', 'needed', 'send', 'sending',
  'sent', 'want', 'wants', 'wanted', 'get', 'gets', 'getting', 'give',
  'gives', 'complete', 'completed', 'completing', 'sign', 'signed',
  'signing', 'signature', 'signatures', 'document', 'documents',
  'file', 'files', 'form', 'forms', 'only', 'with', 'from', 'over',
  'again', 'back', 'now',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\.(pdf|docx?|png|jpe?g)$/i, '')
    // Joins a doc-code letter prefix to its digits — "t-47" / "t 47" /
    // "T-47.1" all become "t47" / "t471" — without merging ordinary
    // hyphenated words (only fires letters-then-digits).
    .replace(/([a-z]+)[\s-]+(\d[\d.]*)/gi, '$1$2')
    .split(/[\s_-]+/)
    .map((w) => w.replace(/\./g, ''))
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

function docTokenSet(doc) {
  const hay = `${doc.file_name || ''} ${String(doc.document_type || '').replace(/_/g, ' ')} ${String(doc.form_type || '').replace(/_/g, ' ')}`;
  return new Set(tokenize(hay));
}

// Returns:
//   { narrowed: false }                     — no description given, use all
//   { narrowed: true, matched: [docs] }      — resolved to exactly one match set (could be >1 if genuinely tied)
//   { narrowed: true, matched: [] }          — description given, nothing matched — caller should ask, never fall back to all
function narrowDocumentsByDescription(documents, description) {
  const want = String(description || '').trim();
  if (!want) return { narrowed: false };
  const words = tokenize(want);
  if (!words.length) return { narrowed: false };

  const scored = documents
    .map((d) => {
      const tokens = docTokenSet(d);
      const hits = words.filter((w) => tokens.has(w)).length;
      return { d, hits };
    })
    .filter((s) => s.hits > 0);

  if (!scored.length) return { narrowed: true, matched: [] };
  const maxHits = Math.max(...scored.map((s) => s.hits));
  return { narrowed: true, matched: scored.filter((s) => s.hits === maxHits).map((s) => s.d) };
}

module.exports = { narrowDocumentsByDescription, tokenize };
