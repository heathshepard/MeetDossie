// api/_lib/signature-verifier.js
// =============================================================================
// Does this "completed" e-signed PDF ACTUALLY have signatures on it?
//
// WHY THIS EXISTS — a DocuSeal flow on Heath's own account produced a document
// the provider reported as `completed` where the signature and every form field
// rendered BLANK on the final PDF. A completed-but-unsigned document is legally
// worthless, and it filed silently as done. Provider status is not evidence.
// The only thing that counts is whether a signature mark actually rendered on
// the page.
//
// TWO LAYERS, because neither is sufficient alone:
//
//   1. STRUCTURAL (deterministic, free, never throws). Raw-byte + pdf-lib probe
//      for a PKCS#7 crypto signature, AcroForm widgets, filled/empty fields,
//      image XObjects.
//
//      HARD-WON DETAIL: pdf-lib CANNOT LOAD the real executed Authentisign PDF
//      at all. Verified 2026-08-14 against the genuine executed
//      "Amendment #1 - 104 Wild Cherry Ln" — PDFDocument.load() throws
//      "Expected instance of PDFDict, but got instance of undefined" on
//      Authentisign's incremental-update/xref structure, and getForm() reports
//      0 fields. A verifier built on pdf-lib's form API alone would CRASH on
//      the exact class of document it exists to check. Every pdf-lib call here
//      is therefore individually wrapped, and the raw-byte scan is the floor
//      that always works.
//
//   2. VISUAL (authoritative). Claude reads the PDF natively as a `document`
//      content block and renders the pages internally, then reports whether a
//      signature mark is VISIBLY present on each signature line. This is the
//      productized version of the manual step that caught the DocuSeal failure:
//      render the page and look at it.
//
// The layers disagree in exactly the way that matters: the DocuSeal blank-field
// document can carry structural signature scaffolding while rendering empty.
// So VISUAL WINS on "is it blank". Structural evidence can never upgrade a
// visually-blank document to signed.
//
// FAIL LOUD, NEVER SILENT: when the visual layer is unavailable we return
// 'unverifiable' — never 'signed'. Callers must treat anything other than a
// clean 'signed' as a problem to surface, not a document to file as done.
//
// Owner: Carter, 2026-08-14 (SV-ENG-ESIGN-COMPLETION)
// =============================================================================

'use strict';

const crypto = require('crypto');

const VISION_MODEL = 'claude-sonnet-5';

// Verdicts. Only 'signed' means "safe to file as executed".
const VERDICT = {
  SIGNED: 'signed',
  PARTIAL: 'partially_signed',
  BLANK: 'blank',
  UNVERIFIABLE: 'unverifiable',
};

// -----------------------------------------------------------------------------
// Layer 1 — structural. Must never throw, for any input.
// -----------------------------------------------------------------------------

/**
 * Probe the PDF's bytes and (best-effort) its object model.
 * @param {Buffer} buffer
 * @returns {object} structural report; `.parseable` false is normal, not fatal.
 */
function analyzePdfStructure(buffer) {
  const report = {
    isPdf: false,
    byteLength: Buffer.isBuffer(buffer) ? buffer.length : 0,
    parseable: false,
    parseError: null,
    pageCount: null,
    cryptoSignature: { present: false, byteRanges: 0, pkcs7: false },
    acroForm: {
      readable: false,
      fieldCount: 0,
      filledCount: 0,
      emptyCount: 0,
      signatureFieldCount: 0,
      emptyFieldNames: [],
    },
    widgetAnnotations: 0,
    imageXObjects: 0,
    providerHints: [],
  };

  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return report;
  if (buffer.slice(0, 5).toString('latin1').indexOf('%PDF') !== 0) return report;
  report.isPdf = true;

  // --- raw byte scan: the floor. Works even when the object model won't parse.
  let raw = '';
  try {
    raw = buffer.toString('latin1');
  } catch (_) {
    return report;
  }

  const count = (needle) => {
    if (!needle) return 0;
    return raw.split(needle).length - 1;
  };

  report.cryptoSignature.byteRanges = count('ByteRange');
  report.cryptoSignature.pkcs7 = /adbe\.pkcs7|ETSI\.CAdES/.test(raw);
  report.cryptoSignature.present =
    report.cryptoSignature.byteRanges > 0 && report.cryptoSignature.pkcs7;

  report.widgetAnnotations = (raw.match(/\/Subtype\s*\/Widget/g) || []).length;
  report.imageXObjects = (raw.match(/\/Subtype\s*\/Image/g) || []).length;

  for (const [hint, re] of Object.entries({
    authentisign: /Authentisign|authentisign/,
    docuseal: /DocuSeal|docuseal/,
    docusign: /DocuSign|docusign/,
    adobesign: /EchoSign|Adobe Sign/,
  })) {
    if (re.test(raw)) report.providerHints.push(hint);
  }

  // --- best-effort object model. Each step isolated; failure is expected.
  let PDFDocument = null;
  try {
    ({ PDFDocument } = require('pdf-lib'));
  } catch (err) {
    report.parseError = `pdf-lib unavailable: ${err.message}`;
    return report;
  }

  return analyzeWithPdfLib(PDFDocument, buffer, report);
}

// Split out so the async load can be awaited by the caller that needs it.
// pdf-lib's load() is async, so the sync structural pass above is the guaranteed
// floor and this adds detail when the document happens to be parseable.
async function analyzePdfStructureAsync(buffer) {
  const report = analyzePdfStructure(buffer);
  if (!report.isPdf) return report;

  let PDFDocument;
  try {
    ({ PDFDocument } = require('pdf-lib'));
  } catch (_) {
    return report;
  }

  let doc = null;
  try {
    doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      updateMetadata: false,
      throwOnInvalidObject: false,
    });
    report.parseable = true;
  } catch (err) {
    // EXPECTED for real Authentisign output. Not an error condition.
    report.parseError = String(err && err.message ? err.message : err).slice(0, 300);
    return report;
  }

  try {
    report.pageCount = doc.getPageCount();
  } catch (_) { /* non-fatal */ }

  try {
    const form = doc.getForm();
    const fields = form.getFields();
    report.acroForm.readable = true;
    report.acroForm.fieldCount = fields.length;
    for (const f of fields) {
      const type = f.constructor && f.constructor.name;
      let value = '';
      try {
        if (type === 'PDFTextField') value = f.getText() || '';
        else if (type === 'PDFCheckBox') value = f.isChecked() ? 'checked' : '';
        else if (type === 'PDFDropdown') value = (f.getSelected() || []).join(',');
        else if (type === 'PDFSignature') {
          report.acroForm.signatureFieldCount += 1;
          value = ''; // presence of the field is not proof it was signed
        }
      } catch (_) {
        value = '';
      }
      if (value) {
        report.acroForm.filledCount += 1;
      } else {
        report.acroForm.emptyCount += 1;
        if (report.acroForm.emptyFieldNames.length < 25) {
          try { report.acroForm.emptyFieldNames.push(f.getName()); } catch (_) { /* ignore */ }
        }
      }
    }
  } catch (err) {
    report.acroForm.readable = false;
  }

  return report;
}

// Kept for the sync path; pdf-lib detail is added by the async variant.
function analyzeWithPdfLib(_PDFDocument, _buffer, report) {
  return report;
}

/**
 * The specific DocuSeal failure signature: the document HAS a readable AcroForm
 * with fields, and every single one of them is empty. A genuinely completed
 * form essentially never has 100% empty fields.
 */
function looksLikeEmptyFormFailure(structural) {
  const af = structural && structural.acroForm;
  if (!af || !af.readable) return false;
  if (af.fieldCount < 3) return false;
  return af.filledCount === 0 && af.emptyCount === af.fieldCount;
}

// -----------------------------------------------------------------------------
// Layer 2 — visual. Claude renders the PDF and looks at the signature lines.
// -----------------------------------------------------------------------------

const VISION_PROMPT = `You are verifying whether an e-signed PDF was ACTUALLY signed. A document can be reported "completed" by the e-signature provider while every signature field renders BLANK on the final PDF. That silent failure is exactly what you are catching, and it makes the document legally worthless.

Examine EVERY signature line, initial box, and signature block in this document. For each, decide whether a real signature mark is VISIBLY present (handwritten or drawn mark, a rendered signature graphic, typed cursive signature, or initials) versus the line being empty.

Do not treat a printed/typed party NAME on a "Name:" line as a signature. Do not treat the presence of a signature LINE as a signature. Only a rendered mark counts.

Reply with ONLY a JSON object, no prose, no markdown fence:
{
  "signature_blocks_found": <integer>,
  "signatures_visibly_present": <integer>,
  "blank_signature_lines": <integer>,
  "signer_names_seen": ["<name next to each SIGNED block>"],
  "dates_seen": ["<any signature/execution dates>"],
  "blank_date_or_other_lines": ["<short description of any other consequential blank line, e.g. 'EXECUTED the ___ day of ___'>"],
  "verdict": "signed" | "partially_signed" | "blank",
  "detail": "<one sentence>"
}

"verdict" rules: "blank" if zero signature marks rendered anywhere; "partially_signed" if some blocks are signed and at least one is empty; "signed" only if every signature block that requires a mark has one.`;

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/```json\s*|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) { /* fall through */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

/**
 * Ask Claude to look at the rendered pages.
 * @returns {{ok: boolean, error?: string, data?: object}}
 */
async function verifySignaturesVisually({ buffer, apiKey, model = VISION_MODEL, timeoutMs = 90000 }) {
  if (!apiKey) return { ok: false, error: 'ANTHROPIC_API_KEY not configured' };
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) return { ok: false, error: 'not a pdf buffer' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') },
            },
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      }),
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = (json && json.error && json.error.message) || `http_${res.status}`;
      return { ok: false, error: `vision_api_failed: ${String(detail).slice(0, 200)}` };
    }
    const text = (json.content || [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('');
    const data = extractJson(text);
    if (!data) return { ok: false, error: 'vision_response_unparseable', raw: text.slice(0, 400) };
    return { ok: true, data };
  } catch (err) {
    const msg = err && err.name === 'AbortError' ? 'vision_timeout' : String(err && err.message ? err.message : err);
    return { ok: false, error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// -----------------------------------------------------------------------------
// Combined verdict
// -----------------------------------------------------------------------------

function normalizeName(n) {
  return String(n || '').toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Full verification of an executed PDF.
 *
 * @param {object} opts
 * @param {Buffer} opts.buffer            executed PDF bytes
 * @param {string[]} [opts.expectedSigners] names we expect to see signed
 * @param {string} [opts.apiKey]          ANTHROPIC_API_KEY
 * @param {string} [opts.providerStatus]  what the provider claimed, for the record
 * @returns {Promise<object>} verification result
 */
async function verifyExecutedPdf({ buffer, expectedSigners = [], apiKey, providerStatus = null, model }) {
  const problems = [];
  const structural = await analyzePdfStructureAsync(buffer);

  const sha256 = Buffer.isBuffer(buffer)
    ? crypto.createHash('sha256').update(buffer).digest('hex')
    : null;

  if (!structural.isPdf) {
    return {
      verdict: VERDICT.UNVERIFIABLE,
      safeToFileAsExecuted: false,
      problems: ['Downloaded file is not a PDF.'],
      sha256,
      structural,
      visual: null,
      providerStatus,
      checkedAt: new Date().toISOString(),
    };
  }

  if (looksLikeEmptyFormFailure(structural)) {
    problems.push(
      `Every one of the ${structural.acroForm.fieldCount} form fields on this PDF is empty — the known provider failure where a document reports "completed" but nothing was actually written to it.`,
    );
  }

  const visualRes = await verifySignaturesVisually({ buffer, apiKey, model });
  const visual = visualRes.ok ? visualRes.data : null;

  let verdict;

  if (!visual) {
    // No visual confirmation => we do NOT get to claim it's signed. Structural
    // evidence is corroboration, never proof that a mark rendered.
    verdict = VERDICT.UNVERIFIABLE;
    problems.push(
      `Could not visually verify the signatures (${visualRes.error}). Provider status alone is not proof — a human needs to open this document before it is treated as executed.`,
    );
  } else {
    const present = Number(visual.signatures_visibly_present) || 0;
    const blank = Number(visual.blank_signature_lines) || 0;
    const claimed = String(visual.verdict || '').toLowerCase();

    if (claimed === 'blank' || (present === 0 && blank > 0)) {
      verdict = VERDICT.BLANK;
      problems.push(
        'Document reports as complete but NO signature marks are visibly rendered on the page. This document is not executed and is legally worthless as-is.',
      );
    } else if (claimed === 'partially_signed' || blank > 0) {
      verdict = VERDICT.PARTIAL;
      problems.push(
        `${blank} signature line(s) are still blank — not everyone has signed.`,
      );
    } else if (present > 0) {
      verdict = VERDICT.SIGNED;
    } else {
      verdict = VERDICT.UNVERIFIABLE;
      problems.push('No signature blocks were identified in this document.');
    }

    // Expected-signer cross-check — catches "completed" with one seller missing.
    if (expectedSigners.length) {
      const seen = (visual.signer_names_seen || []).map(normalizeName).filter(Boolean);
      const missing = expectedSigners.filter((exp) => {
        const e = normalizeName(exp);
        if (!e) return false;
        // Require EVERY significant name token to appear in the same seen name.
        // Matching on surname alone is wrong here: co-sellers are usually
        // married and share one — "Thomas Linton" would satisfy a check for
        // "Carol Linton" and a missing co-signer would go undetected, which is
        // exactly the Wild Cherry shape.
        const tokens = e.split(' ').filter((t) => t.length > 1);
        if (!tokens.length) return false;
        return !seen.some((s) => tokens.every((t) => s.includes(t)));
      });
      if (missing.length) {
        problems.push(`Expected signature from ${missing.join(', ')} but could not confirm it on the document.`);
        if (verdict === VERDICT.SIGNED) verdict = VERDICT.PARTIAL;
      }
    }

    // Surface consequential blanks (e.g. the "EXECUTED the ___ day of ___"
    // line the broker still has to date) without downgrading the verdict.
    const otherBlanks = Array.isArray(visual.blank_date_or_other_lines) ? visual.blank_date_or_other_lines : [];
    for (const b of otherBlanks.slice(0, 5)) {
      if (b) problems.push(`Still blank on the executed copy: ${b}`);
    }
  }

  return {
    verdict,
    // The single flag callers should branch on. Anything but a clean 'signed'
    // must surface to the agent instead of filing silently as done.
    safeToFileAsExecuted: verdict === VERDICT.SIGNED,
    problems,
    sha256,
    signerNamesSeen: visual ? (visual.signer_names_seen || []) : [],
    datesSeen: visual ? (visual.dates_seen || []) : [],
    structural,
    visual,
    providerStatus,
    checkedAt: new Date().toISOString(),
  };
}

module.exports = {
  VERDICT,
  VISION_MODEL,
  analyzePdfStructure,
  analyzePdfStructureAsync,
  looksLikeEmptyFormFailure,
  verifySignaturesVisually,
  verifyExecutedPdf,
};
