// api/dossiesign-approve-field-map.js — RETIRED 2026-08-16.
//
// POST /api/dossiesign-approve-field-map now returns 410 Gone.
//
// This endpoint never worked. Three independent defects, each fatal on its
// own, verified against the working DocuSeal integration in esign-create.js /
// esign-download.js / esign-webhook.js / fill-form-via-docuseal.js:
//
//   1. Wrong host. It called `https://api.docuseal.co`. Every working caller
//      uses `https://api.docuseal.com`.
//   2. Wrong auth header. It sent `Authorization: Bearer <key>`. DocuSeal
//      authenticates with `X-Auth-Token`, which is what every working caller
//      sends.
//   3. Wrong coordinate contract. It passed x_pct/w_pct (0-100 percentages) as
//      top-level `x`/`width`. DocuSeal wants 0-1 fractions inside an `areas[]`
//      array.
//
// So no field map has ever reached DocuSeal through this path. Repairing it
// would only restore a route whose upstream input — Fable5's model-estimated
// coordinates — we are deliberately abandoning (see below).
//
// WHAT REPLACES IT
// ----------------
// Field geometry is deterministic now: AcroForm widget rects extracted by
// scripts/extract-acroform-fields.js into api/_assets/*-coords.json. Field
// semantics live in api/_lib/trec-20-19-transaction-field-map.js, reviewed by
// a human and versioned. Sending goes through api/esign-create.js.
//
// Kept as a 410 rather than deleted so a stale cached bundle calling this URL
// gets an explanation instead of a bare 404.

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
    error: 'Field-map approval has been retired. Form geometry now comes from the '
      + 'deterministic AcroForm coordinate maps, not from an approved model estimate.',
    retired: '2026-08-16',
  });
};
