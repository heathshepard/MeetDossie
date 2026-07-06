// Vercel Serverless Function: /api/esign-create
// POST { documentId, signers: [{name, email, role}], message?, fields?, templateId? }
// Authorization: Bearer <supabase user JWT>
//
// Sends a PDF for e-signature via DocuSeal Cloud Pro.
// If templateId is provided, creates a submission from a template (Phase 3).
// If fields are provided, field placement coordinates are sent to DocuSeal (Phase 2).
//
// ==========================================================================
// SQL — RUN IN SUPABASE SQL EDITOR BEFORE DEPLOYING
// ==========================================================================
//
//   CREATE TABLE IF NOT EXISTS public.signature_requests (
//     id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//     user_id                 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
//     transaction_id          UUID REFERENCES public.transactions(id) ON DELETE CASCADE,
//     document_id             UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
//     signed_document_id      UUID REFERENCES public.documents(id),
//     docuseal_submission_id  TEXT NOT NULL,
//     status                  TEXT NOT NULL DEFAULT 'sent',
//     signers                 JSONB NOT NULL DEFAULT '[]',
//     message                 TEXT,
//     completed_at            TIMESTAMPTZ,
//     created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
//     updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   );
//
//   CREATE INDEX IF NOT EXISTS idx_sr_transaction ON public.signature_requests(transaction_id);
//   CREATE INDEX IF NOT EXISTS idx_sr_user       ON public.signature_requests(user_id);
//   CREATE INDEX IF NOT EXISTS idx_sr_submission ON public.signature_requests(docuseal_submission_id);
//
//   ALTER TABLE public.signature_requests ENABLE ROW LEVEL SECURITY;
//
//   CREATE POLICY "owner_read"   ON public.signature_requests FOR SELECT USING (auth.uid() = user_id);
//   CREATE POLICY "owner_insert" ON public.signature_requests FOR INSERT WITH CHECK (auth.uid() = user_id);
//   CREATE POLICY "owner_update" ON public.signature_requests FOR UPDATE USING (auth.uid() = user_id);
//   CREATE POLICY "service_all"  ON public.signature_requests FOR ALL USING (auth.role() = 'service_role');
//
// ==========================================================================

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';
const BUCKET = 'documents';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || VERCEL_PREVIEW_RE.test(origin)) {
      allowOrigin = origin;
    }
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

async function getDocumentRow(documentId, userId) {
  const res = await supa(`documents?id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,transaction_id,storage_path,file_name,document_type`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`documents fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new ValidationError('Document not found or does not belong to you.', 404);
  }
  return rows[0];
}

// TREC 20-18 (One to Four Family Residential Contract — Resale) routing.
//
// 2026-07-05 ATLAS ROUND 6 — GOLD-2026-07-05-v11-esign-coords-from-acroform
// v10 (template 4018208) shipped with widgets in the wrong position — Heath's
// phone screenshots showed sig widgets floating in the left margin on page 9
// and initial widgets ABOVE the "Initialed for identification" line on page 8.
// The template's widget positions in DocuSeal Studio are broken.
//
// v11 approach (Path B): BYPASS the broken template. Build a fresh transient
// template from the raw PDF on every send, placing signature/initial widgets
// at coordinates extracted DIRECTLY from the AcroForm widgets in
// trec-20-18-raw.pdf. The extraction script (.tmp/atlas26-build-coord-map.js)
// reads pdf-lib widget rectangles and emits
// api/_assets/trec-20-18-esign-coords.json.
//
// Visual verification: red rectangles at these coords overlap the "Buyer"
// underline on page 9 and the "Initialed for identification by Buyer __" line
// on page 8 in the raw PDF render (see .tmp/atlas26-p9-overlay-09.png).
//
// RESALE_TEMPLATE_ID (4018208) is kept as a legacy id in case a caller still
// passes it explicitly, but the resale-contract default path no longer touches it.
const RESALE_TEMPLATE_ID = 4018208;

// Load AcroForm-derived signing widget coordinates for TREC 20-18.
// Structure: RESALE_COORDS[side][index] = { initials: [{page,x,y,w,h}...], signature: {page,x,y,w,h} }
// side: 'buyer' | 'seller'; index: 0 (first party) or 1 (co-party).
// y is TOP-origin (0=top, 1=bottom of page). DocuSeal uses top-origin per
// its area.vue: `top: y * 100 + '%'`.
const _path = require('path');
const _fs = require('fs');
let RESALE_COORDS_CACHE = null;
function loadResaleCoords() {
  if (RESALE_COORDS_CACHE) return RESALE_COORDS_CACHE;
  try {
    const p = _path.join(__dirname, '_assets', 'trec-20-18-esign-coords.json');
    RESALE_COORDS_CACHE = JSON.parse(_fs.readFileSync(p, 'utf8'));
    console.log(`[esign-create] Loaded TREC 20-18 esign coord map from ${p}`);
    for (const side of ['buyer', 'seller']) {
      for (let idx = 0; idx < RESALE_COORDS_CACHE[side].length; idx += 1) {
        const c = RESALE_COORDS_CACHE[side][idx];
        const label = `${side}${idx + 1}`;
        console.log(`[esign-create]   ${label} sig p${c.signature.page}: x=${c.signature.x} y=${c.signature.y} w=${c.signature.w} h=${c.signature.h}`);
        for (const ini of c.initials) {
          console.log(`[esign-create]   ${label} p${ini.page} initial: x=${ini.x} y=${ini.y} w=${ini.w} h=${ini.h}`);
        }
      }
    }
  } catch (err) {
    console.error('[esign-create] Failed to load TREC 20-18 coord map:', err && err.message);
    RESALE_COORDS_CACHE = { buyer: [], seller: [] };
  }
  return RESALE_COORDS_CACHE;
}

function buildResaleFieldsForSigner(roleName, side, sideIndex) {
  if (side === 'agent') {
    // Agent gets a signature + date on page 9 below the buyer/seller block.
    // Auto-timestamp the date on sign via preferences.format.
    return [
      { name: `${roleName} Signature`, type: 'signature',
        areas: [{ page: 9, x: 0.05, y: 0.75, w: 0.35, h: 0.035 }] },
      { name: `${roleName} Date`, type: 'date',
        preferences: { format: 'MM/DD/YYYY' },
        areas: [{ page: 9, x: 0.42, y: 0.75, w: 0.18, h: 0.035 }] },
    ];
  }
  const coords = loadResaleCoords();
  const idx = Math.min(sideIndex, 1);
  const partyCoords = (coords[side] && coords[side][idx]) || null;
  if (!partyCoords) return [];
  const out = [];
  for (const ini of partyCoords.initials) {
    out.push({
      name: `${roleName} Initials P${ini.page}`,
      type: 'initials',
      areas: [{ page: ini.page, x: ini.x, y: ini.y, w: ini.w, h: ini.h }],
    });
  }
  const sig = partyCoords.signature;
  out.push({
    name: `${roleName} Signature`,
    type: 'signature',
    areas: [{ page: sig.page, x: sig.x, y: sig.y, w: sig.w, h: sig.h }],
  });
  // Date widget directly below the signature line. Auto-populates on sign.
  // DocuSeal 'date' field with preferences.format renders as MM/DD/YYYY and
  // requires the signer to click once (auto-fills with today's date).
  out.push({
    name: `${roleName} Date`,
    type: 'date',
    preferences: { format: 'MM/DD/YYYY' },
    areas: [{
      page: sig.page,
      x: sig.x,
      y: Math.min(sig.y + sig.h + 0.005, 0.99),
      w: Math.min(sig.w * 0.5, 0.18),
      h: 0.022,
    }],
  });
  return out;
}

function buildResaleContractFieldMap(signers) {
  const buyerCounter = { i: 0 };
  const sellerCounter = { i: 0 };
  const fieldMap = {};
  let recognized = 0;
  for (const s of signers) {
    const role = s.role || 'Signer';
    const side = classifyRole(role);
    let sideIndex = 0;
    if (side === 'buyer') { sideIndex = buyerCounter.i++; recognized++; }
    else if (side === 'seller') { sideIndex = sellerCounter.i++; recognized++; }
    else if (side === 'agent') { sideIndex = 0; recognized++; }
    else { continue; }
    fieldMap[role] = buildResaleFieldsForSigner(role, side, sideIndex);
  }
  return recognized > 0 ? fieldMap : null;
}

function classifyRole(roleRaw) {
  const role = String(roleRaw || '').toLowerCase().trim();
  if (!role) return 'unknown';
  if (role === 'agent' || role.includes('agent') || role.includes('realtor')) return 'agent';
  if (role.startsWith('buyer') || role === 'co-buyer' || role === 'cobuyer' || role.startsWith('co-buyer')) return 'buyer';
  if (role.startsWith('seller') || role === 'co-seller' || role === 'coseller' || role.startsWith('co-seller')) return 'seller';
  return 'unknown';
}

// Map a Dossie signer to a template 4018208 submitter role name.
// Returns null if the signer does not belong on this template (e.g. Agent — the
// template has no Agent submitter, buyers sign, agent later signs on a separate flow).
function mapToTemplateRole(role, sideCounters) {
  const side = classifyRole(role);
  if (side === 'buyer') {
    const idx = sideCounters.buyer++;
    if (idx === 0) return 'Buyer 1';
    if (idx === 1) return 'Buyer 2';
    return null; // Only 2 buyer slots in the template.
  }
  if (side === 'seller') {
    const idx = sideCounters.seller++;
    if (idx === 0) return 'Seller 1';
    if (idx === 1) return 'Seller 2';
    return null;
  }
  // Agent, unknown: not part of the buyer-side resale template.
  return null;
}

// Build a values object (prefill for the template's named text/checkbox fields)
// from the transactions row + agent profile. Only sets fields where we have real
// data — DocuSeal leaves unset fields blank for the signer to fill in.
//
// 2026-07-05 ATLAS ROUND 8 — GOLD-2026-07-05-v12-esign-full-prefill
// Expanded from 27 fields to full coverage of every fill-form-populatable text
// field on template 4018208. See .tmp/tpl-4018208-fields-inventory.json for the
// authoritative 100-text-field list.
//
// Categories:
//   - populatable from tx:     ~30 fields (parties, price, financing, title,
//                              closing, HOA, notice addresses)
//   - populatable from profile: ~5 fields (buyer's-agent broker + associate)
//   - blank BY DESIGN:          rest (signer-fills, agent-supplies at run time,
//                              or no profile data — commission %, supervisor,
//                              broker office address / city / state / zip,
//                              team names, listing-agent slots when the tx has
//                              no listing_agent_* columns filled)
function buildResaleContractPrefill(tx, profile) {
  if (!tx) return {};
  const v = {};
  const P = profile || {};

  // ---- §1 PARTIES ----
  if (tx.buyer_name) v.buyer_name = tx.buyer_name;
  if (tx.seller_name) v.seller_name = tx.seller_name;

  // ---- §2 PROPERTY (address + address header on pages 2-11) ----
  if (tx.property_address) {
    v.property_address = tx.property_address;
    for (let p = 2; p <= 11; p++) v[`property_address_header_p${p}`] = tx.property_address;
  }
  if (tx.county) v.county = tx.county;
  if (tx.legal_description) v.Legal_Description = tx.legal_description;

  // ---- §3 SALES PRICE ----
  if (tx.sale_price != null) v.sales_price = String(tx.sale_price);
  if (tx.down_payment != null) v.down_payment = String(tx.down_payment);
  if (tx.loan_amount != null) v.loan_amount = String(tx.loan_amount);

  // ---- §5 EARNEST MONEY + OPTION FEE ----
  if (tx.earnest_money_amount != null) v.earnest_money_amount = String(tx.earnest_money_amount);
  else if (tx.earnest_money != null) v.earnest_money_amount = String(tx.earnest_money);
  if (tx.option_fee_amount != null) v.option_fee = String(tx.option_fee_amount);
  else if (tx.option_fee != null) v.option_fee = String(tx.option_fee);
  if (tx.option_days != null) v.option_period_days = String(tx.option_days);

  // ---- §6 TITLE / ESCROW ----
  if (tx.title_company) v.title_company_name = tx.title_company;
  if (tx.escrow_officer_name) v.escrow_agent_name = tx.escrow_officer_name;

  // ---- §9 CLOSING ----
  if (tx.closing_date) {
    v.closing_date = tx.closing_date;
    // Extract 4-digit closing_year from ISO date if the field expects it.
    // closing_date is typically "YYYY-MM-DD".
    const yr = String(tx.closing_date).match(/(\d{4})/);
    if (yr) v.closing_year = yr[1];
  }

  // ---- §21 NOTICE ADDRESSES ----
  if (tx.buyer_email) v.buyer_email = tx.buyer_email;
  if (tx.buyer_phone) v.buyer_phone = tx.buyer_phone;
  if (tx.seller_email) v.seller_email = tx.seller_email;
  if (tx.seller_phone) v.seller_phone = tx.seller_phone;
  if (tx.buyer_notice_name) v.buyer_notice_address = tx.buyer_notice_name;
  if (tx.seller_notice_name) v.seller_notice_address = tx.seller_notice_name;

  // ---- LISTING SIDE (§9 broker info block — top row on last page) ----
  // Sourced from transactions columns populated when Dossie learns the other
  // side's agent (parse from MLS, agent-supplied, or seller's-side counter).
  if (tx.listing_broker_name) v.listing_broker_firm = tx.listing_broker_name;
  if (tx.listing_broker_license_no) v.listing_broker_license = tx.listing_broker_license_no;
  if (tx.listing_agent_name) v.listing_agent_name = tx.listing_agent_name;
  if (tx.listing_agent_license_no) v.listing_agent_license = tx.listing_agent_license_no;
  if (tx.listing_agent_email_addr) v.listing_agent_email = tx.listing_agent_email_addr;
  if (tx.listing_agent_phone_no) v.listing_agent_phone = tx.listing_agent_phone_no;

  // ---- OTHER BROKER SIDE = Dossie agent (buyer's-agent side) ----
  // For a buyer-side deal (Dossie's default), the current agent's profile fills
  // the "Other Broker" slot. If the tx explicitly stores other_broker_* / other_agent_*
  // (e.g. Dossie's agent is the listing side and the buyer's agent info was
  // captured), prefer those.
  const otherBrokerFirm = tx.other_broker_name || P.brokerage || '';
  const otherBrokerLicense = tx.other_broker_license_no || '';
  const otherAgentName = tx.other_agent_name || P.full_name || '';
  const otherAgentLicense = tx.other_agent_license_no || P.license_number || '';
  const otherAgentEmail = tx.other_agent_email_addr || P.email || '';
  const otherAgentPhone = tx.other_agent_name ? '' : (P.phone || '');
  if (otherBrokerFirm) v.other_broker_firm = otherBrokerFirm;
  if (otherBrokerLicense) v.other_broker_license = otherBrokerLicense;
  if (otherAgentName) v.other_agent_name = otherAgentName;
  if (otherAgentLicense) v.other_agent_license = otherAgentLicense;
  if (otherAgentEmail) v.other_agent_email = otherAgentEmail;
  if (otherAgentPhone) v.other_agent_phone = otherAgentPhone;

  // ---- SELLING ASSOCIATE (§9 lower block on last page) ----
  // Same person as "Other Agent" when the buyer's-side agent is the selling
  // associate (typical). Populate the mirror set from the same source.
  if (otherAgentName) v.selling_associate_name = otherAgentName;
  if (otherAgentLicense) v.selling_associate_license = otherAgentLicense;
  if (otherAgentEmail) v.selling_associate_email = otherAgentEmail;
  if (otherAgentPhone) v.selling_associate_phone = otherAgentPhone;

  return v;
}

async function getTransactionRow(transactionId, userId) {
  const res = await supa(`transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,property_address,buyer_name,seller_name,sale_price,closing_date,city_state_zip`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Full transaction row for resale-contract prefill. select=* pulls every
// column so buildResaleContractPrefill can pick up county, legal_description,
// earnest_money, option_fee, title_company, closing_date, notice addresses,
// etc. without a schema-coupled column list.
async function getFullTransactionRow(transactionId, userId) {
  const res = await supa(`transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&select=*`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Fetch the agent's profile row for broker prefill (buyer's-agent slot).
async function getAgentProfile(userId) {
  const res = await supa(`profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,phone,email,brokerage,license_number,preferred_name&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function generateSignedUrl(storagePath, expiresIn = 300) {
  const url = `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${storagePath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw new Error(`Signed URL generation failed (${res.status})`);
  const json = await res.json();
  if (!json || !json.signedURL) throw new Error('No signedURL in storage response');
  const p = json.signedURL.startsWith('/') ? json.signedURL : `/${json.signedURL}`;
  return `${SUPABASE_URL}/storage/v1${p}`;
}

async function docusealCreateFromPdf({ documentUrl, fileName, signers, message, fields, fieldMap }) {
  // TODO: Replace stub with real call once DOCUSEAL_API_KEY is added to Vercel.
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-create] DOCUSEAL_API_KEY not set — returning stub submission.');
    return {
      id: `stub-${Date.now()}`,
      submitters: signers.map((s, i) => ({
        uuid: `stub-uuid-${i}`,
        slug: `stub-slug-${i}`,
        name: s.name,
        email: s.email,
        role: s.role || 'Signer',
        status: 'sent',
        embed_src: null,
      })),
    };
  }

  // 2026-06-27 ATLAS FIX: /submissions/pdf silently drops submitters past the first.
  // The reliable multi-signer path is:
  //   1. Download the PDF bytes (from signed URL)
  //   2. POST /templates/pdf to create a transient template w/ per-role fields
  //   3. POST /submissions with template_id + submitters[role,email,name]
  //
  // This matches the pattern used by sendForAcknowledgment() earlier in this file.

  // Step 1: Download the PDF bytes so we can base64-encode them for /templates/pdf.
  const pdfRes = await fetch(documentUrl);
  if (!pdfRes.ok) {
    throw new ValidationError(`Could not fetch document for signing (${pdfRes.status}).`, 502);
  }
  const pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
  const base64Pdf = pdfBuffer.toString('base64');

  // Step 2: Build the flattened fields array (top-level on document) with `role`
  // assigning ownership. /templates/pdf wants this shape:
  //   documents: [{name, file, fields: [{name, type, role, areas}]}]
  //   submitters: [{name: roleName}]   ← bare role names; emails come at submission time
  const allFields = [];
  for (const s of signers) {
    const role = s.role || 'Signer';
    const roleSpecificFields = fieldMap && fieldMap[role] ? fieldMap[role] : null;
    const signerFields = roleSpecificFields !== null
      ? roleSpecificFields
      : (Array.isArray(fields) ? fields.filter((f) => f.signerRole === role) : []);

    if (signerFields.length > 0) {
      for (const f of signerFields) {
        const built = {
          name: f.name,
          type: f.type,
          role,
          areas: (f.areas || []).map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h, page: a.page })),
        };
        if (f.preferences && typeof f.preferences === 'object') {
          built.preferences = f.preferences;
        }
        allFields.push(built);
      }
    } else {
      // Default: a signature + date field per submitter, DocuSeal auto-places them.
      allFields.push({ name: `${role} Signature`, type: 'signature', role });
      allFields.push({ name: `${role} Date`, type: 'date', role });
    }
  }

  // Submitters are just role placeholders at template time.
  const submitterPlaceholders = signers.map((s) => ({ name: s.role || 'Signer' }));

  // Step 3: Create a template from the PDF with multi-role fields.
  //
  // 2026-07-06 ATLAS — Suppressing DocuSeal's default post-sign emails
  // (documents_copy_email + completed_email) is NOT possible via the public
  // DocuSeal Cloud API. Both flags live on template.preferences, but the API's
  // strong-params whitelist rejects preferences at template creation and
  // silently drops them on PUT /templates/{id} (verified via GET after —
  // preferences stays {}). The only settable path is the session-authed
  // dashboard route POST /templates/{id}/preferences, which requires a
  // browser cookie we don't hold from a serverless function.
  //
  // Suppression is done ONE-TIME by Heath in the DocuSeal dashboard:
  // Settings → Emails → toggle OFF "Send document copies to signers" and
  // "Send completed notifications". Those account-level flags gate both
  // emails for the entire DocuSeal account.
  //
  // Regardless, api/esign-webhook.js sends a Dossie-branded completion
  // email with the signed PDF attached — so even before Heath flips the
  // dashboard toggle, customers receive our email; they may also receive
  // DocuSeal's until then.
  const tmplBody = {
    name: fileName || 'Document',
    documents: [
      {
        name: fileName || 'Document.pdf',
        file: `data:application/pdf;base64,${base64Pdf}`,
        fields: allFields,
      },
    ],
    submitters: submitterPlaceholders,
  };

  const tmplRes = await fetch(`${DOCUSEAL_BASE}/templates/pdf`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(tmplBody),
  });
  if (!tmplRes.ok) {
    const text = await tmplRes.text().catch(() => '');
    throw new ValidationError(`DocuSeal template creation failed (${tmplRes.status}): ${text.slice(0, 200)}`, 422);
  }
  const tmplData = await tmplRes.json();
  const templateId = tmplData.id;
  if (!templateId) {
    throw new ValidationError(`DocuSeal template missing id.`, 502);
  }

  // Step 4: Create the submission from the template. Map roles to submitter emails.
  const tmplSubmitters = (tmplData.submitters || []).map((tmplSub) => {
    // Match by role; fall back to position.
    const original = signers.find((s) => (s.role || 'Signer') === tmplSub.name) || null;
    return {
      role: tmplSub.name,
      name: original ? original.name : tmplSub.name,
      email: original ? original.email : null,
      send_email: false,
    };
  }).filter((s) => s.email);

  // If the template's submitter list didn't include all our signers (rare), fall
  // back to building submitters from our original `signers` list using the roles
  // that DocuSeal accepted.
  if (tmplSubmitters.length < signers.length) {
    const usedRoles = new Set(tmplSubmitters.map((s) => s.role));
    for (const s of signers) {
      if (!usedRoles.has(s.role || 'Signer')) {
        tmplSubmitters.push({
          role: s.role || 'Signer',
          name: s.name,
          email: s.email,
          send_email: false,
        });
      }
    }
  }

  // 2026-06-27 ATLAS FIX: DocuSeal requires message as {subject, body} object,
  // not a bare string. Wrap if caller passed a string.
  let messageObj = null;
  if (message) {
    if (typeof message === 'object' && (message.subject || message.body)) {
      messageObj = message;
    } else if (typeof message === 'string' && message.trim()) {
      messageObj = { subject: 'Please sign', body: message };
    }
  }

  const submBody = {
    template_id: templateId,
    send_email: false,
    submitters: tmplSubmitters,
    ...(messageObj ? { message: messageObj } : {}),
  };

  const submRes = await fetch(`${DOCUSEAL_BASE}/submissions`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submBody),
  });

  if (!submRes.ok) {
    const text = await submRes.text().catch(() => '');
    throw new ValidationError(`DocuSeal rejected the submission (${submRes.status}): ${text.slice(0, 200)}`, 422);
  }

  const submData = await submRes.json();
  // Response shape: array of submitter rows. Normalize to { id, submitters } shape
  // the rest of esign-create expects.
  if (Array.isArray(submData) && submData.length > 0) {
    return {
      id: submData[0].submission_id,
      submitters: submData,
    };
  }
  if (submData && submData.id) return submData;
  throw new ValidationError(`DocuSeal returned unexpected submission shape.`, 502);
}

// 2026-07-05 ATLAS ROUND 7 — GOLD-2026-07-05-v11-esign-prefill-fixed
//
// PREFILL STRATEGY (clone-per-submission)
// ---------------------------------------
// DocuSeal template 4018208 (and 4023463) has a rendering bug where passing
// `values` in submitters[] returns HTTP 500 whenever the value targets a field
// OWNED by that submitter (verified: any Buyer 1 field, e.g. buyer_name = 'X',
// sales_price = '525000', county = 'Bexar' — all 500). Values targeting fields
// owned by OTHER submitters silently succeed (they hit no field to write to).
//
// The only reliable prefill path is `default_value` set via PUT /templates/{id}.
// But defaults persist and are read LAZILY at signing-page render time — so a
// customer opening submission A after we changed defaults for B would see B's
// data. Solution: CLONE the template, set defaults on the CLONE, submit from
// the CLONE, delete the clone after use. Each customer envelope is isolated.
//
// Per-submission cost: 3 extra DocuSeal API calls (clone POST, PUT defaults,
// DELETE clone). All complete in <2s combined. No rate-limit concerns at
// current volume.
async function docusealCloneTemplateWithDefaults(templateId, defaults) {
  const cloneRes = await fetch(`${DOCUSEAL_BASE}/templates/${templateId}/clone`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: `TREC 20-18 Envelope ${Date.now()}` }),
  });
  if (!cloneRes.ok) {
    const text = await cloneRes.text().catch(() => '');
    throw new ValidationError(`DocuSeal template clone failed (${cloneRes.status}): ${text.slice(0, 200)}`, 502);
  }
  const cloneData = await cloneRes.json();
  const cloneId = cloneData.id;
  if (!cloneId) {
    throw new ValidationError(`DocuSeal template clone returned no id.`, 502);
  }

  // Set default_value on each field named in `defaults` that exists on the clone.
  // Fields not in `defaults` are left as-is (no default_value).
  const existingFields = Array.isArray(cloneData.fields) ? cloneData.fields : [];
  const patchedFields = existingFields.map((f) => {
    if (defaults[f.name] != null && defaults[f.name] !== '') {
      return { ...f, default_value: String(defaults[f.name]) };
    }
    return f;
  });
  const setCount = patchedFields.filter((f) => f.default_value != null && f.default_value !== '').length;

  const putRes = await fetch(`${DOCUSEAL_BASE}/templates/${cloneId}`, {
    method: 'PUT',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: patchedFields }),
  });
  if (!putRes.ok) {
    const text = await putRes.text().catch(() => '');
    // Best-effort delete clone before throwing
    fetch(`${DOCUSEAL_BASE}/templates/${cloneId}`, {
      method: 'DELETE',
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    }).catch(() => {});
    throw new ValidationError(`DocuSeal template defaults PUT failed (${putRes.status}): ${text.slice(0, 200)}`, 502);
  }

  console.log(`[esign-create] Cloned template ${templateId} -> ${cloneId}, applied ${setCount} default_value(s).`);
  return cloneId;
}

async function docusealDeleteTemplate(templateId) {
  try {
    const r = await fetch(`${DOCUSEAL_BASE}/templates/${templateId}`, {
      method: 'DELETE',
      headers: { 'X-Auth-Token': DOCUSEAL_API_KEY },
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.warn(`[esign-create] Clone delete failed for template ${templateId} (${r.status}): ${text.slice(0, 200)}`);
    } else {
      console.log(`[esign-create] Deleted clone template ${templateId}`);
    }
  } catch (err) {
    console.warn(`[esign-create] Clone delete threw for ${templateId}:`, err && err.message);
  }
}

async function docusealCreateFromTemplate({ templateId, signers, message, prefillData }) {
  // Creates a submission from a pre-built DocuSeal template (fields already placed).
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-create] DOCUSEAL_API_KEY not set — returning stub template submission.');
    return {
      id: `stub-tmpl-${Date.now()}`,
      submitters: signers.map((s, i) => ({
        uuid: `stub-uuid-tmpl-${i}`,
        slug: `stub-slug-tmpl-${i}`,
        name: s.name,
        email: s.email,
        role: s.role || 'Signer',
        status: 'sent',
        embed_src: null,
      })),
    };
  }

  // If we have prefill data, clone the template and apply defaults there.
  // The clone's ID is what we submit against. See long comment above for why.
  let submissionTemplateId = templateId;
  let cloneIdForCleanup = null;
  const hasPrefill = prefillData && Object.keys(prefillData).length > 0;
  if (hasPrefill) {
    submissionTemplateId = await docusealCloneTemplateWithDefaults(templateId, prefillData);
    cloneIdForCleanup = submissionTemplateId;
  }

  // Submitters carry NO `values` — prefill is via default_value on the clone.
  // Passing `values` here would trigger the same 500 bug we're working around.
  const submitters = signers.map((s) => ({
    name: s.name,
    email: s.email,
    role: s.role || 'Signer',
    // Suppress DocuSeal-native emails; Dossie sends Resend emails via
    // sendSigningEmail() in the calling handler.
    send_email: false,
  }));

  // Message shape: DocuSeal expects {subject, body} object, not a bare string.
  let messageObj = null;
  if (message) {
    if (typeof message === 'object' && (message.subject || message.body)) {
      messageObj = message;
    } else if (typeof message === 'string' && message.trim()) {
      messageObj = { subject: 'Please sign', body: message };
    }
  }

  const body = {
    template_id: submissionTemplateId,
    send_email: false,
    submitters,
    ...(messageObj ? { message: messageObj } : {}),
  };

  const res = await fetch(`${DOCUSEAL_BASE}/submissions`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Best-effort clean up the clone before surfacing the error
    if (cloneIdForCleanup) {
      docusealDeleteTemplate(cloneIdForCleanup).catch(() => {});
    }
    throw new ValidationError(`DocuSeal template submission failed (${res.status}): ${text.slice(0, 300)}`, 422);
  }

  const data = await res.json();

  // Fire-and-forget delete of the clone. The submission's signing page reads
  // fields from the clone template lazily, so we must NOT delete the clone
  // until the customer has finished signing. LEAVE THE CLONE.
  // (If we delete, the signing URL 404s.) The clone will be cleaned up when
  // the envelope completes via a future maintenance job.
  // TODO(atlas): add a cron to reap completed-envelope clones.

  // DocuSeal /submissions returns an ARRAY of submitter rows (one per signer),
  // each with a top-level `submission_id`. Normalize to { id, submitters } shape
  // the calling handler expects.
  if (Array.isArray(data) && data.length > 0) {
    return {
      id: data[0].submission_id,
      submitters: data,
    };
  }
  if (data && data.id) return data;
  throw new ValidationError('DocuSeal template submission returned unexpected shape.', 502);
}

async function sendSigningEmail({ signerName, signerEmail, documentName, propertyAddress, signingUrl }) {
  if (!RESEND_API_KEY) {
    console.warn('[esign-create] RESEND_API_KEY not set - skipping signing email.');
    return;
  }
  if (!signingUrl) {
    console.warn(`[esign-create] No signing URL for ${signerEmail} - skipping email.`);
    return;
  }

  const addressLine = propertyAddress ? ` for ${propertyAddress}` : '';
  const subject = `Action Required: Please sign ${documentName}${addressLine}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;max-width:600px;width:100%;">
        <tr><td style="background:#F5E6E0;padding:24px 32px;text-align:center;">
          <span style="font-family:'Georgia',serif;font-size:22px;font-weight:bold;color:#1A1A2E;letter-spacing:0.5px;">Dossie</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Hi ${signerName},</p>
          <p style="margin:0 0 16px;font-size:16px;color:#333;">Your agent has sent you a document to review and sign.</p>
          <p style="margin:0 0 8px;font-size:15px;color:#555;"><strong>Document:</strong> ${documentName}</p>
          ${propertyAddress ? `<p style="margin:0 0 24px;font-size:15px;color:#555;"><strong>Property:</strong> ${propertyAddress}</p>` : '<div style="margin-bottom:24px;"></div>'}
          <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
            <tr><td style="background:#E8836B;border-radius:6px;">
              <a href="${signingUrl}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;">Review &amp; Sign Document</a>
            </td></tr>
          </table>
          <p style="margin:0 0 24px;font-size:13px;color:#888;">If the button above doesn't work, copy and paste this link into your browser:<br><a href="${signingUrl}" style="color:#E8836B;word-break:break-all;">${signingUrl}</a></p>
          <hr style="border:none;border-top:1px solid #eee;margin:0 0 20px;">
          <p style="margin:0;font-size:13px;color:#aaa;">This document was prepared by Dossie, your agent's transaction management assistant.<br>Questions about this document? Contact your agent directly.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dossie <sign@meetdossie.com>',
      to: [signerEmail],
      subject,
      html,
      // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
    }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.error(`[esign-create] Resend error for ${signerEmail} (${r.status}): ${text.slice(0, 200)}`);
  } else {
    console.log(`[esign-create] Signing email sent to ${signerEmail}`);
  }
}

// ---------------------------------------------------------------------------
// sendForAcknowledgment — uploads scanned PDF to DocuSeal as a new template,
// then creates a submission with buyer acknowledgment fields at OP-H page 3.
// Supports 1 or 2 buyers.
// ---------------------------------------------------------------------------
async function sendForAcknowledgment({ doc, userId, transactionId, formType, buyerEmail, buyerName, buyerEmail2, buyerName2, message }) {
  if (!DOCUSEAL_API_KEY) {
    throw new ValidationError('DocuSeal not configured.', 500);
  }

  // Fetch file bytes from Supabase Storage
  const storageUrl = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${doc.storage_path}`;
  const fileRes = await fetch(storageUrl, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!fileRes.ok) {
    throw new Error(`Storage fetch failed (${fileRes.status}) for: ${doc.storage_path}`);
  }
  const fileBuffer = await fileRes.arrayBuffer();
  const base64Pdf = Buffer.from(fileBuffer).toString('base64');

  // Upload PDF to DocuSeal to create a temporary template
  // POST /templates/pdf with base64-encoded PDF
  const tmplBody = {
    name: doc.file_name || 'Seller Disclosure Notice',
    documents: [
      {
        name: doc.file_name || 'Sellers_Disclosure_Notice.pdf',
        file: `data:application/pdf;base64,${base64Pdf}`,
      },
    ],
  };

  const tmplRes = await fetch(`${DOCUSEAL_BASE}/templates/pdf`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(tmplBody),
  });

  if (!tmplRes.ok) {
    const text = await tmplRes.text().catch(() => '');
    throw new Error(`DocuSeal template creation failed (${tmplRes.status}): ${text.slice(0, 300)}`);
  }

  const tmplData = await tmplRes.json();
  const templateId = tmplData.id;
  if (!templateId) {
    throw new Error('DocuSeal template creation did not return an id.');
  }

  // Build buyer submitters.
  // Acknowledgment fields at OP-H page 3 (0-indexed page = 2 in DocuSeal areas).
  // Coordinates provided: signature at y~0.74, date at y~0.74 right side.
  // Second buyer optional.
  function buildBuyerFields(sigY, dateY) {
    return [
      {
        name: 'Buyer Signature',
        type: 'signature',
        areas: [{ page: 3, x: 0.07, y: sigY, w: 0.25, h: 0.04 }],
      },
      {
        name: 'Buyer Date',
        type: 'date',
        areas: [{ page: 3, x: 0.73, y: dateY, w: 0.18, h: 0.03 }],
      },
    ];
  }

  const submitters = [
    {
      name: buyerName,
      email: buyerEmail,
      role: 'Buyer 1',
      fields: buildBuyerFields(0.74, 0.74),
    },
  ];

  if (buyerEmail2 && buyerName2) {
    submitters.push({
      name: buyerName2,
      email: buyerEmail2,
      role: 'Buyer 2',
      fields: buildBuyerFields(0.82, 0.82),
    });
  }

  // Create submission from the uploaded template
  const submBody = {
    template_id: templateId,
    send_email: false,
    submitters,
    ...(message ? { message } : {}),
  };

  const submRes = await fetch(`${DOCUSEAL_BASE}/submissions`, {
    method: 'POST',
    headers: {
      'X-Auth-Token': DOCUSEAL_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submBody),
  });

  if (!submRes.ok) {
    const text = await submRes.text().catch(() => '');
    throw new Error(`DocuSeal submission creation failed (${submRes.status}): ${text.slice(0, 300)}`);
  }

  const submData = await submRes.json();
  const submissionId = String(submData.id || '');

  // Normalise submitters from DocuSeal response
  const signerRows = (Array.isArray(submData.submitters) ? submData.submitters : []).map((sub, i) => {
    const slug = sub.slug || null;
    const signingUrl = slug ? `https://docuseal.com/s/${slug}` : (sub.embed_src || null);
    return {
      name: sub.name || submitters[i]?.name || '',
      email: sub.email || submitters[i]?.email || '',
      role: sub.role || submitters[i]?.role || 'Buyer',
      status: sub.status || 'sent',
      signingUrl,
      uuid: sub.uuid || null,
    };
  });

  return { submissionId, signerRows, templateId };
}

async function insertSignatureRequest(row) {
  const res = await supa('signature_requests', {
    method: 'POST',
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`signature_requests insert failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
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
    console.error('[esign-create] Supabase not configured.');
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'esign-create', 20, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);

    const body = req.body || {};

    // action: 'send_for_acknowledgment' — scanned Seller's Disclosure → buyer signs
    const action = sanitizeString(body.action, { maxLength: 50 }) || null;
    if (action === 'send_for_acknowledgment') {
      const documentId = sanitizeString(body.document_id, { maxLength: 200 });
      const formType = sanitizeString(body.form_type, { maxLength: 100 }) || 'sellers_disclosure';
      const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 }) || null;
      const buyerEmail = sanitizeString(body.buyer_email, { maxLength: 200 });
      const buyerName = sanitizeString(body.buyer_name, { maxLength: 200 });
      const buyerEmail2 = sanitizeString(body.buyer_email_2, { maxLength: 200 }) || null;
      const buyerName2 = sanitizeString(body.buyer_name_2, { maxLength: 200 }) || null;
      const ackMessage = sanitizeString(body.message, { maxLength: 1000 }) || null;

      if (!documentId) throw new ValidationError('document_id is required for send_for_acknowledgment.');
      if (!buyerEmail || !buyerEmail.includes('@')) throw new ValidationError('buyer_email must be a valid email address.');
      if (!buyerName) throw new ValidationError('buyer_name is required.');
      if (buyerEmail2 && !buyerEmail2.includes('@')) throw new ValidationError('buyer_email_2 must be a valid email address.');
      if (buyerEmail2 && !buyerName2) throw new ValidationError('buyer_name_2 is required when buyer_email_2 is provided.');

      const doc = await getDocumentRow(documentId, userId);

      if (!doc.storage_path) {
        throw new ValidationError('Document has no storage path — cannot send for acknowledgment.', 422);
      }

      const { submissionId, signerRows, templateId: createdTemplateId } = await sendForAcknowledgment({
        doc,
        userId,
        transactionId: transactionId || doc.transaction_id || null,
        formType,
        buyerEmail,
        buyerName,
        buyerEmail2,
        buyerName2,
        message: ackMessage,
      });

      const txId = transactionId || doc.transaction_id || null;
      const tx = txId ? await getTransactionRow(txId, userId) : null;
      const propertyAddress = tx ? (tx.property_address || '') : '';

      // Send signing emails via Resend
      await Promise.all(
        signerRows.map((s) =>
          sendSigningEmail({
            signerName: s.name,
            signerEmail: s.email,
            documentName: doc.file_name || 'Seller\'s Disclosure Notice',
            propertyAddress,
            signingUrl: s.signingUrl,
          }).catch((err) => {
            console.error(`[esign-create] ack email failed for ${s.email}:`, err && err.message ? err.message : err);
          })
        )
      );

      const inserted = await insertSignatureRequest({
        user_id: userId,
        transaction_id: txId,
        document_id: documentId,
        docuseal_submission_id: submissionId,
        status: 'sent',
        signers: signerRows,
        message: ackMessage || null,
      });

      // Update documents row with DocuSeal submission ID for tracking
      if (submissionId) {
        await supa(
          `documents?id=eq.${encodeURIComponent(documentId)}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ docuseal_submission_id: submissionId }),
            headers: { Prefer: 'return=minimal' },
          }
        ).catch((e) => {
          console.warn('[esign-create] documents patch for submission_id failed:', e && e.message ? e.message : e);
        });
      }

      return res.status(200).json({
        ok: true,
        submissionId,
        signatureRequestId: inserted?.id || null,
        signers: signerRows,
        docusealTemplateId: createdTemplateId,
      });
    }

    const documentId = sanitizeString(body.documentId, { maxLength: 200 });
    const templateId = sanitizeString(body.templateId, { maxLength: 200 }) || null;
    const message = sanitizeString(body.message, { maxLength: 1000 }) || null;
    const signers = Array.isArray(body.signers) ? body.signers : [];
    const fields = Array.isArray(body.fields) ? body.fields : null;
    // Phase 3: pre-fill data for template submissions
    const prefillData = (body.prefillData && typeof body.prefillData === 'object') ? body.prefillData : null;

    // Agent-as-final-signer fields
    const agentSignerEmail = sanitizeString(body.agentSignerEmail, { maxLength: 200 }) || null;
    const agentSignerName = sanitizeString(body.agentSignerName, { maxLength: 200 }) || 'Agent';

    // Seller's agent fields (stored on the signature_requests row; used by webhook on completion)
    const sellerAgentName = sanitizeString(body.sellerAgentName, { maxLength: 200 }) || null;
    const sellerAgentEmail = sanitizeString(body.sellerAgentEmail, { maxLength: 200 }) || null;

    if (!documentId) {
      throw new ValidationError('documentId is required.');
    }
    if (signers.length === 0) {
      throw new ValidationError('At least one signer is required.');
    }
    for (const s of signers) {
      if (!s.name || typeof s.name !== 'string' || !s.name.trim()) {
        throw new ValidationError('Each signer must have a name.');
      }
      if (!s.email || typeof s.email !== 'string' || !s.email.includes('@')) {
        throw new ValidationError(`Signer "${s.name}" must have a valid email address.`);
      }
    }
    if (agentSignerEmail && !agentSignerEmail.includes('@')) {
      throw new ValidationError('agentSignerEmail must be a valid email address.');
    }
    if (sellerAgentEmail && !sellerAgentEmail.includes('@')) {
      throw new ValidationError('sellerAgentEmail must be a valid email address.');
    }

    // Fetch the document (verifies ownership).
    const doc = await getDocumentRow(documentId, userId);
    const fileName = doc.file_name || 'Document.pdf';
    const transactionId = doc.transaction_id || null;

    // Fetch the transaction so we have property_address for both email subjects
    // and template prefill. Non-fatal if missing.
    // Full-column select so buildResaleContractPrefill can access all resale fields.
    const tx = transactionId ? await getFullTransactionRow(transactionId, userId) : null;
    const propertyAddress = tx ? (tx.property_address || '') : '';

    // Build the full ordered signers list.
    // If agentSignerEmail is provided, append the agent as the last signer so
    // DocuSeal routes sequentially: buyers first, then agent.
    const allSigners = agentSignerEmail
      ? [
          ...signers,
          { name: agentSignerName, email: agentSignerEmail, role: 'Agent' },
        ]
      : signers;

    let submissionResult;

    // 2026-07-05 ATLAS ROUND 13 — GOLD-2026-07-05-v13-signer-only-widgets
    //
    // Resale contracts NO LONGER route through template 4018208 (Path B rollback).
    // Rationale: the template-based path forces prefill to render as pink editable
    // widgets on the DocuSeal signing page. Buyers can accidentally erase contract
    // terms. Heath's requirement: contract text baked into PDF, only signer
    // widgets (initial + signature + date) interactive.
    //
    // New flow for resale_contract documents:
    //   1. fill-form.js has already baked all contract text into the PDF via
    //      pdf-lib and uploaded it to Supabase Storage (doc.storage_path).
    //   2. esign-create downloads that filled PDF, POSTs to /templates/pdf
    //      with ONLY signer widgets — initials 8x per party + signature + date.
    //   3. DocuSeal renders the PDF text as static content (baked, unchangeable)
    //      and only shows the signer-only widgets as interactive pink boxes.
    //
    // The old template-clone-with-defaults path (`docusealCreateFromTemplate`)
    // remains available for any explicit `templateId` passed in the request body,
    // but the resale-contract default route no longer sets one.
    //
    // Widget coordinates: api/_assets/trec-20-18-esign-coords.json (built from
    // AcroForm widget rectangles in trec-20-18-raw.pdf, atlas26 round).
    let effectiveTemplateId = templateId;
    // NOTE: intentionally NOT setting effectiveTemplateId for resale_contract.

    if (effectiveTemplateId) {
      // Phase 3 path — template-based submission with optional pre-fill.
      // Build resale-specific prefill (full field map) if we have a transaction
      // and this is the resale template; otherwise fall back to the earlier
      // generic prefill from tx.
      let prefill = prefillData || {};
      if (tx) {
        if (Number(effectiveTemplateId) === RESALE_TEMPLATE_ID) {
          const agentProfile = await getAgentProfile(userId).catch(() => null);
          prefill = { ...buildResaleContractPrefill(tx, agentProfile), ...prefill };
        } else {
          prefill = {
            property_address: tx.property_address || '',
            buyer_name: tx.buyer_name || '',
            seller_name: tx.seller_name || '',
            purchase_price: tx.sale_price ? String(tx.sale_price) : '',
            closing_date: tx.closing_date || '',
            ...prefill,
          };
        }
      }
      const prefillKeys = Object.keys(prefill).filter((k) => prefill[k] != null && prefill[k] !== '');
      console.log(`[esign-create] v12 template ${effectiveTemplateId} with ${prefillKeys.length} prefill field(s): ${prefillKeys.slice(0, 8).join(', ')}${prefillKeys.length > 8 ? '...' : ''}`);
      submissionResult = await docusealCreateFromTemplate({ templateId: effectiveTemplateId, signers: allSigners, message, prefillData: prefill });
    } else {
      // resale_contract (and other non-template PDFs like Seller's Disclosure
      // ack, addendums, etc.) go through /templates/pdf with signer-only widgets.
      // The PDF text is baked in by fill-form.js; only initial/signature/date
      // widgets are added on top.
      const signedUrl = await generateSignedUrl(doc.storage_path, 300);

      let autoFieldMap = null;
      if (!fields && doc.document_type === 'resale_contract') {
        autoFieldMap = buildResaleContractFieldMap(allSigners);
        if (autoFieldMap) {
          const total = Object.values(autoFieldMap).reduce((acc, arr) => acc + arr.length, 0);
          console.log(`[esign-create] v13 resale_contract signer-only widgets built for ${Object.keys(autoFieldMap).length} signer(s), ${total} widgets total.`);
          // Log actual widget coordinates for APV verification.
          for (const [role, roleFields] of Object.entries(autoFieldMap)) {
            for (const f of roleFields) {
              const a = (f.areas && f.areas[0]) || {};
              console.log(`[esign-create]   ${role} ${f.type} "${f.name}" p${a.page}: x=${a.x} y=${a.y} w=${a.w} h=${a.h}`);
            }
          }
        }
      }

      submissionResult = await docusealCreateFromPdf({
        documentUrl: signedUrl,
        fileName,
        signers: allSigners,
        message,
        fields,
        fieldMap: autoFieldMap,
      });
    }

    const submissionId = String(submissionResult.id || '');

    // Normalise signer list from DocuSeal response.
    // allSigners is the source of truth for name/email/role if DocuSeal omits them.
    // Signing URL: prefer slug-based public link (https://docuseal.com/s/{slug}) over embed_src.
    const signerRows = (Array.isArray(submissionResult.submitters) ? submissionResult.submitters : []).map((sub, i) => {
      const slug = sub.slug || null;
      const signingUrl = slug
        ? `https://docuseal.com/s/${slug}`
        : (sub.embed_src || null);
      return {
        name: sub.name || allSigners[i]?.name || '',
        email: sub.email || allSigners[i]?.email || '',
        role: sub.role || allSigners[i]?.role || 'Signer',
        status: sub.status || 'sent',
        signingUrl,
        uuid: sub.uuid || null,
      };
    });

    // Send Dossie-branded signing emails via Resend.
    // Fire-and-forget per signer — a single email failure must not abort the submission.
    // Skip the agent signer (agentSignerEmail) — only external signers get notified here.
    await Promise.all(
      signerRows
        .filter((s) => s.email && s.email !== agentSignerEmail)
        .map((s) =>
          sendSigningEmail({
            signerName: s.name,
            signerEmail: s.email,
            documentName: fileName,
            propertyAddress,
            signingUrl: s.signingUrl,
          }).catch((err) => {
            console.error(`[esign-create] sendSigningEmail failed for ${s.email}:`, err && err.message ? err.message : err);
          })
        )
    );

    // Persist the signature request.
    // seller_agent_name / seller_agent_email are stored here so the webhook can
    // send the executed PDF to the seller's agent when all parties have signed.
    const inserted = await insertSignatureRequest({
      user_id: userId,
      transaction_id: transactionId,
      document_id: documentId,
      docuseal_submission_id: submissionId,
      status: 'sent',
      signers: signerRows,
      message: message || null,
      ...(sellerAgentName ? { seller_agent_name: sellerAgentName } : {}),
      ...(sellerAgentEmail ? { seller_agent_email: sellerAgentEmail } : {}),
    });

    return res.status(200).json({
      ok: true,
      submissionId,
      signatureRequestId: inserted?.id || null,
      signers: signerRows,
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
    console.error('[esign-create] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not send document for signature. Try again.' });
  }
};

