// Vercel Serverless Function: /api/net-sheet-estimate
//
// The chat-reachable seller's net sheet. Sibling to /api/net-sheet (the form
// calculator behind the Net Sheet panel), deliberately a separate route:
//
//   /api/net-sheet          form-driven, every field present, returns a point
//                           total. Absent inputs are treated as 0, which is
//                           safe there because the form shows the agent every
//                           empty box before they press Calculate.
//
//   /api/net-sheet-estimate conversation-driven, most fields absent, returns
//                           an estimate that says so. Absent inputs are
//                           UNKNOWN, never 0, because in a spoken sentence
//                           there is no form to eyeball — "what does my seller
//                           net" carries no fee schedule with it.
//
// Both share the arithmetic in api/_lib/net-sheet-calc.js. This one adds the
// honesty layer in api/_lib/net-sheet-estimate.js: unknown-vs-zero, per-figure
// source and date, a range instead of a point when anything is missing, and a
// disclaimer carried on the document rather than in a footnote.
//
// POST {
//   transaction_id  required — prefills sale price, commission, option fee
//                   from whatever the contract scan already captured
//   sale_price, commission_pct,
//   mortgage_payoff, escrow_fee, title_policy_cost, hoa_transfer_fee,
//   home_warranty_cap, survey_cost, repairs, other_credits, option_fee_credit
//     — each optional. Omit = unknown. "n/a" = does not apply (a real zero).
// }
// Authorization: Bearer <supabase user JWT>

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const {
  buildNetSheetEstimate,
  buildEstimateHtml,
  normalizeMemberFigure,
  normalizeMemberFigures,
} = require('./_lib/net-sheet-estimate');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRest(pathPart, init) {
  const url = SUPABASE_URL + '/rest/v1/' + pathPart;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Server not configured.' });
    return;
  }

  try {
    const { userId } = await verifySupabaseToken(req);
    const safeUid = encodeURIComponent(userId);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id || body.transactionId || '', { maxLength: 200 });
    if (!transactionId) throw new ValidationError('transaction_id is required.');

    // Owner-scoped: the multi-tenant boundary. A dossier belonging to another
    // member is simply not found.
    const txResp = await supabaseRest(
      'transactions?id=eq.' + encodeURIComponent(transactionId) +
      '&user_id=eq.' + safeUid +
      '&select=property_address,sale_price,commission_rate,seller_name,option_fee,updated_at&limit=1',
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(() => '');
      throw new Error('transaction fetch failed (' + txResp.status + '): ' + text.slice(0, 200));
    }
    const txRows = await txResp.json();
    const tx = (Array.isArray(txRows) && txRows[0]) || null;
    if (!tx) return res.status(404).json({ ok: false, error: 'Dossier not found.' });

    const contractDate = tx.updated_at || null;
    const now = new Date();

    // Sale price: the agent's stated figure wins, else whatever the contract
    // scan captured. Either way the source is recorded.
    let salePrice = normalizeMemberFigure(body.sale_price, now);
    if (salePrice === undefined && tx.sale_price != null) {
      salePrice = { value: tx.sale_price, source: 'contract', as_of: contractDate };
    }

    // Commission: NOT defaulted. /api/net-sheet falls back to 3% when nothing
    // is supplied; here an unstated commission stays unknown, because on a
    // $999,000 sale the difference between 3% and 6% is $30,000 and nobody
    // said which it is.
    let commissionPct = normalizeMemberFigure(body.commission_pct, now);
    if (commissionPct === undefined && tx.commission_rate) {
      const parsed = parseFloat(String(tx.commission_rate).replace(/[^0-9.]/g, ''));
      if (Number.isFinite(parsed) && parsed > 0) {
        commissionPct = { value: parsed, source: 'listing_agreement', as_of: contractDate };
      }
    }

    const figures = normalizeMemberFigures(body, now);
    // Option fee is the one deduction-side figure the contract scan already
    // holds, so fall back to it when the agent didn't mention one.
    if (figures.option_fee_credit === undefined && tx.option_fee != null && Number(tx.option_fee) > 0) {
      figures.option_fee_credit = { value: tx.option_fee, source: 'contract', as_of: contractDate };
    }

    const estimate = buildNetSheetEstimate({
      salePrice,
      commissionPct,
      figures,
      propertyAddress: tx.property_address || '',
      sellerName: tx.seller_name || '',
      now,
    });

    return res.status(200).json({
      ok: true,
      property_address: estimate.propertyAddress,
      seller_name: estimate.sellerName,
      sale_price: estimate.salePrice,
      commission_pct: estimate.commissionPct,
      lines: estimate.lines,
      unknown: estimate.unknown,
      material_unknown: estimate.materialUnknown,
      has_unknowns: estimate.hasUnknowns,
      ceiling: estimate.ceiling,
      ceiling_display: estimate.ceilingDisplay,
      point: estimate.point,
      headline: estimate.headline,
      disclaimer: estimate.disclaimer,
      reconciliation: estimate.reconciliation,
      generated_at: estimate.generatedAt,
      html: buildEstimateHtml(estimate),
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error && error.code === 'MISSING_SALE_PRICE') {
      return res.status(400).json({ ok: false, error: error.message });
    }
    console.error('[net-sheet-estimate] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not build that net sheet. Try again.' });
  }
};
