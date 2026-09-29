// Vercel Serverless Function: /api/offer-net-sheet
//
// Seller's net sheet built directly off a scanned OFFER's money stack
// (api/scan-contract.js's extracted.moneyStack) — the concession/BAC/service
// contract givebacks a headline sales price hides. See
// api/_lib/offer-net-sheet.js for the full rationale and the arithmetic.
//
// POST {
//   money_stack   required — the `extracted.moneyStack` object returned by
//                 a prior /api/scan-contract call on this offer. The client
//                 already has this from the scan response; this endpoint
//                 does not re-scan or re-derive it.
//   payoff        REQUIRED for a real proceeds figure. Omit it and the sheet
//                 still returns every other known line, but blocked=true and
//                 no proceeds total — see api/_lib/offer-net-sheet.js rule 1.
//   transaction_id  optional — recorded for the owner-scoped audit log only;
//                   this endpoint does not read the transactions table.
//   escrow_fee_total, title_policy_cost, deed_prep_fee, tax_certificate_fee,
//   lien_release_recording_fee, tax_amount_annual, tax_proration_date,
//   property_address, seller_name  — all optional overrides/inputs.
// }
// Authorization: Bearer <supabase user JWT>

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { buildOfferNetSheet } = require('./_lib/offer-net-sheet');

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  try {
    // Multi-tenant boundary: this endpoint only ever computes off the
    // money_stack the caller supplies in the request body (nothing is read
    // from the shared `transactions` table here), but it still requires the
    // member's own auth so the compute isn't open to unauthenticated abuse,
    // same as every other scan-adjacent endpoint.
    const { userId } = await verifySupabaseToken(req);

    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'offer-net-sheet', 30, 60 * 60 * 1000);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (!body.money_stack || typeof body.money_stack !== 'object') {
      throw new ValidationError('money_stack is required — pass the extracted.moneyStack object from a prior /api/scan-contract call.');
    }

    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    const propertyAddress = sanitizeString(body.property_address, { maxLength: 300 }) || '';
    const sellerName = sanitizeString(body.seller_name, { maxLength: 300 }) || '';

    const sheet = buildOfferNetSheet({
      moneyStack: body.money_stack,
      payoff: body.payoff,
      escrowFeeTotal: body.escrow_fee_total,
      titlePolicyCost: body.title_policy_cost,
      deedPrepFee: body.deed_prep_fee,
      taxCertificateFee: body.tax_certificate_fee,
      lienReleaseRecordingFee: body.lien_release_recording_fee,
      taxAmountAnnual: body.tax_amount_annual,
      taxProrationDate: sanitizeString(body.tax_proration_date, { maxLength: 20 }) || undefined,
      propertyAddress,
      sellerName,
    });

    return res.status(200).json({
      ok: true,
      transaction_id: transactionId || null,
      property_address: sheet.propertyAddress,
      seller_name: sheet.sellerName,
      sale_price: sheet.salePrice,
      lines: sheet.lines,
      unknown: sheet.unknown,
      material_unknown: sheet.materialUnknown,
      has_unknowns: sheet.hasUnknowns,
      blocked: sheet.blocked,
      blocked_reason: sheet.blockedReason,
      total_giveback: sheet.totalGiveback,
      ceiling: sheet.ceiling,
      ceiling_display: sheet.ceilingDisplay,
      headline: sheet.headline,
      disclaimer: sheet.disclaimer,
      generated_at: sheet.generatedAt,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Rate limit exceeded. Please try again later.' });
    }
    if (error && (error.code === 'MISSING_SALE_PRICE' || error.code === 'MISSING_MONEY_STACK')) {
      return res.status(400).json({ ok: false, error: error.message });
    }
    console.error('[offer-net-sheet] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not build that net sheet. Try again.' });
  }
};
