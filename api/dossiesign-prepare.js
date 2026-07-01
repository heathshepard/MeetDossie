// Vercel Serverless Function: /api/dossiesign-prepare
// Fills all forms in a package from transaction data and returns preview signed URLs.
//
// POST { transaction_id, package_id? }
// - If no package_id, defaults to the buyer-side package when transaction_type
//   includes "buyer" or "purchase", seller-side otherwise.
//
// Returns:
// { ok: true, transaction: {...}, forms: [{ form_id, form_name, trec_number, preview_url, storage_path, document_id }] }
//
// Authorization: Bearer <supabase user JWT>

const { PDFDocument } = require('pdf-lib');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'documents';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

// ---------------------------------------------------------------------------
// Embed the same base64 assets fill-form.js uses — lazy-load only on demand.
// We only need them for the forms requested in the package. We do a dynamic
// require inside the handler so cold-start cost is bounded.
// ---------------------------------------------------------------------------
const FORM_B64_MAP = {
  'resale-contract':       () => require('./_assets/trec-resale-20-19-base64.js'),
  'financing-addendum':    () => require('./_assets/trec-financing-base64.js'),
  'termination-notice':    () => require('./_assets/trec-termination-base64.js'),
  'wire-fraud-warning':    () => require('./_assets/tar-wire-fraud-base64.js'),
  'hoa-addendum':          () => require('./_assets/trec-hoa-addendum-36-11-base64.js'),
  'lead-paint-addendum':   () => require('./_assets/trec-lead-paint-base64.js'),
  'sellers-disclosure':    () => require('./_assets/trec-sellers-disclosure-55-1-base64.js'),
  'amendment':             () => require('./_assets/trec-amendment-39-11-base64.js'),
  'buyer-rep-agreement':   () => require('./_assets/tar-buyer-rep-base64.js'),
  'appraisal-termination': () => require('./_assets/trec-49-1-base64.js'),
  't47-affidavit':         () => require('./_assets/t47-affidavit-base64.js'),
  'unimproved-property':   () => require('./_assets/trec-unimproved-property-base64.js'),
  'seller-financing':      () => require('./_assets/trec-seller-financing-base64.js'),
  'buyers-temp-lease':     () => require('./_assets/trec-buyers-temp-lease-base64.js'),
  'sellers-temp-lease':    () => require('./_assets/trec-sellers-temp-lease-base64.js'),
  'sale-other-property':   () => require('./_assets/trec-sale-other-property-base64.js'),
  'oil-gas-minerals':      () => require('./_assets/trec-oil-gas-minerals-base64.js'),
  'backup-contract':       () => require('./_assets/trec-backup-contract-11-9-base64.js'),
  'coastal-area':          () => require('./_assets/trec-coastal-area-base64.js'),
  'hydrostatic-testing':   () => require('./_assets/trec-hydrostatic-testing-base64.js'),
  'environmental':         () => require('./_assets/trec-environmental-base64.js'),
  'short-sale':            () => require('./_assets/trec-short-sale-base64.js'),
  'gulf-waterway':         () => require('./_assets/trec-gulf-waterway-base64.js'),
  'propane-gas':           () => require('./_assets/trec-propane-gas-base64.js'),
  'residential-leases':    () => require('./_assets/trec-residential-leases-base64.js'),
  'fixture-leases':        () => require('./_assets/trec-fixture-leases-base64.js'),
  'loan-assumption':       () => require('./_assets/trec-loan-assumption-base64.js'),
  'improvement-district':  () => require('./_assets/trec-improvement-district-base64.js'),
};

// Map from form_template short_name/name patterns to fill-form form_type slugs.
// form_templates.short_name is the canonical identifier from form-templates.js seed data.
const SHORT_NAME_TO_FORM_TYPE = {
  'TREC-Resale-Contract':           'resale-contract',
  'TREC-Financing-Addendum':        'financing-addendum',
  'TREC-Termination-Notice':        'termination-notice',
  'TAR-Wire-Fraud-Warning':         'wire-fraud-warning',
  'TREC-HOA-Addendum':              'hoa-addendum',
  'OP-L-Lead-Paint':                'lead-paint-addendum',
  'TREC-55-SDN':                    'sellers-disclosure',
  'TREC-39-Amendment':              'amendment',
  'TAR-Buyer-Rep':                  'buyer-rep-agreement',
  'TREC-49-1':                      'appraisal-termination',
  'T-47-Affidavit':                 't47-affidavit',
  'TREC-9-Unimproved-Property':     'unimproved-property',
  'TREC-26-Seller-Financing':       'seller-financing',
  'TREC-16-Buyers-Temp-Lease':      'buyers-temp-lease',
  'TREC-15-Sellers-Temp-Lease':     'sellers-temp-lease',
  'TREC-10-Sale-Other-Property':    'sale-other-property',
  'TREC-44-Oil-Gas-Minerals':       'oil-gas-minerals',
  'TREC-11-Backup-Contract':        'backup-contract',
  'TREC-33-Coastal-Area':           'coastal-area',
  'TREC-48-Hydrostatic-Testing':    'hydrostatic-testing',
  'TREC-28-Environmental':          'environmental',
  'TREC-45-Short-Sale':             'short-sale',
  'TREC-34-Gulf-Waterway':          'gulf-waterway',
  'TREC-47-Propane-Gas':            'propane-gas',
  'TREC-51-Residential-Leases':     'residential-leases',
  'TREC-52-Fixture-Leases':         'fixture-leases',
  'TREC-41-Loan-Assumption':        'loan-assumption',
  'TREC-IDN-Improvement-District':  'improvement-district',
};

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Field filling helpers
// ---------------------------------------------------------------------------
function safeSetText(form, name, value) {
  try {
    const field = form.getTextField(name);
    if (!field) return;
    const max = field.getMaxLength();
    let v = String(value == null ? '' : value);
    if (max && v.length > max) v = v.slice(0, max);
    field.setText(v);
  } catch (e) {}
}

function safeCheck(form, name) {
  try {
    const box = form.getCheckBox(name);
    if (box) box.check();
  } catch (e) {}
}

function formatDate(iso) {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

function formatMoney(v) {
  const n = Number(String(v || '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) return String(v || '');
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// Map transaction row (DB snake_case) to generic field values object.
// This is the single source of truth for prefill across all forms.
// ---------------------------------------------------------------------------
function txToFieldValues(tx) {
  const fv = {};

  // Parties
  fv.buyer_name   = tx.buyer_name   || '';
  fv.seller_name  = tx.seller_name  || '';

  // Property
  const addr = tx.property_address || '';
  const cityStateZip = tx.city_state_zip || '';
  fv.property_address = cityStateZip ? `${addr}, ${cityStateZip}` : addr;
  fv.county = tx.county || '';

  // Financials
  fv.sale_price    = tx.sale_price    || tx.list_price || '';
  fv.earnest_money = tx.earnest_money || tx.earnest_money_amount || '';
  fv.option_fee    = tx.option_fee    || tx.option_fee_amount    || '';
  fv.option_period_days = tx.option_days || '';
  fv.loan_amount   = '';
  fv.down_payment_amt = '';

  // Dates
  fv.closing_date            = tx.closing_date            || '';
  fv.contract_effective_date = tx.contract_effective_date || (tx.created_at ? tx.created_at.slice(0, 10) : '');

  // Contacts
  fv.title_company = tx.title_company || '';
  fv.earnest_money_to = tx.earnest_money_title_company || tx.title_company || '';

  return fv;
}

// ---------------------------------------------------------------------------
// Minimal fill for each form type.
// Only fills the most important fields (parties, address, dates, price).
// Full fill lives in fill-form.js; this is preview-quality.
// ---------------------------------------------------------------------------
async function fillFormPreview(formType, fv) {
  const loader = FORM_B64_MAP[formType];
  if (!loader) return null;

  let b64;
  try {
    b64 = loader();
  } catch (e) {
    console.warn(`[dossiesign-prepare] could not load b64 for ${formType}:`, e && e.message);
    return null;
  }

  if (!b64 || typeof b64 !== 'string') return null;

  let pdfDoc;
  try {
    pdfDoc = await PDFDocument.load(Buffer.from(b64, 'base64'), { ignoreEncryption: true });
  } catch (e) {
    console.warn(`[dossiesign-prepare] could not load PDF for ${formType}:`, e && e.message);
    return null;
  }

  const form = pdfDoc.getForm();

  const addr = fv.property_address || '';

  // Fill party + address fields common to most TREC forms.
  const textAttempts = [
    ['1 PARTIES The parties to this contract are', fv.buyer_name],
    ['Seller and', fv.seller_name],
    ['Texas known as', addr],
    ['Address of Property', addr],
    ['Address of Property_2', addr],
    ['Contract Concerning', addr],
    ['Contract Concerning_2', addr],
    ['Contract Concerning_3', addr],
    ['Contract Concerning_4', addr],
    ['Addr of Prop', addr],
    ['County of', fv.county],
    ['Sales Price', fv.sale_price ? formatMoney(fv.sale_price) : ''],
    ['Earnest Money', fv.earnest_money ? formatMoney(fv.earnest_money) : ''],
    ['Option Fee', fv.option_fee ? formatMoney(fv.option_fee) : ''],
    ['Closing Date', formatDate(fv.closing_date)],
    ['Title Company', fv.title_company],
    ['buyer', fv.buyer_name],
    ['seller', fv.seller_name],
    ['Buyer', fv.buyer_name],
    ['Seller', fv.seller_name],
  ];

  for (const [name, value] of textAttempts) {
    if (value) safeSetText(form, name, value);
  }

  try {
    form.flatten();
  } catch (e) {}

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// Upload filled PDF to Supabase Storage and create a documents row.
// Returns { storagePath, documentId, previewUrl }
// ---------------------------------------------------------------------------
async function uploadPreview(userId, transactionId, formSlug, formName, pdfBuffer) {
  const ts = Date.now();
  const storagePath = `dossiesign/${transactionId}/${formSlug}-preview-${ts}.pdf`;

  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/pdf',
      'x-upsert': 'true',
    },
    body: pdfBuffer,
  });

  if (!uploadRes.ok) {
    const text = await uploadRes.text().catch(() => '');
    throw new Error(`Storage upload failed (${uploadRes.status}): ${text.slice(0, 200)}`);
  }

  // Insert a documents row so it appears in the dossier and can be sent for signature.
  const docRow = {
    user_id: userId,
    transaction_id: transactionId,
    file_name: `${formName} (DossieSign Preview).pdf`,
    document_type: 'filled_form',
    storage_path: storagePath,
    status: 'filled',
  };

  const insertRes = await supa('documents', {
    method: 'POST',
    body: JSON.stringify(docRow),
  });

  let documentId = null;
  if (insertRes.ok) {
    const inserted = await insertRes.json().catch(() => null);
    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    documentId = row?.id || null;
  }

  // Generate a signed URL for iframe preview (1 hour).
  const signUrl = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
  const signRes = await fetch(signUrl, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }),
  });

  let previewUrl = null;
  if (signRes.ok) {
    const signJson = await signRes.json().catch(() => null);
    if (signJson && signJson.signedURL) {
      const p = signJson.signedURL.startsWith('/') ? signJson.signedURL : `/${signJson.signedURL}`;
      previewUrl = `${SUPABASE_URL}/storage/v1${p}`;
    }
  }

  return { storagePath, documentId, previewUrl };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
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
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'dossiesign-prepare', 30, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};
    const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
    const packageIdInput = sanitizeString(body.package_id, { maxLength: 200 }) || null;

    if (!transactionId) throw new ValidationError('transaction_id is required.');

    // Fetch the transaction — verify ownership.
    const txRes = await supa(
      `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`
    );
    if (!txRes.ok) {
      const text = await txRes.text().catch(() => '');
      throw new Error(`transactions fetch failed (${txRes.status}): ${text.slice(0, 200)}`);
    }
    const txRows = await txRes.json();
    if (!Array.isArray(txRows) || txRows.length === 0) {
      throw new ValidationError('Transaction not found or does not belong to you.', 404);
    }
    const tx = txRows[0];

    // Determine which package to use.
    // If the caller specified one, validate it. Otherwise pick buyer or seller default.
    let packageId = packageIdInput;

    if (!packageId) {
      const txType = (tx.transaction_type || '').toLowerCase();
      const isBuyer = txType.includes('buyer') || txType.includes('purchase') || !txType || txType === '';
      // Fetch all visible packages to find the system default matching the side.
      const pkgsRes = await supa(
        `form_packages?or=(user_id.is.null,user_id.eq.${encodeURIComponent(userId)})&order=is_default.desc,name.asc&select=id,name,side,is_default`
      );
      if (!pkgsRes.ok) {
        const text = await pkgsRes.text().catch(() => '');
        throw new Error(`form_packages fetch failed (${pkgsRes.status}): ${text.slice(0, 200)}`);
      }
      const pkgs = await pkgsRes.json();
      const side = isBuyer ? 'buyer' : 'seller';
      const matched = (pkgs || []).find((p) => p.side === side && p.is_default) ||
                      (pkgs || []).find((p) => p.is_default) ||
                      (pkgs || [])[0];
      if (!matched) {
        throw new ValidationError('No form package found. Create a package in the Form Library first.', 404);
      }
      packageId = matched.id;
    }

    // Fetch package items with form template details.
    const itemsRes = await supa(
      `form_package_items?package_id=eq.${encodeURIComponent(packageId)}&order=position.asc&select=id,position,form_template_id`
    );
    if (!itemsRes.ok) {
      const text = await itemsRes.text().catch(() => '');
      throw new Error(`form_package_items fetch failed (${itemsRes.status}): ${text.slice(0, 200)}`);
    }
    const items = await itemsRes.json();
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(200).json({ ok: true, transaction: tx, forms: [] });
    }

    // Fetch template details.
    const tids = items.map((i) => encodeURIComponent(i.form_template_id)).join(',');
    const tmplRes = await supa(
      `form_templates?id=in.(${tids})&is_active=eq.true&select=id,name,short_name,trec_number,category`
    );
    if (!tmplRes.ok) {
      const text = await tmplRes.text().catch(() => '');
      throw new Error(`form_templates fetch failed (${tmplRes.status}): ${text.slice(0, 200)}`);
    }
    const templates = await tmplRes.json();
    const tmplById = {};
    for (const t of (templates || [])) tmplById[t.id] = t;

    // Build field values from transaction data.
    const fv = txToFieldValues(tx);

    // Fill and upload each form.
    const forms = [];
    for (const item of items) {
      const tmpl = tmplById[item.form_template_id];
      if (!tmpl) continue;

      const formType = SHORT_NAME_TO_FORM_TYPE[tmpl.short_name] || null;

      let previewUrl = null;
      let storagePath = null;
      let documentId = null;
      let error = null;

      if (!formType) {
        error = `Form type mapping not found for short_name="${tmpl.short_name}". Update SHORT_NAME_TO_FORM_TYPE in dossiesign-prepare.js.`;
        console.warn(`[dossiesign-prepare] ${error}`);
      } else {
        try {
          const pdfBuffer = await fillFormPreview(formType, fv);
          if (!pdfBuffer) {
            error = `Failed to fill form. Template may not be in FORM_B64_MAP.`;
            console.warn(`[dossiesign-prepare] ${error} for ${formType}`);
          } else {
            try {
              const uploaded = await uploadPreview(userId, transactionId, formType, tmpl.name, pdfBuffer);
              previewUrl = uploaded.previewUrl;
              storagePath = uploaded.storagePath;
              documentId = uploaded.documentId;
              if (!documentId) {
                error = 'Failed to create document record in database.';
                console.warn(`[dossiesign-prepare] ${error}`);
              }
            } catch (uploadErr) {
              error = `Upload failed: ${uploadErr && uploadErr.message ? uploadErr.message : 'unknown error'}`;
              console.warn(`[dossiesign-prepare] ${error} for ${formType}`);
            }
          }
        } catch (fillErr) {
          error = `Fill failed: ${fillErr && fillErr.message ? fillErr.message : 'unknown error'}`;
          console.warn(`[dossiesign-prepare] ${error} for ${formType}`);
        }
      }

      forms.push({
        form_id: tmpl.id,
        form_name: tmpl.name,
        trec_number: tmpl.trec_number || '',
        form_type: formType,
        preview_url: previewUrl,
        storage_path: storagePath,
        document_id: documentId,
        error: error,
      });
    }

    return res.status(200).json({
      ok: true,
      transaction: {
        id: tx.id,
        property_address: tx.property_address || '',
        city_state_zip: tx.city_state_zip || '',
        buyer_name: tx.buyer_name || '',
        seller_name: tx.seller_name || '',
        buyer_email: tx.buyer_email || '',
        seller_email: tx.seller_email || '',
        transaction_type: tx.transaction_type || '',
        closing_date: tx.closing_date || '',
        sale_price: tx.sale_price || tx.list_price || '',
      },
      forms,
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
      return res.status(429).json({ ok: false, error: 'Too many requests. Try again later.' });
    }
    console.error('[dossiesign-prepare] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not prepare forms. Try again.' });
  }
};
