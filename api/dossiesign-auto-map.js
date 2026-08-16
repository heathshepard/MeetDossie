// api/dossiesign-auto-map.js — RETIRED 2026-08-16.
//
// POST /api/dossiesign-auto-map now returns 410 Gone.
//
// WHY
// ---
// This endpoint drove api/_lib/fable5-field-mapper.js, which asked Claude to
// return `x_pct` / `y_pct` for every field on a TREC form "within ~2% of true
// position." Two percent of a 792pt page is 16pt — taller than a signature
// line. A model cannot be asked to place a field on a legal document, and it
// should never have been.
//
// The two jobs are now split permanently:
//
//   GEOMETRY  — deterministic only. Extracted from AcroForm widget rects by
//               scripts/extract-acroform-fields.js into api/_assets/*-coords.json,
//               including signature and initial rectangles. Exact, free, and
//               reproducible from the PDF bytes.
//   SEMANTICS — a model may label a field (key / party / paragraph) from its
//               widget name and neighbouring text, because that is a text task
//               with a checkable answer. A human approves it once and it is
//               stored versioned: api/_lib/trec-20-19-transaction-field-map.js.
//
// All ~30 runs this endpoint ever produced are stranded at
// `awaiting_hadley_qa` and none was ever approved — the approval endpoint
// (api/dossiesign-approve-field-map.js) never worked either.
//
// NOT DELETED FROM THE DATABASE
// -----------------------------
// The cached run `8e3bc446-eb01-43b9-8447-6da9de22bcc7` in
// `dossiesign_auto_map_runs` is still read by api/interactive-editor-init.js,
// which uses its field NAMES, party and paragraph — the semantic half, which
// is sound and human-reviewed. Its coordinates are used only to position the
// editor's preview highlight; nothing writes a PDF from them (fill-form.js
// resolves AcroForm field names). Retiring the generator stops any NEW
// model-estimated geometry from being created without disturbing that row.
//
// Kept as a 410 rather than deleted so a stale caller gets an explanation
// instead of a bare 404.

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin)
      || LOCALHOST_ORIGIN_RE.test(origin)
      || origin.endsWith('.vercel.app')
      || origin.endsWith('.meetdossie.com')
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  return res.status(410).json({
    ok: false,
    error: 'Auto field-mapping has been retired. Field geometry is extracted '
      + 'deterministically from AcroForm widget rects; a model is never asked for a coordinate.',
    retired: '2026-08-16',
  });
};
