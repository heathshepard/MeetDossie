// api/_middleware/validate.js
// Input validators for API endpoints.

const MIN_PDF_BASE64_LEN = 100;
const MAX_PDF_BYTES = 32 * 1024 * 1024; // 32 MB — Anthropic doc-block limit

// Permissive base64 regex (allows any whitespace inside; we strip first).
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Conservative email regex — local@domain.tld with sane character classes.
const EMAIL_RE = /^[A-Za-z0-9._%+\-]{1,64}@[A-Za-z0-9.\-]{1,253}\.[A-Za-z]{2,}$/;

// C0 control chars (excluding TAB/LF/CR) plus DEL — stripped from sanitized strings.
const CONTROL_CHAR_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]',
  'g',
);

class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.status = status;
  }
}

function validatePdfBase64(base64String) {
  if (typeof base64String !== 'string') {
    throw new ValidationError('pdfBase64 must be a string.');
  }
  if (base64String.length <= MIN_PDF_BASE64_LEN) {
    throw new ValidationError(
      `pdfBase64 is too short to be a valid PDF (got ${base64String.length} chars).`,
    );
  }

  const cleaned = base64String.replace(/\s+/g, '');
  if (!BASE64_RE.test(cleaned)) {
    throw new ValidationError('pdfBase64 contains characters that are not valid base64.');
  }
  if (cleaned.length % 4 !== 0) {
    throw new ValidationError('pdfBase64 length is not a multiple of 4 (malformed base64).');
  }

  const approxBytes = Math.floor((cleaned.length * 3) / 4);
  if (approxBytes > MAX_PDF_BYTES) {
    throw new ValidationError(
      `PDF is too large (~${approxBytes} bytes). Max is ${MAX_PDF_BYTES} bytes.`,
      413,
    );
  }

  // Decode just enough to check the magic header.
  let header;
  try {
    header = Buffer.from(cleaned.slice(0, 16), 'base64').toString('binary');
  } catch (e) {
    throw new ValidationError('pdfBase64 could not be decoded as base64.');
  }
  if (!header.startsWith('%PDF-')) {
    throw new ValidationError('Decoded payload does not look like a PDF (missing %PDF- header).');
  }

  return { ok: true, cleaned, approxBytes };
}

function validateEmail(email) {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length === 0 || trimmed.length > 320) return false;
  return EMAIL_RE.test(trimmed);
}

// Generic string sanitizer for user-supplied text headed for storage:
// trims, drops control chars (except \n \t \r), enforces max length.
function sanitizeString(value, { maxLength = 1000 } = {}) {
  if (value === null || value === undefined) return null;
  let s = String(value);
  s = s.replace(CONTROL_CHAR_RE, '');
  s = s.trim();
  if (s.length === 0) return null;
  if (s.length > maxLength) s = s.slice(0, maxLength);
  return s;
}

module.exports = {
  validatePdfBase64,
  validateEmail,
  sanitizeString,
  ValidationError,
  MAX_PDF_BYTES,
};
