'use strict';

// api/_lib/contract-extraction-tools.js
//
// "Pull the dates off the contract" — Heath asked Dossie this in chat and
// there was no tool for it. api/scan-contract.js only ever ran from the
// UnderContractDropStep drop zone in dossie-app.jsx, so this could never
// have worked no matter how it was phrased.
//
// Server-resolved (like list_form_library / import_email_attachments), not
// client-dispatched, on purpose: a client-dispatched tool needs a matching
// client-side handler or it is a silent no-op — how log_offer shipped dead
// on 2026-09-19. Resolving this entirely server-side removes that failure
// mode by construction; there is nothing for a client build to forget to
// wire up.
//
// Reuses contract-term-persistence-store.js — the SAME fill-blanks/surface-
// conflicts logic api/_lib/inbox-tools.js's Phase 4c (import_email_attachments)
// now uses, so a contract pulled by a spoken request gets identical
// treatment to one that arrived by email: blanks fill in, anything that
// disagrees with what's already on the dossier is left alone and surfaced
// as a conflict, never silently overwritten.
//
// Owner: Carter, 2026-09-21.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  return { ok: res.ok, status: res.status, data };
}

class ContractExtractionSecurityError extends Error {}

const CONTRACT_EXTRACTION_TOOLS = [
  {
    name: 'extract_contract_terms',
    description: "Read the dates, deadlines and dollar amounts off a dossier's 1-4 family contract and fill in whatever the dossier is missing. Use when the member asks Dossie to pull the dates/terms off the contract, read the contract, or fill in the deal from the contract. Never overwrites a value already on the dossier — a value that disagrees with the contract is left alone and flagged for the member to review, never silently changed.",
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: {
          type: 'string',
          description: "Any part of the address or buyer/seller name. If the member is looking at an open dossier and does not name a different one, use that dossier's address.",
        },
      },
      required: ['deal_identifier'],
    },
  },
];
const CONTRACT_EXTRACTION_TOOL_NAMES = new Set(CONTRACT_EXTRACTION_TOOLS.map((t) => t.name));

// Same small resolver shape as inbox-tools.js / form-library-tools.js's
// resolveOwnedTransaction — re-implemented locally per those files' own
// convention rather than reaching into another module's internals.
async function resolveOwnedTransaction(userId, identifier) {
  const needle = String(identifier || '').trim();
  if (!needle) return null;
  const esc = encodeURIComponent(`*${needle.replace(/[*,()]/g, '')}*`);
  const uid = encodeURIComponent(userId);
  const { ok, data } = await sb(
    `transactions?select=id,property_address,seller_name,buyer_name`
    + `&user_id=eq.${uid}`
    + `&or=(property_address.ilike.${esc},seller_name.ilike.${esc},buyer_name.ilike.${esc})`
    + `&order=updated_at.desc&limit=1`,
  );
  if (!ok) return null;
  return (Array.isArray(data) && data[0]) || null;
}

// NOTE: document_type === 'trec-20-17' is used here as the generic "this is
// the 1-4 family contract" marker — same convention the rest of this
// codebase uses today (dossie-app.jsx's DOC_TYPE_TO_CHECKLIST,
// handleUploadDocument, inbox-tools.js Phase 3), under which a real TREC
// 20-19 file is also identified this way. Flagged separately for a proper
// "is this the contract" vs "which revision" split; not decoupled here so
// this stays consistent with the rest of the app for now.
async function findContractDocument(userId, transactionId) {
  const { ok, data } = await sb(
    `documents?select=id,file_name,document_type,storage_path`
    + `&transaction_id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + `&document_type=eq.trec-20-17`
    + `&order=uploaded_at.desc&limit=1`,
  );
  if (!ok) return null;
  return (Array.isArray(data) && data[0]) || null;
}

async function fetchPdfBase64FromStorage(storagePath) {
  const storageUrl = `${SUPABASE_URL}/storage/v1/object/documents/${storagePath}`;
  const resp = await fetch(storageUrl, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!resp.ok) throw new Error(`storage fetch failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

async function executeContractExtractionTool(name, input, { userId }) {
  if (!userId) throw new ContractExtractionSecurityError('contract-extraction tool called without a verified user id');
  if (input && (input.user_id || input.userId)) {
    throw new ContractExtractionSecurityError('contract-extraction tool input carried an identity-shaped field');
  }
  if (name !== 'extract_contract_terms') return { ok: false, error: 'unknown tool' };

  const dealIdentifier = String((input && input.deal_identifier) || '').trim();
  if (!dealIdentifier) return { ok: false, error: 'no dossier identified' };

  const tx = await resolveOwnedTransaction(userId, dealIdentifier);
  if (!tx) return { ok: false, error: `I couldn't find a dossier for "${dealIdentifier}".` };

  const doc = await findContractDocument(userId, tx.id);
  if (!doc) {
    return {
      ok: false,
      error: `I don't see a contract on file for ${tx.property_address || 'that dossier'} yet — upload it first and I can pull the dates off it.`,
    };
  }
  if (!doc.storage_path) {
    return { ok: false, error: "That contract is on file but I can't read its file — try re-uploading it." };
  }

  let scanner;
  try {
    // Lazily required — same reason inbox-tools.js's loadScanner is lazy:
    // api/scan-contract.js constructs an Anthropic client at module load, so
    // requiring it at the top of every file that might touch a contract
    // would spend that cost even when nothing here runs.
    scanner = require('../scan-contract.js');
  } catch (err) {
    return { ok: false, error: 'The contract reader is unavailable right now.' };
  }

  let pdfBase64;
  try {
    pdfBase64 = await fetchPdfBase64FromStorage(doc.storage_path);
  } catch (err) {
    console.error('[contract-extraction-tools] storage fetch failed:', err && err.message);
    return { ok: false, error: "I couldn't open that contract file just now. Try again in a moment." };
  }

  // Re-confirm the document type on the actual bytes rather than trusting
  // the documents.document_type column blindly — that column is set once at
  // upload time and this tool is about to write real dollar amounts and
  // dates onto the dossier from whatever it reads, the same real-money-error
  // risk a wrong closing date always is.
  let documentTypeConfidence = 0;
  try {
    const identified = await scanner.identifyDocument(pdfBase64);
    documentTypeConfidence = (identified && typeof identified.confidence === 'number') ? identified.confidence : 0;
  } catch (err) {
    console.error('[contract-extraction-tools] identify failed:', err && err.message);
  }

  let extracted;
  try {
    const scan = await scanner.scanContract(pdfBase64);
    extracted = scan && scan.extracted;
  } catch (err) {
    console.error('[contract-extraction-tools] scan failed:', err && err.message);
    return { ok: false, error: "I couldn't read that contract just now. Try again in a moment." };
  }
  if (!extracted) {
    return { ok: false, error: "I opened the contract but couldn't read its terms." };
  }

  const { persistContractTermsFromScan } = require('./contract-term-persistence-store');
  const result = await persistContractTermsFromScan(sb, {
    userId,
    transactionId: tx.id,
    extracted,
    documentTypeConfidence,
    source: { document_id: doc.id, file_name: doc.file_name, document_label: 'the contract' },
    scanId: `chat-extract-${doc.id}-${Date.now()}`,
  });

  if (!result.ok) {
    if (result.reason === 'nothing_to_fill') {
      return {
        ok: true,
        transaction_id: tx.id,
        property_address: tx.property_address,
        filled: [],
        conflicts: [],
        message: 'Read the contract, but everything it says is already on the dossier — nothing new to fill in.',
      };
    }
    return { ok: false, error: "I read the contract but couldn't save what I found. Try again in a moment." };
  }

  const plan = result.plan || { filled: [], conflicts: [] };
  return {
    ok: true,
    transaction_id: tx.id,
    property_address: tx.property_address,
    filled: plan.filled.map((f) => ({ field: f.label, value: f.value })),
    conflicts: plan.conflicts.map((c) => ({ field: c.column, existing: c.existing, contract_says: c.parsed, detail: c.detail })),
    low_confidence: documentTypeConfidence < 0.70,
  };
}

module.exports = {
  CONTRACT_EXTRACTION_TOOLS,
  CONTRACT_EXTRACTION_TOOL_NAMES,
  executeContractExtractionTool,
  ContractExtractionSecurityError,
};
