// Vercel Serverless Function: /api/net-sheet
// Seller's Net Sheet calculator (Block 11D)
//
// POST {
//   transaction_id (optional — prefills from transaction),
//   sale_price, commission_pct, mortgage_payoff, escrow_fee,
//   title_policy_cost, hoa_transfer_fee, repairs, other_credits,
//   property_address (optional override)
// }
//
// Returns: { ok, breakdown, net_proceeds, property_address, sale_price, generated_at }
//
// Authorization: Bearer <supabase user JWT>

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

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

function toNum(v, fallback) {
  if (v == null || v === '') return fallback != null ? fallback : 0;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : (fallback != null ? fallback : 0);
}

function fmtMoney(n) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

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

    // If transaction_id provided, fetch defaults from transaction
    let txDefaults = {};
    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    if (transactionId) {
      const txResp = await supabaseRest(
        'transactions?id=eq.' + encodeURIComponent(transactionId) +
        '&user_id=eq.' + safeUid +
        '&select=property_address,sale_price,commission_rate,seller_name&limit=1',
        { method: 'GET' },
      );
      if (txResp.ok) {
        const rows = await txResp.json();
        const tx = Array.isArray(rows) ? rows[0] : null;
        if (tx) {
          txDefaults.property_address = tx.property_address;
          txDefaults.sale_price = tx.sale_price;
          txDefaults.seller_name = tx.seller_name;
          // commission_rate might be stored as "3%" or "3" — normalize
          if (tx.commission_rate) {
            txDefaults.commission_pct = parseFloat(String(tx.commission_rate).replace(/[^0-9.]/g, ''));
          }
        }
      }
    }

    // Merge body over tx defaults
    const salePrice = toNum(body.sale_price != null ? body.sale_price : txDefaults.sale_price);
    if (!salePrice) throw new ValidationError('sale_price is required.');

    const commissionPct = toNum(body.commission_pct != null ? body.commission_pct : txDefaults.commission_pct, 3);
    const mortgagePayoff = toNum(body.mortgage_payoff, 0);
    const escrowFee = toNum(body.escrow_fee, 0);
    const titlePolicyCost = toNum(body.title_policy_cost, 0);
    const hoaTransferFee = toNum(body.hoa_transfer_fee, 0);
    const repairs = toNum(body.repairs, 0);
    const otherCredits = toNum(body.other_credits, 0);
    const propertyAddress = sanitizeString(body.property_address || txDefaults.property_address, { maxLength: 300 }) || '';
    const sellerName = sanitizeString(body.seller_name || txDefaults.seller_name, { maxLength: 300 }) || '';

    // Calculate
    const commissionAmount = (salePrice * commissionPct) / 100;
    const totalDeductions = commissionAmount + mortgagePayoff + escrowFee + titlePolicyCost + hoaTransferFee + repairs + otherCredits;
    const netProceeds = salePrice - totalDeductions;

    const breakdown = [
      { label: 'Sale Price', amount: salePrice, type: 'income' },
      { label: 'Commission (' + commissionPct.toFixed(2) + '%)', amount: -commissionAmount, type: 'deduction' },
      { label: 'Mortgage Payoff', amount: -mortgagePayoff, type: 'deduction' },
      { label: 'Escrow / Closing Fee', amount: -escrowFee, type: 'deduction' },
      { label: 'Title Policy', amount: -titlePolicyCost, type: 'deduction' },
      { label: 'HOA Transfer Fee', amount: -hoaTransferFee, type: 'deduction' },
      { label: 'Agreed Repairs', amount: -repairs, type: 'deduction' },
      { label: 'Other Credits to Buyer', amount: -otherCredits, type: 'deduction' },
    ].filter(function(item) { return item.amount !== 0; });

    const htmlOutput = buildHtml({
      propertyAddress,
      sellerName,
      salePrice,
      commissionPct,
      commissionAmount,
      mortgagePayoff,
      escrowFee,
      titlePolicyCost,
      hoaTransferFee,
      repairs,
      otherCredits,
      totalDeductions,
      netProceeds,
      generatedAt: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    });

    return res.status(200).json({
      ok: true,
      breakdown,
      net_proceeds: netProceeds,
      total_deductions: totalDeductions,
      property_address: propertyAddress,
      seller_name: sellerName,
      sale_price: salePrice,
      generated_at: new Date().toISOString(),
      html: htmlOutput,
    });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[net-sheet] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not calculate net sheet. Try again.' });
  }
};

function fmtDollars(n) {
  if (n == null || !Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
}

function buildHtml(d) {
  const rows = [
    ['Sale Price', d.salePrice, false],
    ['Commission (' + d.commissionPct.toFixed(2) + '%)', -d.commissionAmount, true],
    ['Mortgage Payoff', -d.mortgagePayoff, true],
    ['Escrow / Closing Fee', -d.escrowFee, true],
    ['Title Policy', -d.titlePolicyCost, true],
    ['HOA Transfer Fee', -d.hoaTransferFee, true],
    ['Agreed Repairs', -d.repairs, true],
    ['Other Credits to Buyer', -d.otherCredits, true],
  ].filter(function(r) { return r[1] !== 0; });

  const rowsHtml = rows.map(function(r) {
    const isDeduction = r[2];
    const displayAmt = isDeduction ? '(' + fmtDollars(-r[1]) + ')' : fmtDollars(r[1]);
    return '<tr>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #f0e8e4;">' + r[0] + '</td>' +
      '<td style="padding:10px 12px;border-bottom:1px solid #f0e8e4;text-align:right;color:' +
        (isDeduction ? '#c0392b' : '#2c3e50') + ';">' + displayAmt + '</td>' +
      '</tr>';
  }).join('');

  return '<!DOCTYPE html>' +
    '<html lang="en"><head>' +
    '<meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Seller\'s Net Sheet</title>' +
    '<style>' +
    'body{font-family:Georgia,serif;background:#fff;color:#2c3e50;max-width:600px;margin:40px auto;padding:24px;}' +
    '@media print{body{margin:0;padding:16px;}}' +
    '.header{text-align:center;margin-bottom:24px;}' +
    '.header h1{font-size:22px;color:#1A1A2E;margin:0 0 4px;}' +
    '.header p{color:#666;font-size:13px;margin:0;}' +
    'table{width:100%;border-collapse:collapse;font-size:15px;margin-bottom:16px;}' +
    'th{background:#F5E6E0;color:#1A1A2E;padding:10px 12px;text-align:left;font-weight:600;}' +
    'th:last-child{text-align:right;}' +
    '.net-row td{background:#1A1A2E;color:#fff;font-weight:700;font-size:17px;padding:14px 12px;}' +
    '.net-row td:last-child{text-align:right;color:#C9A96E;}' +
    '.footer{font-size:11px;color:#999;text-align:center;margin-top:16px;}' +
    '</style>' +
    '</head><body>' +
    '<div class="header">' +
    '<h1>Seller\'s Net Sheet</h1>' +
    (d.propertyAddress ? '<p>' + d.propertyAddress + '</p>' : '') +
    (d.sellerName ? '<p>Seller: ' + d.sellerName + '</p>' : '') +
    '</div>' +
    '<table>' +
    '<thead><tr><th>Item</th><th>Amount</th></tr></thead>' +
    '<tbody>' + rowsHtml + '</tbody>' +
    '<tfoot><tr class="net-row"><td>Estimated Net Proceeds</td><td>' + fmtDollars(d.netProceeds) + '</td></tr></tfoot>' +
    '</table>' +
    '<p class="footer">Generated ' + d.generatedAt + ' by Dossie &bull; meetdossie.com &bull; Estimates only &mdash; actual amounts vary at closing.</p>' +
    '</body></html>';
}
