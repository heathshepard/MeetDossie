// Vercel Serverless Function: /api/esign-verify-stamp
// GET ?code=DS-XXXX-X
//
// Resolves the inline verification code printed next to a DossieSign
// signature/initials mark (see api/_lib/signature-stamp.js) back to the real
// DocuSeal submission + submitter it was generated from. This is the
// "actually resolves" half of the stamp — without it the code on the page is
// decorative.
//
// No auth required (mirrors the purpose of dotloop's own public verification
// stamp: a title company or compliance reviewer holding a printed/PDF page,
// not logged into Dossie, needs to be able to check it). Rate-limited by IP
// to prevent code enumeration. Returns only what's needed to confirm
// authenticity — no email, no document contents, no submission URL/slug that
// could be replayed to reach the live signing session.
//
// Owner: Carter, 2026-10-01
//
// Env vars required:
//   DOCUSEAL_API_KEY
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (rate limiting only)

'use strict';

const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');
const { fromVerificationCode, fetchDocusealSubmission, formatStampTimestamp } = require('./_lib/signature-stamp');

const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'GET, OPTIONS' });
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    await checkRateLimit(clientIpFromReq(req), 'esign-verify-stamp', 30, 60 * 60 * 1000);
  } catch (err) {
    if (err instanceof RateLimitError) {
      res.setHeader('Retry-After', String(err.retryAfterSeconds || 3600));
      return res.status(429).json({ ok: false, error: 'Too many verification checks. Try again later.' });
    }
    throw err;
  }

  const code = (req.query && req.query.code) || '';
  const decoded = fromVerificationCode(code);
  if (!decoded) {
    return res.status(400).json({ ok: false, verified: false, error: 'Not a recognizable DossieSign verification code.' });
  }

  if (!DOCUSEAL_API_KEY) {
    console.error('[esign-verify-stamp] DOCUSEAL_API_KEY not set — cannot resolve.');
    return res.status(503).json({ ok: false, verified: false, error: 'Verification service temporarily unavailable.' });
  }

  const submission = await fetchDocusealSubmission(decoded.submissionId, DOCUSEAL_API_KEY);
  if (!submission) {
    return res.status(404).json({ ok: true, verified: false, error: 'No matching signature request found.' });
  }

  const submitter = (submission.submitters || []).find((s) => s && s.id === decoded.submitterId);
  if (!submitter || !submitter.completed_at) {
    return res.status(200).json({ ok: true, verified: false, error: 'This code does not match a completed signature.' });
  }

  return res.status(200).json({
    ok: true,
    verified: true,
    signerName: submitter.name || null,
    role: submitter.role || null,
    completedAt: submitter.completed_at,
    completedAtDisplay: formatStampTimestamp(submitter.completed_at),
    submissionStatus: submission.status || null,
    documentCount: Array.isArray(submission.documents) ? submission.documents.length : null,
  });
};
