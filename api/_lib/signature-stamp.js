// api/_lib/signature-stamp.js
//
// Inline signature verification stamp for DossieSign — the dotloop/DocuSign
// style mark rendered DIRECTLY ON THE PAGE next to a signature or initials
// widget, so a completed PDF is self-evidencing on its face. Separate from
// (and complementary to) DocuSeal's own audit-certificate PDF
// (submission.audit_log_url), which stays a separate attached document.
//
// Checked first (2026-10-01, Carter): DocuSeal has no native inline stamp.
// Its "stamp" field type is a SIGNER-FILLABLE image field (company seal),
// not an automatic verification mark — confirmed against the live API docs
// (docs.docuseal.com/docs/api) and changelog, no "signature id" /
// "verification stamp" template or account setting exists. The only
// per-document authenticity artifact DocuSeal emits is the audit_log_url
// certificate, which is the separate-page problem this file exists to fix.
// So: built, not configured.
//
// Design:
//   - Signature widgets get a full 3-line stamp ("DossieSign verified" /
//     timestamp / verification code) placed in the empty band below the
//     widget — confirmed empirically on TREC 20-19 page 10 there is ~59pt of
//     clear space between the Buyer1 and Buyer2 signature lines.
//   - Initials widgets (the dense per-page footer row, 4 widgets packed into
//     one printed line with 6-10pt gaps) get ONLY the compact verification
//     code on a single tiny line, placed in the ~30pt margin confirmed
//     between the printed footer line and the physical page edge (measured
//     via pdftoppm render of scripts/trec-forms/20-19.pdf page 1, 2026-10-01).
//     No label text there — not enough honest room for it without crowding
//     the neighboring widget's own stamp.
//   - Placement data comes from the DocuSeal TEMPLATE record itself
//     (GET /templates/{id}), the same widget rectangles DocuSeal used to
//     collect the signature — never re-derived or guessed locally. Timestamp
//     and the IDs embedded in the verification code come from the DocuSeal
//     SUBMISSION record (submitter.completed_at, submission.id,
//     submitter.id) — never generated locally, per the build spec.
//
// Verification code: base36(submissionId)-base36(submitterId), e.g.
// "DS-6TX2-2". It is not decorative — api/esign-verify-stamp.js decodes it
// back to the DocuSeal submission + submitter ids and resolves it live
// against DocuSeal's own GET /submissions/{id} record.

'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const STAMP_LABEL = 'DossieSign verified';
const STAMP_COLOR = rgb(0.38, 0.40, 0.46); // muted slate — reads as metadata, not contract text
const CODE_PREFIX = 'DS';

// ---------------------------------------------------------------------------
// Verification code — a real, reversible encoding of the DocuSeal submission
// + submitter ids. Not a random/decorative string.
// ---------------------------------------------------------------------------
function toVerificationCode(submissionId, submitterId) {
  const a = Number(submissionId);
  const b = Number(submitterId);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) return null;
  return `${CODE_PREFIX}-${a.toString(36).toUpperCase()}-${b.toString(36).toUpperCase()}`;
}

// Returns { submissionId, submitterId } or null if the code is malformed.
function fromVerificationCode(code) {
  if (typeof code !== 'string') return null;
  const m = /^DS-([0-9A-Z]+)-([0-9A-Z]+)$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const submissionId = parseInt(m[1], 36);
  const submitterId = parseInt(m[2], 36);
  if (!Number.isFinite(submissionId) || !Number.isFinite(submitterId)) return null;
  return { submissionId, submitterId };
}

// Deterministic, zero-guesswork timestamp format: the exact UTC instant
// DocuSeal recorded, labeled UTC. We do NOT attempt to convert to a signer's
// local timezone — DocuSeal's completion certificate carries only the UTC
// ISO timestamp (no per-signer tz in the API response), so converting would
// risk printing a time that disagrees with the certificate. Matching exactly
// beats matching prettily.
function formatStampTimestamp(isoString) {
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// ---------------------------------------------------------------------------
// DocuSeal lookups
// ---------------------------------------------------------------------------
const DOCUSEAL_BASE = 'https://api.docuseal.com';

async function fetchDocusealTemplate(templateId, apiKey) {
  const res = await fetch(`${DOCUSEAL_BASE}/templates/${encodeURIComponent(templateId)}`, {
    headers: { 'X-Auth-Token': apiKey },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function fetchDocusealSubmission(submissionId, apiKey) {
  const res = await fetch(`${DOCUSEAL_BASE}/submissions/${encodeURIComponent(submissionId)}`, {
    headers: { 'X-Auth-Token': apiKey },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

async function fetchDocusealSubmitter(submitterId, apiKey) {
  const res = await fetch(`${DOCUSEAL_BASE}/submitters/${encodeURIComponent(submitterId)}`, {
    headers: { 'X-Auth-Token': apiKey },
  });
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json().catch(() => null);
  return { ok: true, data };
}

// template.submitters[].uuid -> role label ("Buyer 1" etc). The field's
// submitter_uuid references THIS uuid, not the submission submitter's uuid.
function templateRoleByUuid(template) {
  const map = {};
  for (const s of (template && template.submitters) || []) {
    if (s && s.uuid) map[s.uuid] = s.name;
  }
  return map;
}

// submission.submitters[], keyed by role label, carrying what we stamp.
function submissionSignerByRole(submission) {
  const map = {};
  for (const s of (submission && submission.submitters) || []) {
    if (!s || !s.role) continue;
    map[s.role] = {
      name: s.name || s.email || 'Signer',
      email: s.email || null,
      completedAt: s.completed_at || null,
      submitterId: s.id,
      uuid: s.uuid,
    };
  }
  return map;
}

// ---------------------------------------------------------------------------
// Plan: for ONE document (matched by name to the template's schema entry),
// return the list of stamp instructions — only for widgets whose signer
// actually completed (submitter.completed_at present). Fields with no
// matching completed submitter are skipped (never stamp an incomplete mark).
// ---------------------------------------------------------------------------
function buildStampPlan({ template, submission, docName }) {
  const plan = [];
  if (!template || !submission) return plan;

  const schema = Array.isArray(template.schema) ? template.schema : [];
  // Single-document submissions: schema has one entry; match loosely if the
  // exact name differs (DocuSeal may suffix/trim). Multi-document packets:
  // match by exact name set at template-build time.
  let schemaEntry = schema.find((e) => e && e.name === docName);
  if (!schemaEntry && schema.length === 1) schemaEntry = schema[0];
  const attachmentUuid = schemaEntry ? schemaEntry.attachment_uuid : null;

  const roleByUuid = templateRoleByUuid(template);
  const signerByRole = submissionSignerByRole(submission);
  const fields = Array.isArray(template.fields) ? template.fields : [];

  for (const field of fields) {
    if (!field || (field.type !== 'signature' && field.type !== 'initials')) continue;
    const roleLabel = roleByUuid[field.submitter_uuid];
    const signer = roleLabel ? signerByRole[roleLabel] : null;
    if (!signer || !signer.completedAt) continue; // not signed — nothing to stamp

    const code = toVerificationCode(submission.id, signer.submitterId);
    if (!code) continue; // IDs must be real DocuSeal ids — never stamp a fabricated code

    for (const area of field.areas || []) {
      if (!area) continue;
      if (schema.length > 1 && attachmentUuid && area.attachment_uuid && area.attachment_uuid !== attachmentUuid) continue;
      plan.push({
        type: field.type, // 'signature' | 'initials'
        // 2026-10-01 — DocuSeal's own template API returns area.page
        // 0-INDEXED (verified live: a field built from our 1-indexed
        // trec-20-19-esign-coords.json with page:1..9 comes back from
        // GET /templates/{id} as area.page 0..8). Normalize to 1-indexed
        // here so the rest of this module (and applyStamps' `page - 1`)
        // stays consistent with how every other PDF coordinate file in this
        // repo is written. `area.page || 1` previously mishandled page 0
        // (falsy) by accident-cancelling with a second bug in applyStamps —
        // fixed together; see git history for the live render that caught it.
        page: (Number.isInteger(area.page) ? area.page : 0) + 1,
        x: area.x, y: area.y, w: area.w, h: area.h, // fractions, origin TOP-left (DocuSeal convention)
        signerName: signer.name,
        completedAt: signer.completedAt,
        code,
      });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Render: burn the stamp plan onto the actual PDF bytes. Never touches a
// page the plan has no instructions for. Returns a NEW buffer — caller
// decides what to do with the original.
// ---------------------------------------------------------------------------
async function applyStamps(pdfBuffer, plan) {
  if (!Array.isArray(plan) || plan.length === 0) return { buffer: pdfBuffer, stamped: 0 };

  const pdfDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true });
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pageCount = pdfDoc.getPageCount();
  let stamped = 0;

  for (const inst of plan) {
    const pageIndex = inst.page - 1;
    if (pageIndex < 0 || pageIndex >= pageCount) continue;
    const page = pdfDoc.getPage(pageIndex);
    const { width, height } = page.getSize();

    // area.y is the TOP of the widget box, fraction of page height, origin
    // top-left (DocuSeal convention, confirmed against
    // api/_assets/trec-20-19-esign-coords.json). Convert the widget's BOTTOM
    // edge to pdf-lib's bottom-left origin to anchor the stamp just below it.
    const boxX = inst.x * width;
    const boxBottomFromTop = (inst.y + inst.h) * height;
    const boxBottomPdfY = height - boxBottomFromTop;
    const ts = formatStampTimestamp(inst.completedAt);

    if (inst.type === 'signature') {
      // 2026-10-01 — first attempt anchored 7pt below the widget's bottom
      // edge and it printed directly through the "Buyer"/"Seller" caption
      // TREC prints immediately under the signature line (confirmed by
      // rendering the actual stamped page 10 and seeing "BuyeSign verified"
      // overlap text — caught before this shipped). Measured the real gap
      // on scripts/trec-forms/20-19.pdf page 10: the printed caption's own
      // bottom edge sits ~10-12pt below the widget's bottom edge, and the
      // NEXT signature line pair (Buyer2/Seller2) doesn't start until ~75pt
      // below that — so clearing the caption by 20pt leaves the full 3-line
      // stamp with ~30-40pt of true margin before anything else prints.
      const fontSize = 6.5;
      const lineGap = 1.4;
      const lines = [STAMP_LABEL, ts || '', `ID: ${inst.code}`].filter(Boolean);
      let y = boxBottomPdfY - 20;
      for (const line of lines) {
        page.drawText(line, { x: boxX, y, size: fontSize, font, color: STAMP_COLOR });
        y -= fontSize + lineGap;
      }
      stamped += 1;
    } else {
      // initials — dense footer row, only ~30pt of true margin below the
      // printed line and 6-10pt between neighboring widgets. One tiny line,
      // code only, left-aligned to the widget's own x so it stays inside
      // that widget's horizontal footprint and never crowds the next one.
      const fontSize = 4.3;
      page.drawText(inst.code, { x: boxX, y: boxBottomPdfY - 5, size: fontSize, font, color: STAMP_COLOR });
      stamped += 1;
    }
  }

  const bytes = await pdfDoc.save();
  return { buffer: Buffer.from(bytes), stamped };
}

// ---------------------------------------------------------------------------
// Orchestration — everything the webhook needs in one call per document.
// Never throws: a failure here must not block completion (same philosophy
// as the audit-certificate fetch in esign-webhook.js). Returns
// { buffer, stamped, skippedReason }.
// ---------------------------------------------------------------------------
async function stampCompletedDocument({ pdfBuffer, docName, templateId, submission, apiKey }) {
  if (!apiKey) return { buffer: pdfBuffer, stamped: 0, skippedReason: 'no DOCUSEAL_API_KEY' };
  if (!templateId) return { buffer: pdfBuffer, stamped: 0, skippedReason: 'signature request has no docuseal_template_id — widget positions unknown, skipping inline stamp' };
  try {
    const template = await fetchDocusealTemplate(templateId, apiKey);
    if (!template) return { buffer: pdfBuffer, stamped: 0, skippedReason: `could not fetch template ${templateId}` };
    const plan = buildStampPlan({ template, submission, docName });
    if (plan.length === 0) return { buffer: pdfBuffer, stamped: 0, skippedReason: 'no completed signature/initials widgets matched this document' };
    const { buffer, stamped } = await applyStamps(pdfBuffer, plan);
    return { buffer, stamped, skippedReason: null };
  } catch (err) {
    console.error('[signature-stamp] stampCompletedDocument threw (non-fatal):', err && err.message);
    return { buffer: pdfBuffer, stamped: 0, skippedReason: `error: ${err && err.message}` };
  }
}

module.exports = {
  toVerificationCode,
  fromVerificationCode,
  formatStampTimestamp,
  fetchDocusealTemplate,
  fetchDocusealSubmission,
  fetchDocusealSubmitter,
  buildStampPlan,
  applyStamps,
  stampCompletedDocument,
};
