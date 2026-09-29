// Vercel Serverless Function: /api/esign-create
// POST { documentId, signers: [{name, email, role}], message?, fields?, templateId? }
// POST { documentIds: [uuid], signers: [{name, email, role}], message? }   (packet form)
// Authorization: Bearer <supabase user JWT>
//
// Sends a PDF for e-signature via DocuSeal Cloud Pro.
// If templateId is provided, creates a submission from a template (Phase 3).
// If fields are provided, field placement coordinates are sent to DocuSeal (Phase 2).
//
// 2026-09-01 CARTER — `documentIds` (array) accepted alongside legacy
// `documentId`. This is the contract the DossieSign FormEditor Send button
// posts (docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md §2.2/§2.3).
//
// 2026-09-08 CARTER — multi-document packets are LIVE (Phase 3 of the plan).
// `documentIds: [uuid, ...]` in the member's chosen order builds ONE DocuSeal
// submission from ONE transient template carrying every PDF as its own
// document (`documents: []` on POST /templates/pdf — verified live 2026-09-08:
// fields bind per-document via attachment_uuid, areas[].page stays LOCAL and
// 1-indexed per document, roles are shared across documents). One envelope,
// one signing session, one email per signer — the zipForm
// "Add a Document or Form → My Transaction" mental model.
// Documents with no field map (e.g. an MLS-pulled seller's disclosure upload)
// ride in a packet via caller-placed `fields` entries carrying `documentId`.
// The 422 placement gate fires on EVERY document in the packet — a packet is
// only as valid as its worst document.
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

const crypto = require('crypto');
const { sanitizeString, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOCUSEAL_API_KEY = process.env.DOCUSEAL_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DOCUSEAL_BASE = 'https://api.docuseal.com';
const BUCKET = 'documents';

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
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
  const res = await supa(`documents?id=eq.${encodeURIComponent(documentId)}&user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,transaction_id,storage_path,file_name,document_type,form_type,status,form_template_id`);
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

// 2026-07-12 ATLAS — Simple Send fix for blank form_template documents.
// 2026-07-13 CARTER — resolver extracted to api/_lib/resolve-blank-template-pdf.js
// so documents.js, detect-form-type.js, send-compliance-packet.js, and
// interactive-editor-init.js can share the same code path. Single source of
// truth for the SHORT_NAME → FORM_B64 map.
//
// See _lib/resolve-blank-template-pdf.js for background.
const {
  resolveBlankTemplatePdf: resolveBlankTemplatePdfDoc,
  BLANK_SEND_SAFE_SLUGS,
} = require('./_lib/resolve-blank-template-pdf');

// Legacy wrapper preserving the (formTemplateId) → Buffer contract used
// elsewhere in this file. New callers should use resolveBlankTemplatePdfDoc
// from the shared lib directly.
async function resolveBlankTemplatePdf(formTemplateId) {
  if (!formTemplateId) return null;
  const resolved = await resolveBlankTemplatePdfDoc({
    form_template_id: formTemplateId,
    document_type: 'form_template',
    status: 'blank',
  });
  return resolved ? resolved.buffer : null;
}

// TREC 20-19 (One to Four Family Residential Contract — Resale) routing.
//
// 2026-07-05 ATLAS ROUND 6 — GOLD-2026-07-05-v11-esign-coords-from-acroform
// v10 (template 4018208, TREC 20-18) shipped with widgets in the wrong
// position — Heath's phone screenshots showed sig widgets floating in the
// left margin on page 9 and initial widgets ABOVE the "Initialed for
// identification" line on page 8. The template's widget positions in
// DocuSeal Studio are broken.
//
// v11 approach (Path B): BYPASS the broken template. Build a fresh transient
// template from the raw PDF on every send, placing signature/initial widgets
// at coordinates extracted DIRECTLY from the source PDF's AcroForm widgets.
//
// 2026-08-31 CARTER — TREC 20-18 was superseded 2026-07-01. The coord map
// above was built from 20-18 (9 pages, 8 initial pages + page-9 signature)
// and was being applied unchanged to the 12-page 20-19 document (10 initial
// pages: 1-9 and 12; signature block on page 10) — at least 2 pages of
// required initials were never placed on every 20-19 sent. Replaced with
// api/_assets/trec-20-19-esign-coords.json, extracted directly from
// .tmp/ridgebluff-offer/blank-20-19.pdf's own AcroForm widget rects (see
// that file's "description"/"method" fields for the full derivation).
//
// DocuSeal areas[].page indexing — settled empirically 2026-08-31: built a
// throwaway 4-page probe PDF with visible "PHYSICAL PAGE N" labels, created a
// DocuSeal template via POST /templates/pdf with a field at areas[].page=2,
// opened the real signing URL in a real (Playwright) browser, and read the
// DOM: the field rendered inside page-container index 1 (0-indexed DOM
// wrapper id `page-<uuid>-1`), i.e. the physical 2nd page. So on CREATE,
// areas[].page is 1-INDEXED = the literal PDF page number. (GET responses
// echo the same area back as `page - 1` — a separate, 0-indexed
// *read* representation that does not affect what you send. This is the
// source of the old contradictory comment near the OP-H fields below:
// "0-indexed page = 2" was describing the GET echo, not the input value.)
// Template + submission created for the probe were archived immediately
// after; no lasting DocuSeal account state.
//
// RESALE_TEMPLATE_ID (4018208) is kept as a legacy id in case a caller still
// passes it explicitly, but the resale-contract default path no longer touches it.
const RESALE_TEMPLATE_ID = 4018208;

// Load AcroForm-derived signing widget coordinates for TREC 20-19.
// Structure: RESALE_COORDS[side][index] = { initials: [{page,x,y,w,h}...], signature: {page,x,y,w,h} }
// side: 'buyer' | 'seller'; index: 0 (first party) or 1 (co-party).
// y is TOP-origin (0=top, 1=bottom of page). DocuSeal uses top-origin per
// its area.vue: `top: y * 100 + '%'`. page is 1-indexed (see note above).
const _path = require('path');
const _fs = require('fs');
let RESALE_COORDS_CACHE = null;
function loadResaleCoords() {
  if (RESALE_COORDS_CACHE) return RESALE_COORDS_CACHE;
  try {
    const p = _path.join(__dirname, '_assets', 'trec-20-19-esign-coords.json');
    RESALE_COORDS_CACHE = JSON.parse(_fs.readFileSync(p, 'utf8'));
    console.log(`[esign-create] Loaded TREC 20-19 esign coord map from ${p}`);
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
    console.error('[esign-create] Failed to load TREC 20-19 coord map:', err && err.message);
    RESALE_COORDS_CACHE = { buyer: [], seller: [] };
  }
  return RESALE_COORDS_CACHE;
}

// 2026-09-08 CARTER — the resale (TREC 20-19) path now runs through the SAME
// assignment + gate implementation as the 23 generically-mapped forms
// (buildMappedFieldMap + assertPlausibleMappedFieldCount below). This adapter
// converts trec-20-19-esign-coords.json into the standard formEntry shape so
// there is exactly ONE place that assigns signers to printed lines and ONE
// gate. It replaces buildResaleContractFieldMap/assertPlausibleResaleFieldCount,
// which had two render-confirmed defects:
//   1. `Math.min(sideIndex, 1)` silently gave a 3rd buyer the IDENTICAL
//      signature rect as buyer 2 — two different people wired to sign the
//      same printed line. The 20-19 has exactly two printed signature lines
//      and two footer-initial blanks per side; a 3rd principal per side
//      cannot be represented and now 422s loudly (buildMappedFieldMap's
//      slot-exhaustion check) instead of collapsing.
//   2. assertPlausibleResaleFieldCount only compared a TOTAL count, so the
//      collapse (and a signer with no signature at all) passed the gate.
// The date widget sits directly below the signature line; DocuSeal 'date'
// with preferences.format auto-fills MM/DD/YYYY on sign.
// Agent placement (page 10, below the principals' block) is intentionally
// whitespace — the 20-19 prints no broker signature line anywhere (page 11
// is "Print name(s) only. Do not sign.") — and is preserved unchanged from
// the pre-convergence behavior.
let RESALE_FORM_ENTRY_CACHE = null;
function resaleFormEntry() {
  if (RESALE_FORM_ENTRY_CACHE) return RESALE_FORM_ENTRY_CACHE;
  const coords = loadResaleCoords();
  const roles = {};
  const expected = {};
  for (const side of ['buyer', 'seller']) {
    (coords[side] || []).forEach((party, i) => {
      const label = side === 'buyer' ? `Buyer ${i + 1}` : `Seller ${i + 1}`;
      const fields = party.initials.map((ini) => ({
        title: `${label} Initials P${ini.page}`,
        type: 'initials',
        areas: [{ page: ini.page, x: ini.x, y: ini.y, w: ini.w, h: ini.h }],
      }));
      const sig = party.signature;
      fields.push({
        title: `${label} Signature`,
        type: 'signature',
        areas: [{ page: sig.page, x: sig.x, y: sig.y, w: sig.w, h: sig.h }],
      });
      fields.push({
        title: `${label} Date`,
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
      roles[`${side}${i + 1}`] = fields;
      expected[`${side}${i + 1}`] = fields.length;
    });
  }
  // Sending agent (buyer-side flow): signature + auto-date on page 10.
  roles.buyer_agent = [
    { title: 'Agent Signature', type: 'signature',
      areas: [{ page: 10, x: 0.05, y: 0.75, w: 0.35, h: 0.035 }] },
    { title: 'Agent Date', type: 'date',
      preferences: { format: 'MM/DD/YYYY' },
      areas: [{ page: 10, x: 0.42, y: 0.75, w: 0.18, h: 0.035 }] },
  ];
  RESALE_FORM_ENTRY_CACHE = {
    form_type: 'resale_contract',
    trec_no: '20-19',
    roles,
    expected_field_count_per_role: expected,
  };
  return RESALE_FORM_ENTRY_CACHE;
}

// ---------------------------------------------------------------------------
// 2026-09-08 CARTER — generic per-form signing-widget maps (Phase 2 of
// docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md).
//
// api/_assets/esign-field-maps.json is GENERATED by
// scripts/build-esign-field-maps.js from the checked-in semantic role maps
// (scripts/esign-role-maps/*.json). Every widget's placement was verified by
// rendering the page and looking at where the box lands relative to the
// printed line — never trusted from AcroForm field names (see memory:
// acroform-field-names-lie). Coordinates are top-left-origin fractions 0-1;
// areas[].page is 1-indexed (DocuSeal write convention, settled 2026-08-31).
//
// This replaces the old fallback for every non-resale mapped form, which
// auto-placed ONE signature + date per signer with zero initials — the exact
// 2026-08-30 Ridge Bluff failure class. resale_contract keeps its dedicated
// trec-20-19-esign-coords.json path above.
//
// The maps' blank_pdf_sha256 pins each map to the blank asset it was measured
// against; scripts/regression-esign-field-maps.js re-verifies the pin against
// the live assets on every QA run, so a form-revision commit that swaps a PDF
// without regenerating the maps fails loudly instead of running stale
// geometry (how 20-18 coords ran on the 12-page 20-19 for weeks).
// ---------------------------------------------------------------------------
let ESIGN_FIELD_MAPS_CACHE = null;
function loadEsignFieldMaps() {
  if (ESIGN_FIELD_MAPS_CACHE) return ESIGN_FIELD_MAPS_CACHE;
  try {
    const p = _path.join(__dirname, '_assets', 'esign-field-maps.json');
    ESIGN_FIELD_MAPS_CACHE = JSON.parse(_fs.readFileSync(p, 'utf8'));
    console.log(`[esign-create] Loaded esign field maps: ${Object.keys(ESIGN_FIELD_MAPS_CACHE.forms || {}).length} forms.`);
  } catch (err) {
    console.error('[esign-create] Failed to load esign-field-maps.json:', err && err.message);
    ESIGN_FIELD_MAPS_CACHE = { forms: {}, document_type_index: {} };
  }
  return ESIGN_FIELD_MAPS_CACHE;
}

// Resolve the field map for a documents row. Preview docs written by
// dossiesign-prepare carry document_type='filled_form' + form_type=<slug>;
// docs written by fill-form carry the per-form document_type.
function resolveEsignFieldMapForDoc(doc) {
  const maps = loadEsignFieldMaps();
  if (doc.form_type && maps.forms[doc.form_type]) return maps.forms[doc.form_type];
  const slug = maps.document_type_index[doc.document_type];
  return slug ? maps.forms[slug] : null;
}

// Order in which request signers claim a side's semantic slots.
const SIDE_TO_SEMANTIC_ROLES = {
  buyer: ['buyer1', 'buyer2'],
  seller: ['seller1', 'seller2'],
};

// Build the per-signer field map for a mapped form and ENFORCE the packet
// completeness rules from the e-sign playbook: every principal signer gets
// their form's full widget set (signature + every initials line), each
// signer's set is distinct (no shared/cross-assigned widgets), and a signer
// the form has no line for fails loudly instead of getting a floating tag.
// Throws ValidationError(422) — the caller must not reach DocuSeal when this
// throws.
function buildMappedFieldMap(formEntry, signers) {
  const fieldMap = {};
  const counters = { buyer: 0, seller: 0 };
  const seenRoles = new Set();
  const summary = [];

  for (const s of signers) {
    const roleName = s.role || 'Signer';
    if (seenRoles.has(roleName)) {
      throw new ValidationError(
        `Two signers share the role "${roleName}" — each signer needs a distinct role so their `
        + `signature fields cannot be cross-assigned. Refusing to send.`, 422,
      );
    }
    seenRoles.add(roleName);
    const side = classifyRole(roleName);

    if (side === 'buyer' || side === 'seller') {
      const slots = SIDE_TO_SEMANTIC_ROLES[side];
      const idx = counters[side]++;
      if (idx >= slots.length || !formEntry.roles[slots[idx]]) {
        throw new ValidationError(
          `${formEntry.form_type} (TREC ${formEntry.trec_no || '?'}) has signature lines for `
          + `${slots.filter((r) => formEntry.roles[r]).length} ${side}(s), but this request names more. `
          + `A signer without their own printed line cannot be placed correctly — refusing to send.`, 422,
        );
      }
      const semantic = slots[idx];
      fieldMap[roleName] = formEntry.roles[semantic].map((f) => ({
        name: `${roleName} ${f.title.replace(/^(Buyer|Seller) \d+ /, '')}`,
        type: f.type,
        ...(f.preferences ? { preferences: f.preferences } : {}),
        areas: f.areas,
      }));
      summary.push(`${roleName} -> ${semantic} (${fieldMap[roleName].length} widgets)`);
    } else if (side === 'agent') {
      // Only the OP-L lead-paint addendum has printed broker signature lines.
      // The sending agent takes the buyer_agent line (buyer-side send flow);
      // fall back to listing_agent if that's all the form has. Forms with no
      // agent line at all: leave the agent out of the map — the legacy
      // auto-placed signature+date fallback applies (unchanged behavior,
      // logged loudly below).
      const agentSemantic = formEntry.roles.buyer_agent ? 'buyer_agent'
        : (formEntry.roles.listing_agent ? 'listing_agent' : null);
      if (agentSemantic) {
        fieldMap[roleName] = formEntry.roles[agentSemantic].map((f) => ({
          name: `${roleName} ${f.type === 'signature' ? 'Signature' : 'Date'}`,
          type: f.type,
          ...(f.preferences ? { preferences: f.preferences } : {}),
          areas: f.areas,
        }));
        summary.push(`${roleName} -> ${agentSemantic} (${fieldMap[roleName].length} widgets)`);
      } else {
        console.warn(`[esign-create] ${formEntry.form_type}: no printed agent line — signer "${roleName}" `
          + `falls back to auto-placed signature/date (legacy behavior; review whether the agent `
          + `belongs on this form at all).`);
      }
    } else {
      throw new ValidationError(
        `Signer role "${roleName}" is not recognizable as buyer, seller, or agent — cannot `
        + `assign signature fields safely. Refusing to send.`, 422,
      );
    }
  }
  return { fieldMap, summary };
}

// Generalized field-count gate (extends the resale-only
// assertPlausibleResaleFieldCount to every mapped form). Recomputes the
// expected widget total from the SAME map entry used to build the fields —
// a mismatch means assignment logic dropped something. Throws 422.
function assertPlausibleMappedFieldCount(formEntry, fieldMap, signers) {
  const counters = { buyer: 0, seller: 0 };
  let expected = 0;
  let principals = 0;
  for (const s of signers) {
    const side = classifyRole(s.role || 'Signer');
    if (side === 'buyer' || side === 'seller') {
      const semantic = SIDE_TO_SEMANTIC_ROLES[side][counters[side]++];
      expected += (formEntry.expected_field_count_per_role[semantic] || 0);
      principals += 1;
      const built = fieldMap[s.role || 'Signer'] || [];
      if (!built.some((f) => f.type === 'signature')) {
        throw new ValidationError(
          `Field placement check failed on ${formEntry.form_type}: signer "${s.role}" has no `
          + `signature widget. Refusing to send an unsignable packet.`, 422,
        );
      }
    }
  }
  const actual = Object.entries(fieldMap)
    .filter(([role]) => ['buyer', 'seller'].includes(classifyRole(role)))
    .reduce((acc, [, arr]) => acc + arr.length, 0);
  if (principals > 0 && actual !== expected) {
    throw new ValidationError(
      `Field placement check failed on ${formEntry.form_type}: expected ${expected} `
      + `signature/initial/date widgets for this signer set but built ${actual}. Refusing to `
      + `send — this is the failure mode that has previously sent contracts with missing `
      + `initials. Contact support before retrying.`, 422,
    );
  }
}

// ---------------------------------------------------------------------------
// 2026-09-08 CARTER — multi-document packet machinery (Phase 3).
// A packet = one contract + its addenda (+ arbitrary uploaded PDFs with
// caller-placed fields) sent as ONE DocuSeal submission. Field maps, the
// buildMappedFieldMap assignment, and both 422 gates run PER DOCUMENT — the
// generalized gate fires on every document, not just the first.
// ---------------------------------------------------------------------------
const MAX_PACKET_DOCUMENTS = 10;
const CUSTOM_FIELD_TYPES = new Set(['signature', 'initials', 'date', 'text', 'checkbox']);

// Resolve the PDF bytes for a packet document. Mirrors the single-document
// path exactly: blank form_template placeholders resolve from base64 assets
// (gated to BLANK_SEND_SAFE_SLUGS — an unfilled contract can never ride in a
// packet), everything else comes from Supabase Storage.
async function resolvePdfBufferForDoc(doc) {
  const isBlankTemplate = doc.document_type === 'form_template' && doc.status === 'blank';
  if (isBlankTemplate && doc.form_template_id) {
    const resolved = await resolveBlankTemplatePdfDoc(doc);
    if (!resolved) {
      throw new ValidationError(`"${doc.file_name}": this form template PDF is not available. Please contact support.`, 422);
    }
    if (!BLANK_SEND_SAFE_SLUGS.has(resolved.slug)) {
      throw new ValidationError(
        `"${doc.file_name}" has not been filled in yet. Open it from the dossier and complete the `
        + `required fields before adding it to a signing packet.`, 409,
      );
    }
    return resolved.buffer;
  }
  if (!doc.storage_path) {
    throw new ValidationError(`"${doc.file_name}" has no stored PDF — cannot send it for signature.`, 422);
  }
  const signedUrl = await generateSignedUrl(doc.storage_path, 300);
  const pdfRes = await fetch(signedUrl);
  if (!pdfRes.ok) {
    throw new ValidationError(`Could not fetch "${doc.file_name}" for signing (${pdfRes.status}).`, 502);
  }
  return Buffer.from(await pdfRes.arrayBuffer());
}

// Gate for documents with NO field map (the MLS-pulled seller's-disclosure
// upload case): the member must have placed fields on it themselves, and
// those placements must be well-formed. Throws 422 — the caller must not
// reach DocuSeal when this throws.
function validateCustomFieldsForDoc(doc, docFields, allSigners) {
  const roleSet = new Set(allSigners.map((s) => s.role || 'Signer'));
  if (docFields.length === 0) {
    throw new ValidationError(
      `"${doc.file_name}" has no signature field map and no placed fields. Open it and place at `
      + `least one signature field for each signer before adding it to a packet.`, 422,
    );
  }
  let hasSignatureOrInitials = false;
  for (const f of docFields) {
    if (!f || typeof f.name !== 'string' || !f.name.trim() || !CUSTOM_FIELD_TYPES.has(f.type)) {
      throw new ValidationError(`"${doc.file_name}": a placed field is malformed (name/type). Refusing to send.`, 422);
    }
    if (!roleSet.has(f.signerRole)) {
      throw new ValidationError(
        `"${doc.file_name}": field "${f.name}" targets role "${f.signerRole}", which is not one of `
        + `this packet's signers. Refusing to send.`, 422,
      );
    }
    const areas = Array.isArray(f.areas) ? f.areas : [];
    if (areas.length === 0) {
      throw new ValidationError(`"${doc.file_name}": field "${f.name}" has no placement area. Refusing to send.`, 422);
    }
    for (const a of areas) {
      const numsOk = [a.x, a.y, a.w, a.h].every((n) => typeof n === 'number' && Number.isFinite(n));
      const ok = a && Number.isInteger(a.page) && a.page >= 1 && numsOk
        && a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1
        && a.w > 0 && a.w <= 1 && a.h > 0 && a.h <= 1;
      if (!ok) {
        throw new ValidationError(
          `"${doc.file_name}": field "${f.name}" has an invalid placement area (page must be a `
          + `1-indexed integer, x/y/w/h fractions 0-1). Refusing to send.`, 422,
        );
      }
    }
    if (f.type === 'signature' || f.type === 'initials') hasSignatureOrInitials = true;
  }
  if (!hasSignatureOrInitials) {
    throw new ValidationError(
      `"${doc.file_name}": place at least one signature or initials field on it. Refusing to send `
      + `a document nobody can sign.`, 422,
    );
  }
}

// Build the flattened DocuSeal field list for one packet document.
// Mapped forms (the 23 verified maps + the resale 20-19) run through the SAME
// buildMappedFieldMap + assertPlausibleMappedFieldCount machinery as
// single-document sends. Unmapped docs require caller-placed fields routed by
// `fields[].documentId`. `prefix` keeps field names unique across documents
// (same-name fields on a DocuSeal template share one value — two "Buyer 1
// Signature" fields on different addenda must NOT be the same field).
function buildPacketDocEntry({ doc, docIndex, packetSize, allSigners, callerFields }) {
  const prefix = packetSize > 1 ? `D${docIndex + 1} ` : '';
  const formEntry = doc.document_type === 'resale_contract'
    ? resaleFormEntry()
    : resolveEsignFieldMapForDoc(doc);
  const flat = [];

  if (formEntry) {
    const built = buildMappedFieldMap(formEntry, allSigners); // throws 422 on any violation
    assertPlausibleMappedFieldCount(formEntry, built.fieldMap, allSigners); // throws 422
    console.log(`[esign-create] packet doc ${docIndex + 1}/${packetSize} "${doc.file_name}" `
      + `(${formEntry.form_type}, TREC ${formEntry.trec_no || '?'}): ${built.summary.join('; ')}`);
    for (const [role, roleFields] of Object.entries(built.fieldMap)) {
      for (const f of roleFields) {
        flat.push({
          name: `${prefix}${f.name}`,
          type: f.type,
          role,
          ...(f.preferences ? { preferences: f.preferences } : {}),
          areas: (f.areas || []).map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h, page: a.page })),
        });
      }
    }
  } else {
    const docFields = (callerFields || []).filter((f) => f && f.documentId === doc.id);
    validateCustomFieldsForDoc(doc, docFields, allSigners); // throws 422
    console.log(`[esign-create] packet doc ${docIndex + 1}/${packetSize} "${doc.file_name}" `
      + `(unmapped): ${docFields.length} caller-placed field(s)`);
    for (const f of docFields) {
      flat.push({
        name: `${prefix}${f.name}`,
        type: f.type,
        role: f.signerRole,
        ...(f.preferences && typeof f.preferences === 'object' ? { preferences: f.preferences } : {}),
        areas: f.areas.map((a) => ({ x: a.x, y: a.y, w: a.w, h: a.h, page: a.page })),
      });
    }
  }
  return { formEntry, fields: flat };
}

// Packet-wide gate: every principal (buyer/seller) signer must end up with at
// least one signature-type widget SOMEWHERE in the packet. Mapped documents
// already guarantee this per-document; this catches all-upload packets where
// a signer was named but never given a signature placement.
function assertPacketSignable(packetDocs, allSigners) {
  for (const s of allSigners) {
    const role = s.role || 'Signer';
    if (classifyRole(role) === 'agent') continue;
    const hasSignature = packetDocs.some((d) => d.fields.some(
      (f) => f.role === role && f.type === 'signature',
    ));
    if (!hasSignature) {
      throw new ValidationError(
        `Signer "${role}" has no signature field anywhere in this packet. Refusing to send an `
        + `unsignable packet.`, 422,
      );
    }
  }
}

// Create ONE transient DocuSeal template carrying every packet PDF as its own
// document, then ONE submission against it. Verified live 2026-09-08:
// POST /templates/pdf accepts documents:[] with per-document fields; each
// field binds to its own document (attachment_uuid) and areas[].page stays
// local + 1-indexed per document; roles are shared submitters across all
// documents. One submission = one signing session = one email per signer.
async function docusealCreateFromPacket({ packetName, documents, signers, message }) {
  if (!DOCUSEAL_API_KEY) {
    console.warn('[esign-create] DOCUSEAL_API_KEY not set — returning stub packet submission.');
    return {
      id: `stub-packet-${Date.now()}`,
      templateId: null,
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

  const tmplBody = {
    name: packetName || 'Signing packet',
    documents: documents.map((d) => ({
      // DocuSeal appends .pdf to the document name itself (probe: "DocA.pdf"
      // came back "DocA.pdf.pdf") — strip the extension here.
      name: String(d.fileName || 'Document').replace(/\.pdf$/i, ''),
      file: `data:application/pdf;base64,${d.pdfBuffer.toString('base64')}`,
      fields: d.fields,
    })),
    submitters: signers.map((s) => ({ name: s.role || 'Signer' })),
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
    throw new ValidationError(`DocuSeal packet template creation failed (${tmplRes.status}): ${text.slice(0, 200)}`, 422);
  }
  const tmplData = await tmplRes.json();
  if (!tmplData.id) {
    throw new ValidationError('DocuSeal packet template missing id.', 502);
  }

  return createSubmissionFromTransientTemplate(tmplData, signers, message);
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

// IABS template routing constants + helpers.
// 2026-07-14 Atlas — Simple Send with a blank IABS form_template document
// used to 422 with "This form template PDF is not available" because the
// resolver in _lib/resolve-blank-template-pdf.js has no SHORT_NAME_TO_FORM_TYPE
// entry for "IABS" (and no base64 asset for IABS). The correct fix is not to
// ship an IABS base64 PDF (blank IABS makes no legal sense — it must carry the
// agent's broker info), but to route the Simple Send request through the same
// DocuSeal template flow (templates 4985883 / 4984666) that the "Use TREC
// template" tab already uses. Mirrors the completed-broker-submitter pattern
// from esign-templates.js (line ~2005) so the PDF renders populated.
const IABS_BUYER_TEMPLATE_ID = 4985883;
const IABS_SELLER_TEMPLATE_ID = 4984666;

// Role list per IABS template — mirrors TEMPLATE_ROLES in esign-templates.js.
// Used by iabsNormalizeSignerRole so incoming "Buyer"/"Seller"/"Buyer 1" etc
// collapse to the single consumer signer role each IABS template exposes.
const IABS_TEMPLATE_ROLES = {
  [IABS_BUYER_TEMPLATE_ID]: ['Buyer Broker', 'Buyer 1'],
  [IABS_SELLER_TEMPLATE_ID]: ['Seller Broker', 'Seller 1'],
};

function iabsNormalizeSignerRole(role, templateId) {
  const roles = IABS_TEMPLATE_ROLES[Number(templateId)] || [];
  const trimmed = String(role || '').trim();
  // Buyer template only has one consumer slot "Buyer 1"; seller has "Seller 1".
  // Any incoming buyer-side role collapses to "Buyer 1"; seller-side to "Seller 1".
  const consumerRole = roles.find((r) => !/broker|agent/i.test(r));
  if (!consumerRole) return trimmed;
  if (/^buyer|^tenant/i.test(trimmed) && Number(templateId) === IABS_BUYER_TEMPLATE_ID) return consumerRole;
  if (/^seller|^landlord/i.test(trimmed) && Number(templateId) === IABS_SELLER_TEMPLATE_ID) return consumerRole;
  // Fallback — assume the single consumer slot.
  return consumerRole;
}

// Detect whether the given documents row is a blank IABS form_template
// placeholder (no PDF bytes exist for IABS). Returns true only when the row
// looks like a form_template placeholder AND the linked form_templates row has
// short_name === 'IABS'. Anything else — filled IABS PDFs uploaded by the
// user, non-IABS form_templates, ordinary uploads — returns false so the
// caller falls through to the normal Simple Send path.
async function isBlankIabsDocument(doc) {
  if (!doc) return false;
  if (doc.document_type !== 'form_template' || doc.status !== 'blank') return false;
  if (!doc.form_template_id) return false;
  try {
    const r = await supa(`form_templates?id=eq.${encodeURIComponent(doc.form_template_id)}&is_active=eq.true&select=short_name`);
    if (!r.ok) return false;
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) && rows.length > 0 && rows[0].short_name === 'IABS';
  } catch (err) {
    console.warn('[esign-create] isBlankIabsDocument lookup failed:', err && err.message);
    return false;
  }
}

// Pick the correct IABS DocuSeal template based on the signer roles. Any
// seller/landlord role => Seller/Landlord template. Otherwise defaults to
// Buyer/Tenant (which is the most common single-signer IABS case).
function pickIabsTemplateForSigners(signers) {
  for (const s of signers) {
    const role = String(s.role || '').toLowerCase().trim();
    if (/seller|landlord/.test(role)) return IABS_SELLER_TEMPLATE_ID;
  }
  return IABS_BUYER_TEMPLATE_ID;
}

// Fetch IABS agent defaults from profiles table.
// Column names must match api/_migrations/0025-iabs-defaults.sql exactly.
// 2026-07-14 Atlas — Fixed column name mismatch. Migration uses
// supervising_broker_license (no _number suffix); prior draft mismatched
// and silently dropped supervisor prefill fields.
async function getIabsDefaults(userId) {
  const res = await supa(`profiles?id=eq.${encodeURIComponent(userId)}&select=broker_name,broker_license_number,broker_phone,broker_email,broker_address_street,broker_address_city,broker_address_state,broker_address_zip,supervising_broker_name,supervising_broker_license,supervising_broker_phone,full_name,agent_license_number,agent_phone,email,iabs_defaults_completed&limit=1`);
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

// Map IABS agent defaults to DocuSeal template field names
// DocuSeal fields (from both IABS templates 4985883 and 4984666):
// sponsoring_broker_name, sponsoring_broker_license_no, sponsoring_broker_email, sponsoring_broker_phone,
// designated_broker_name, designated_broker_license_no, designated_broker_email, designated_broker_phone,
// supervisor_name, supervisor_license_no, supervisor_email, supervisor_phone,
// sales_agent_name, sales_agent_license_no, sales_agent_email, sales_agent_phone,
// client_initials, acknowledgment_date
function buildIabsPrefill(iabsDefaults) {
  if (!iabsDefaults || !iabsDefaults.iabs_defaults_completed) {
    return {};
  }
  const prefill = {};
  // Map sponsoring broker (the agent's broker firm)
  if (iabsDefaults.broker_name) prefill.sponsoring_broker_name = iabsDefaults.broker_name;
  if (iabsDefaults.broker_license_number) prefill.sponsoring_broker_license_no = iabsDefaults.broker_license_number;
  if (iabsDefaults.broker_email) prefill.sponsoring_broker_email = iabsDefaults.broker_email;
  if (iabsDefaults.broker_phone) prefill.sponsoring_broker_phone = iabsDefaults.broker_phone;

  // Map supervisor (supervising broker)
  if (iabsDefaults.supervising_broker_name) prefill.supervisor_name = iabsDefaults.supervising_broker_name;
  if (iabsDefaults.supervising_broker_license) prefill.supervisor_license_no = iabsDefaults.supervising_broker_license;
  if (iabsDefaults.supervising_broker_phone) prefill.supervisor_phone = iabsDefaults.supervising_broker_phone;

  // Map sales agent (the agent themselves)
  if (iabsDefaults.full_name) prefill.sales_agent_name = iabsDefaults.full_name;
  if (iabsDefaults.agent_license_number) prefill.sales_agent_license_no = iabsDefaults.agent_license_number;
  if (iabsDefaults.email) prefill.sales_agent_email = iabsDefaults.email;
  if (iabsDefaults.agent_phone) prefill.sales_agent_phone = iabsDefaults.agent_phone;

  // Note: designated_broker_* and client_initials/acknowledgment_date are signer-filled, not defaulted
  return prefill;
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

async function docusealCreateFromPdf({ documentUrl, pdfBuffer: providedBuffer, fileName, signers, message, fields, fieldMap }) {
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
  //   1. Download the PDF bytes (from signed URL) — or use provided pdfBuffer
  //   2. POST /templates/pdf to create a transient template w/ per-role fields
  //   3. POST /submissions with template_id + submitters[role,email,name]
  //
  // This matches the pattern used by sendForAcknowledgment() earlier in this file.
  //
  // 2026-07-12: Accept an in-memory pdfBuffer for blank form_template documents
  // (no Storage-backed file). resolveBlankTemplatePdf() supplies the buffer;
  // caller falls back to documentUrl for user-uploaded PDFs.

  // Step 1: Obtain PDF bytes.
  let pdfBuffer;
  if (providedBuffer) {
    pdfBuffer = providedBuffer;
  } else {
    const pdfRes = await fetch(documentUrl);
    if (!pdfRes.ok) {
      throw new ValidationError(`Could not fetch document for signing (${pdfRes.status}).`, 502);
    }
    pdfBuffer = Buffer.from(await pdfRes.arrayBuffer());
  }
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

  // Step 4: Create the submission from the template.
  const result = await createSubmissionFromTransientTemplate(tmplData, signers, message);
  // Audit trail: hash of the exact bytes sent for signing.
  result.sentPdfSha256 = sha256Hex(pdfBuffer);
  return result;
}

// ---------------------------------------------------------------------------
// 2026-09-08 CARTER — shared "template → submission" leg, extracted verbatim
// from docusealCreateFromPdf so the multi-document packet path uses the SAME
// submitter mapping + message handling instead of forking it.
// Returns { id, submitters, templateId }.
// ---------------------------------------------------------------------------
async function createSubmissionFromTransientTemplate(tmplData, signers, message) {
  const templateId = tmplData.id;
  // Map roles to submitter emails.
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
      templateId,
    };
  }
  if (submData && submData.id) return { ...submData, templateId };
  throw new ValidationError(`DocuSeal returned unexpected submission shape.`, 502);
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

async function docusealCreateFromTemplate({ templateId, signers, message, prefillData, extraSubmitter }) {
  // Creates a submission from a pre-built DocuSeal template (fields already placed).
  // extraSubmitter (optional): a pre-completed submitter to prepend BEFORE the
  //   real signers so DocuSeal stamps its `values` into the shared PDF at
  //   creation time. Used for IABS templates where the "Buyer Broker" /
  //   "Seller Broker" role owns all broker/agent fields; without a completed
  //   broker row, the consumer signer sees a blank PDF even when the clone
  //   has default_value set. Mirrors the pattern in esign-templates.js.
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

  // 2026-07-14 Atlas — Prepend a completed extraSubmitter (IABS broker) if
  // provided. DocuSeal materializes a submitter's `values` into the visible
  // PDF only once that submitter is completed, so the broker row must be
  // marked completed at creation time.
  const allSubmitters = extraSubmitter
    ? [
        {
          name: extraSubmitter.name,
          email: extraSubmitter.email,
          role: extraSubmitter.role,
          send_email: false,
          completed: extraSubmitter.completed === true,
          ...(extraSubmitter.values ? { values: extraSubmitter.values } : {}),
        },
        ...submitters,
      ]
    : submitters;

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
    submitters: allSubmitters,
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

// Record the envelope.
//
// ORDERING NOTE — this runs AFTER the DocuSeal submission exists and AFTER the
// signing emails have gone out. Until 2026-08-16 a failure here threw, the
// handler's catch turned it into a bare 500, and the agent was told
// "Could not send document for signature. Try again." while the envelope was
// live and the client already had a signing link in their inbox. Retrying then
// sends the client a SECOND envelope. That is the worst failure mode this
// endpoint has.
//
// Two real causes seen in production:
//   1. signature_requests.transaction_id has a FK to transactions, but
//      documents.transaction_id does not — a document whose dossier was
//      deleted still carries the dead id, and the insert dies on
//      23503 foreign_key_violation.
//   2. Any other transient PostgREST failure.
//
// So: on a FK violation, retry once WITHOUT transaction_id. A signature
// request that is not linked to a dossier is far better than no record of an
// envelope that is already out. Returns { row, warning } and never throws.
async function insertSignatureRequest(row) {
  const attempt = async (payload) => {
    const res = await supa('signature_requests', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const rows = await res.json();
      return { ok: true, row: Array.isArray(rows) ? rows[0] : rows };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text };
  };

  let first = await attempt(row);
  if (first.ok) return { row: first.row, warning: null };

  // 2026-09-08 CARTER — the packet + audit-trail columns (document_ids,
  // sent_pdf_sha256, docuseal_template_id — api/_migrations/0026) may not
  // exist yet on an environment where the migration hasn't run. Losing the
  // whole tracking row over an optional column is the worst outcome (the
  // envelope is already out) — strip them and retry, loudly.
  const isUnknownColumn = first.text.includes('PGRST204')
    || /could not find the .* column/i.test(first.text)
    || /column .* does not exist/i.test(first.text);
  if (isUnknownColumn) {
    const stripped = { ...row };
    for (const col of ['document_ids', 'sent_pdf_sha256', 'docuseal_template_id']) delete stripped[col];
    console.warn('[esign-create] signature_requests insert hit unknown column — run '
      + 'api/_migrations/0026-esign-packets-audit.sql. Retrying without audit columns.');
    first = await attempt(stripped);
    if (first.ok) {
      return {
        row: first.row,
        warning: 'Sent and recorded, but packet/audit metadata could not be saved (database migration pending).',
      };
    }
  }

  const isFkViolation = first.text.includes('23503')
    || /foreign key constraint/i.test(first.text);

  if (isFkViolation && row.transaction_id) {
    console.warn('[esign-create] signature_requests FK violation on transaction_id=%s — '
      + 'retrying unlinked so the envelope is still recorded.', row.transaction_id);
    const retry = await attempt({ ...row, transaction_id: null });
    if (retry.ok) {
      return {
        row: retry.row,
        warning: 'Sent, but I could not link this to the dossier — its record is missing. '
          + 'The signature request is saved and tracking will still work.',
      };
    }
    console.error('[esign-create] signature_requests retry failed (%s): %s',
      retry.status, retry.text.slice(0, 300));
  } else {
    console.error('[esign-create] signature_requests insert failed (%s): %s',
      first.status, first.text.slice(0, 300));
  }

  // Never throw. The document IS sent; refusing to say so is the bigger harm.
  return {
    row: null,
    warning: 'Sent, but I could not save the tracking record for it. '
      + 'Do not send it again — check DocuSeal before re-sending.',
  };
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
        signatureRequestId: inserted.row?.id || null,
        signers: signerRows,
        docusealTemplateId: createdTemplateId,
        ...(inserted.warning ? { warning: inserted.warning } : {}),
      });
    }

    // 2026-09-01 CARTER — accept `documentIds: [uuid]` (the FormEditor Send
    // button contract) alongside legacy `documentId`.
    // 2026-09-08 CARTER — 2+ documentIds now build a multi-document packet
    // (one envelope, one email per signer). Order is the member's packet
    // order and is preserved end-to-end. Single-document sends (legacy
    // `documentId` or a 1-element array) keep the existing path untouched.
    let documentId = sanitizeString(body.documentId, { maxLength: 200 });
    let packetDocumentIds = null;
    if (!documentId && Array.isArray(body.documentIds) && body.documentIds.length > 0) {
      const cleaned = body.documentIds.map((id) => sanitizeString(id, { maxLength: 200 })).filter(Boolean);
      if (cleaned.length !== body.documentIds.length) {
        throw new ValidationError('Every documentIds entry must be a document id.');
      }
      if (cleaned.length > MAX_PACKET_DOCUMENTS) {
        throw new ValidationError(`A packet can contain at most ${MAX_PACKET_DOCUMENTS} documents.`);
      }
      if (new Set(cleaned).size !== cleaned.length) {
        throw new ValidationError('The same document appears more than once in the packet.');
      }
      if (cleaned.length > 1) packetDocumentIds = cleaned;
      else documentId = cleaned[0];
    }
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

    if (!documentId && !packetDocumentIds) {
      throw new ValidationError('documentId is required.');
    }
    if (packetDocumentIds && templateId) {
      throw new ValidationError('templateId cannot be combined with a multi-document packet — the template flow is single-document.', 422);
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

    // ------------------------------------------------------------------
    // Multi-document packet path (2026-09-08). One envelope for the whole
    // packet; per-document field maps + 422 gates; caller-placed fields for
    // unmapped uploads routed by fields[].documentId.
    // ------------------------------------------------------------------
    if (packetDocumentIds) {
      // Fetch every document (verifies ownership on each).
      const packetDocRows = [];
      for (const id of packetDocumentIds) {
        packetDocRows.push(await getDocumentRow(id, userId));
      }

      // All docs must belong to the same dossier (or carry none). Two
      // different transactions in one envelope is always a mistake.
      const txIds = [...new Set(packetDocRows.map((d) => d.transaction_id).filter(Boolean))];
      if (txIds.length > 1) {
        throw new ValidationError('Packet documents belong to different dossiers — send them separately.', 422);
      }
      const packetTransactionId = txIds[0] || null;
      const packetTx = packetTransactionId ? await getFullTransactionRow(packetTransactionId, userId) : null;
      const packetPropertyAddress = packetTx ? (packetTx.property_address || '') : '';

      const packetSigners = agentSignerEmail
        ? [...signers, { name: agentSignerName, email: agentSignerEmail, role: 'Agent' }]
        : signers;

      // Build every document entry: PDF bytes + gated field placement.
      // Signer→slot assignment is deterministic from the same signers array
      // on every document, so Buyer 1 is the same person on every form.
      const packetDocs = [];
      for (let i = 0; i < packetDocRows.length; i += 1) {
        const d = packetDocRows[i];
        const pdfBuffer = await resolvePdfBufferForDoc(d);
        const { fields: docFields } = buildPacketDocEntry({
          doc: d,
          docIndex: i,
          packetSize: packetDocRows.length,
          allSigners: packetSigners,
          callerFields: fields,
        });
        packetDocs.push({
          documentId: d.id,
          fileName: d.file_name || `Document ${i + 1}.pdf`,
          pdfBuffer,
          fields: docFields,
          sha256: sha256Hex(pdfBuffer),
        });
      }
      assertPacketSignable(packetDocs, packetSigners);

      const firstName = packetDocs[0].fileName.replace(/\.pdf$/i, '');
      const packetLabel = packetDocs.length > 1
        ? `${firstName} + ${packetDocs.length - 1} more document${packetDocs.length > 2 ? 's' : ''}`
        : firstName;

      const packetResult = await docusealCreateFromPacket({
        packetName: packetLabel,
        documents: packetDocs,
        signers: packetSigners,
        message,
      });

      const packetSubmissionId = String(packetResult.id || '');
      const packetSignerRows = (Array.isArray(packetResult.submitters) ? packetResult.submitters : []).map((sub, i) => {
        const slug = sub.slug || null;
        return {
          name: sub.name || packetSigners[i]?.name || '',
          email: sub.email || packetSigners[i]?.email || '',
          role: sub.role || packetSigners[i]?.role || 'Signer',
          status: sub.status || 'sent',
          signingUrl: slug ? `https://docuseal.com/s/${slug}` : (sub.embed_src || null),
          uuid: sub.uuid || null,
        };
      });

      // ONE Dossie-branded email per external signer for the whole packet.
      await Promise.all(
        packetSignerRows
          .filter((s) => s.email && s.email !== agentSignerEmail)
          .map((s) =>
            sendSigningEmail({
              signerName: s.name,
              signerEmail: s.email,
              documentName: packetLabel,
              propertyAddress: packetPropertyAddress,
              signingUrl: s.signingUrl,
            }).catch((err) => {
              console.error(`[esign-create] packet sendSigningEmail failed for ${s.email}:`, err && err.message ? err.message : err);
            })
          )
      );

      const sentHashes = {};
      for (const d of packetDocs) sentHashes[d.documentId] = d.sha256;

      const packetInserted = await insertSignatureRequest({
        user_id: userId,
        transaction_id: packetTransactionId,
        document_id: packetDocumentIds[0],
        document_ids: packetDocumentIds,
        sent_pdf_sha256: sentHashes,
        docuseal_template_id: packetResult.templateId ? String(packetResult.templateId) : null,
        docuseal_submission_id: packetSubmissionId,
        status: 'sent',
        signers: packetSignerRows,
        message: message || null,
        ...(sellerAgentName ? { seller_agent_name: sellerAgentName } : {}),
        ...(sellerAgentEmail ? { seller_agent_email: sellerAgentEmail } : {}),
      });

      // Stamp the submission id on every packet document (best-effort).
      if (packetSubmissionId) {
        await Promise.all(packetDocumentIds.map((id) =>
          supa(`documents?id=eq.${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ docuseal_submission_id: packetSubmissionId }),
            headers: { Prefer: 'return=minimal' },
          }).catch((e) => {
            console.warn('[esign-create] packet documents patch failed:', e && e.message ? e.message : e);
          })
        ));
      }

      return res.status(200).json({
        ok: true,
        submissionId: packetSubmissionId,
        signatureRequestId: packetInserted.row?.id || null,
        signers: packetSignerRows,
        documentIds: packetDocumentIds,
        ...(packetInserted.warning ? { warning: packetInserted.warning } : {}),
      });
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
    //      with ONLY signer widgets — initials 10x per party + signature + date.
    //   3. DocuSeal renders the PDF text as static content (baked, unchangeable)
    //      and only shows the signer-only widgets as interactive pink boxes.
    //
    // The old template-clone-with-defaults path (`docusealCreateFromTemplate`)
    // remains available for any explicit `templateId` passed in the request body,
    // but the resale-contract default route no longer sets one.
    //
    // Widget coordinates: api/_assets/trec-20-19-esign-coords.json (built
    // 2026-08-31 directly from AcroForm widget rectangles in the real 20-19
    // PDF — see that file's own "description"/"method" fields).
    let effectiveTemplateId = templateId;
    // NOTE: intentionally NOT setting effectiveTemplateId for resale_contract.

    // 2026-07-14 Atlas — Simple Send fix for blank IABS form_template docs.
    // When the customer picks IABS from the "attach template" library and hits
    // Simple Send, the documents row is a blank form_template placeholder with
    // no PDF bytes. The resolver in _lib/resolve-blank-template-pdf.js has no
    // mapping for IABS (blank IABS makes no legal sense — the broker info must
    // be baked in). Route those requests through the DocuSeal template flow so
    // the customer gets the same envelope the "Use TREC template" tab produces.
    // Buyer-side signers => 4985883 (Buyer/Tenant); Seller-side => 4984666
    // (Seller/Landlord). Signer roles are normalized to the template's single
    // consumer slot ("Buyer 1" or "Seller 1").
    if (!effectiveTemplateId && await isBlankIabsDocument(doc)) {
      const iabsTemplateId = pickIabsTemplateForSigners(signers);
      effectiveTemplateId = String(iabsTemplateId);
      console.log(`[esign-create] Blank IABS form_template ${doc.form_template_id} routed to DocuSeal template ${effectiveTemplateId} for Simple Send.`);
      // Normalize the incoming signer roles to what the picked IABS template
      // exposes (single "Buyer 1" or "Seller 1" slot). Mutating allSigners
      // here keeps the downstream docusealCreateFromTemplate call consistent
      // with the completed-broker-submitter role name.
      for (let i = 0; i < allSigners.length; i += 1) {
        const original = allSigners[i].role;
        allSigners[i] = { ...allSigners[i], role: iabsNormalizeSignerRole(original, iabsTemplateId) };
        if (allSigners[i].role !== original) {
          console.log(`[esign-create] IABS role normalize: "${original}" -> "${allSigners[i].role}"`);
        }
      }
    }

    if (effectiveTemplateId) {
      // Phase 3 path — template-based submission with optional pre-fill.
      // Build resale-specific prefill (full field map) if we have a transaction
      // and this is the resale template; otherwise fall back to the earlier
      // generic prefill from tx.
      let prefill = prefillData || {};

      // Check if this is an IABS template (Buyer/Tenant or Seller/Landlord)
      const IABS_TEMPLATE_IDS = [IABS_BUYER_TEMPLATE_ID, IABS_SELLER_TEMPLATE_ID];
      const isIabsTemplate = IABS_TEMPLATE_IDS.includes(Number(effectiveTemplateId));

      // 2026-07-14 Atlas — IABS completed-broker-submitter injection.
      // DocuSeal only materializes a submitter's field values into the visible
      // PDF once that submitter is completed. IABS templates route all 16
      // broker/agent fields to the "Buyer Broker" / "Seller Broker" role.
      // Without a completed broker submitter, the consumer signer sees a blank
      // PDF even when clone default_value is set. Fix mirrors esign-templates.js.
      let iabsBrokerSubmitter = null;
      let iabsDefaultsRow = null;
      let iabsPrefillForBroker = {};
      if (isIabsTemplate) {
        // For IABS templates, fetch and apply agent defaults
        iabsDefaultsRow = await getIabsDefaults(userId).catch(() => null);
        iabsPrefillForBroker = buildIabsPrefill(iabsDefaultsRow);
        prefill = { ...iabsPrefillForBroker, ...prefill };
        console.log(`[esign-create] IABS template ${effectiveTemplateId}: applied ${Object.keys(iabsPrefillForBroker).length} defaults`);
      } else if (tx) {
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

      // Build the completed broker submitter for IABS AFTER prefill is finalized
      // (so agent-edits from prefillData win over saved defaults, mirroring
      // esign-templates.js). Then strip broker-owned keys from `prefill` so
      // clone-default_value doesn't double-render fields the broker submitter
      // will already stamp via `values`.
      if (isIabsTemplate && Object.keys(iabsPrefillForBroker).length > 0) {
        const brokerValues = { ...iabsPrefillForBroker };
        for (const k of Object.keys(prefillData || {})) {
          const v = prefillData[k];
          if (v !== null && v !== undefined && v !== '') brokerValues[k] = String(v);
        }
        const brokerRole = Number(effectiveTemplateId) === IABS_BUYER_TEMPLATE_ID
          ? 'Buyer Broker'
          : 'Seller Broker';
        const agentName = (iabsDefaultsRow && iabsDefaultsRow.full_name) || 'Agent';
        const agentEmail = (iabsDefaultsRow && iabsDefaultsRow.email) || 'noreply@meetdossie.com';
        iabsBrokerSubmitter = {
          name: agentName,
          email: agentEmail,
          role: brokerRole,
          send_email: false,
          completed: true,
          values: brokerValues,
        };
        for (const k of Object.keys(iabsPrefillForBroker)) {
          delete prefill[k];
        }
        console.log(`[esign-create] IABS template ${effectiveTemplateId}: injecting completed ${brokerRole} submitter with ${Object.keys(brokerValues).length} field(s)`);
      }

      const prefillKeys = Object.keys(prefill).filter((k) => prefill[k] != null && prefill[k] !== '');
      console.log(`[esign-create] v12 template ${effectiveTemplateId} with ${prefillKeys.length} prefill field(s): ${prefillKeys.slice(0, 8).join(', ')}${prefillKeys.length > 8 ? '...' : ''}`);
      submissionResult = await docusealCreateFromTemplate({
        templateId: effectiveTemplateId,
        signers: allSigners,
        message,
        prefillData: prefill,
        ...(iabsBrokerSubmitter ? { extraSubmitter: iabsBrokerSubmitter } : {}),
      });
    } else {
      // resale_contract (and other non-template PDFs like Seller's Disclosure
      // ack, addendums, etc.) go through /templates/pdf with signer-only widgets.
      // The PDF text is baked in by fill-form.js; only initial/signature/date
      // widgets are added on top.
      //
      // 2026-07-12 ATLAS: Blank form_template documents (Wire Fraud Warning,
      // static TAR/TREC forms attached but never filled) have a placeholder
      // storage_path that 404s. Resolve their PDF from base64 assets instead.
      let signedUrl = null;
      let pdfBuffer = null;
      const isBlankTemplate = doc.document_type === 'form_template' && doc.status === 'blank';
      if (isBlankTemplate && doc.form_template_id) {
        // 2026-08-25 CARTER — Quinn's blank-send bug (roadmap item #3, Alpha
        // TC roadmap, real Playwright test 2026-08-24). Form Library's
        // "Attach" creates exactly this status:'blank' row pointing at the
        // raw TREC template with zero transaction data — and this branch
        // used to send it straight to DocuSeal for real signature no matter
        // what form it was. Quinn proved it live: DocuSeal confirmed
        // "values": [] on the created submission. Gate on the resolved
        // slug now: only forms with genuinely zero fillable legal content
        // (BLANK_SEND_SAFE_SLUGS — currently just the Wire Fraud Warning
        // notice) may go out from the blank asset. Every real contract or
        // addendum must be filled first — the agent needs the Fill Contract
        // / Interactive Editor flow's own required-field gate, which stamps
        // real values into documents.storage_path (status leaves 'blank')
        // before a signature request can be created for it.
        const resolved = await resolveBlankTemplatePdfDoc(doc);
        if (!resolved) {
          throw new ValidationError('This form template PDF is not available. Please contact support.', 422);
        }
        if (!BLANK_SEND_SAFE_SLUGS.has(resolved.slug)) {
          throw new ValidationError(
            'This form has not been filled in yet. Open it from the dossier and use Fill Contract to complete the required fields before sending it for signature.',
            409,
          );
        }
        pdfBuffer = resolved.buffer;
        console.log(`[esign-create] Blank form_template ${doc.form_template_id} (slug=${resolved.slug}, blank-send-safe) resolved from base64 assets (${pdfBuffer.length} bytes).`);
      } else {
        signedUrl = await generateSignedUrl(doc.storage_path, 300);
      }

      let autoFieldMap = null;
      if (!fields && doc.document_type === 'resale_contract') {
        // 2026-09-08 CARTER — resale converged onto the generalized
        // assignment + gate (see resaleFormEntry). buildMappedFieldMap
        // throws 422 on a 3rd buyer/seller (the 20-19 has exactly two
        // printed lines per side — the old path silently stacked buyer 3
        // onto buyer 2's signature rect), on duplicate role names, and on
        // unclassifiable roles. assertPlausibleMappedFieldCount then
        // re-verifies per-signer signature presence + exact widget totals
        // from the SAME entry — a green DocuSeal response is not evidence
        // the placement was correct (2026-08-31 lesson).
        const formEntry = resaleFormEntry();
        const built = buildMappedFieldMap(formEntry, allSigners); // throws 422 on any violation
        autoFieldMap = built.fieldMap;
        console.log(`[esign-create] resale_contract (TREC 20-19) mapped widgets: ${built.summary.join('; ')}`);
        // Log actual widget coordinates for APV verification.
        for (const [role, roleFields] of Object.entries(autoFieldMap)) {
          for (const f of roleFields) {
            const a = (f.areas && f.areas[0]) || {};
            console.log(`[esign-create]   ${role} ${f.type} "${f.name}" p${a.page}: x=${a.x} y=${a.y} w=${a.w} h=${a.h}`);
          }
        }
        assertPlausibleMappedFieldCount(formEntry, autoFieldMap, allSigners);
      } else if (!fields) {
        // 2026-09-08 CARTER — every other mapped form (23 forms: 20 addenda +
        // seller's disclosure + unimproved-property + seller-financing etc.)
        // gets its verified per-form signing widgets instead of the old
        // auto-place fallback. Unmapped document types (uploads, flat TAR
        // forms) still fall through to auto-place — the field maps only exist
        // where geometry has been measured AND visually verified.
        const formEntry = resolveEsignFieldMapForDoc(doc);
        if (formEntry) {
          const built = buildMappedFieldMap(formEntry, allSigners); // throws 422 on any violation
          autoFieldMap = built.fieldMap;
          console.log(`[esign-create] ${formEntry.form_type} (TREC ${formEntry.trec_no || '?'}) mapped widgets: ${built.summary.join('; ')}`);
          for (const [role, roleFields] of Object.entries(autoFieldMap)) {
            for (const f of roleFields) {
              const a = (f.areas && f.areas[0]) || {};
              console.log(`[esign-create]   ${role} ${f.type} "${f.name}" p${a.page}: x=${a.x} y=${a.y} w=${a.w} h=${a.h}`);
            }
          }
          assertPlausibleMappedFieldCount(formEntry, autoFieldMap, allSigners);
        }
      }

      submissionResult = await docusealCreateFromPdf({
        documentUrl: signedUrl,
        pdfBuffer,
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
      // Audit trail (2026-09-08): hash of the exact bytes sent + the
      // transient template id (for the future reaper). Both columns are
      // stripped-and-retried by insertSignatureRequest if the migration
      // hasn't run yet.
      ...(submissionResult.sentPdfSha256
        ? { sent_pdf_sha256: { [documentId]: submissionResult.sentPdfSha256 } } : {}),
      ...(submissionResult.templateId
        ? { docuseal_template_id: String(submissionResult.templateId) } : {}),
      ...(sellerAgentName ? { seller_agent_name: sellerAgentName } : {}),
      ...(sellerAgentEmail ? { seller_agent_email: sellerAgentEmail } : {}),
    });

    return res.status(200).json({
      ok: true,
      submissionId,
      signatureRequestId: inserted.row?.id || null,
      signers: signerRows,
      ...(inserted.warning ? { warning: inserted.warning } : {}),
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
    // "Try again" was the only thing an agent ever saw here, and retrying a
    // send is exactly the wrong move when the envelope may already be out.
    // Log the real cause and give the agent a short, non-sensitive hint so a
    // support ticket is actionable instead of a mystery.
    const raw = (error && error.message) ? String(error.message) : String(error);
    console.error('[esign-create] error:', raw);
    let hint = 'Something failed on my side before it went out.';
    if (/signature_requests insert/i.test(raw) || /23503|foreign key/i.test(raw)) {
      hint = 'The document may have been sent but I could not record it. '
        + 'Check DocuSeal before sending it again.';
    } else if (/storage|download|no storage path/i.test(raw)) {
      hint = 'I could not read that document\'s file.';
    } else if (/docuseal/i.test(raw)) {
      hint = 'The e-signature provider rejected the document.';
    } else if (/resend|email/i.test(raw)) {
      hint = 'The envelope was created but the notification email failed.';
    }
    return res.status(500).json({
      ok: false,
      error: `Could not send that for signature. ${hint}`,
    });
  }
};

// Test-only surface (not part of the HTTP contract). Used by
// scripts/regression-trec-20-19-esign-coords.js and local verification
// scripts so real-DocuSeal tests don't have to fake a full HTTP request.
module.exports.__testing = {
  resaleFormEntry,
  loadResaleCoords,
  docusealCreateFromPdf,
  classifyRole,
  loadEsignFieldMaps,
  resolveEsignFieldMapForDoc,
  buildMappedFieldMap,
  assertPlausibleMappedFieldCount,
  // Packet machinery (2026-09-08)
  buildPacketDocEntry,
  validateCustomFieldsForDoc,
  assertPacketSignable,
  docusealCreateFromPacket,
  sha256Hex,
  MAX_PACKET_DOCUMENTS,
};

