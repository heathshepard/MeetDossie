// api/_lib/form-library-tools.js
//
// Two Form Library tools exposed to api/chat.js's action mode, resolved
// server-side inside the same tool-resolve loop as the inbox and
// member-memory tools (api/_lib/server-tool-resolve-loop.js) — listing and
// attaching a BLANK form is low-stakes (no email leaves, no signature
// request is created) so neither one needs a client confirmation card the
// way send_for_signature/send_packet_to_party do.
//
// list_form_library reuses api/form-templates.js's GET query; attach_form_to_deal
// calls attachFormTemplate(), the exact function api/form-templates.js's own
// POST action:'attach' HTTP handler uses — one attach code path, not two.
//
// MEMBER FORMS FALLBACK (2026-09-21): attach_form_to_deal also checks the
// calling member's own member_form_templates (Settings -> My Standard
// Documents / Documents tab -> My Forms) when the Form Library has nothing
// matching. This is the exact gap Heath hit — he asked Dossie for his KW
// City View CMA Acknowledgement, she said it wasn't something she could do,
// because at the time there was nowhere for a member's own form to live.
// Now there is; the resolution order is Form Library first, then the
// member's stored forms, and only if BOTH come back empty does she say so
// and point at the add path (see chat.js's FORM LIBRARY prompt section).
//
// THE 6-FORM GAP (2026-09-21): CDA, IABS, PID, TAR 2003, Groundwater Notice,
// and Property Affidavit are real, active form_templates rows with no PDF
// asset behind them at all (no entry in resolve-blank-template-pdf.js's
// SHORT_NAME_TO_FORM_TYPE map, so resolveBlankTemplatePdf() returns null and
// any send/fill attempt errors). This tool must never offer one of those as
// attachable — list_form_library filters to only short_names present in that
// map, so a form Dossie can't actually deliver is simply invisible here
// rather than something she'd offer and then fail on.
//
// SECURITY: userId is passed as its own argument from api/chat.js (derived
// from verifySupabaseToken), exactly like the inbox/memory tools — never
// merged into the tool's own input.
//
// Owner: Carter, 2026-09-21.

const { SHORT_NAME_TO_FORM_TYPE } = require('./resolve-blank-template-pdf');
const { attachFormTemplate, supa } = require('../form-templates');

const FORM_LIBRARY_TOOLS = [
  {
    name: 'list_form_library',
    description:
      "List the blank TREC/TAR forms available in Dossie's Form Library that can be attached to a dossier. Use when the agent asks anything like: what forms do you have, is there a [form name] in the library, show me the form library, what addenda can I attach, do you have a [TREC number]. Only lists forms Dossie can actually fill/attach and send today — never offers one that would error.",
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Optional filter — a form name, short name, or TREC/TAR number the agent mentioned. Omit to list everything available.' },
      },
    },
  },
  {
    name: 'attach_form_to_deal',
    description:
      'Attach a form to a dossier as a new document. Checks the Form Library first (a blank TREC/TAR form, ready to fill), then falls back to the agent\'s own stored forms under My Standard Documents / My Forms (their brokerage\'s own CMA Acknowledgement, hold-harmless, etc. — already a real file, attached ready to send). Use when the agent says anything like: attach the [form] to this file, add the HOA addendum, pull in the lead paint addendum, get me the [TREC number] form on this deal, send me my CMA Acknowledgement, attach our brokerage disclosure. Use list_form_library first if you are not sure of the exact Form Library name.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or buyer/seller name to identify the dossier' },
        form_name: { type: 'string', description: 'The form name or short name as the agent said it, or as returned by list_form_library — e.g. "HOA Addendum", "TREC 49-1".' },
      },
      required: ['deal_identifier', 'form_name'],
    },
  },
];

const FORM_LIBRARY_TOOL_NAMES = new Set(FORM_LIBRARY_TOOLS.map((t) => t.name));

class FormLibrarySecurityError extends Error {}

// Same small resolver shape as inbox-tools.js's resolveOwnedTransaction —
// re-implemented locally rather than reaching into that file's __testing
// export, which is not a stable surface for production callers.
async function resolveOwnedTransaction(userId, identifier) {
  const needle = String(identifier || '').trim();
  if (!needle) return null;
  const esc = encodeURIComponent(`*${needle.replace(/[*,()]/g, '')}*`);
  const uid = encodeURIComponent(userId);
  const res = await supa(
    `transactions?select=id,property_address,seller_name,buyer_name` +
    `&user_id=eq.${uid}` +
    `&or=(property_address.ilike.${esc},seller_name.ilike.${esc},buyer_name.ilike.${esc})` +
    `&order=updated_at.desc&limit=1`
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]) || null;
}

async function loadAttachableForms(search) {
  const res = await supa(
    'form_templates?is_active=eq.true&order=category.asc,trec_number.asc&select=id,name,short_name,category,trec_number,description'
  );
  if (!res.ok) throw new Error(`form_templates fetch failed: ${res.status}`);
  const rows = await res.json();
  const needle = String(search || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : [])
    // Only forms with a real PDF asset behind them — see header comment.
    .filter((r) => Boolean(SHORT_NAME_TO_FORM_TYPE[r.short_name]))
    .filter((r) => !needle || [r.name, r.short_name, r.trec_number, r.category]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)));
}

// The member's own stored forms (member_form_templates) that actually have a
// file behind them — a label-only row carried over from the old
// localStorage flow (storage_path null) is not attachable, same rule the
// client's Documents tab and Settings list use.
async function loadMemberForms(userId, search) {
  const uid = encodeURIComponent(userId);
  const res = await supa(
    `member_form_templates?user_id=eq.${uid}&storage_path=not.is.null&select=id,label,description,file_name,file_type,storage_path`
  );
  if (!res.ok) throw new Error(`member_form_templates fetch failed: ${res.status}`);
  const rows = await res.json();
  const needle = String(search || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => !needle || [r.label, r.description, r.file_name]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(needle)));
}

// Copies a member's stored form (same storage_path, no re-upload) onto the
// dossier as a real document row — the same insert api/insert-document-row.js
// and the client's handleAttachStandardDoc perform, reimplemented here so the
// chat tool doesn't have to make an HTTP call to itself. tx is already
// ownership-checked by resolveOwnedTransaction before this is called.
async function attachMemberForm(userId, memberForm, transactionId) {
  const docRow = {
    user_id: userId,
    transaction_id: transactionId,
    file_name: memberForm.file_name || `${memberForm.label}.pdf`,
    file_type: memberForm.file_type || 'application/pdf',
    document_type: 'other',
    storage_path: memberForm.storage_path,
  };
  const insertRes = await supa('documents', { method: 'POST', body: JSON.stringify(docRow) });
  if (!insertRes.ok) {
    const text = await insertRes.text().catch(() => '');
    throw new Error(`documents insert failed (${insertRes.status}): ${text.slice(0, 300)}`);
  }
  const inserted = await insertRes.json();
  const newDoc = Array.isArray(inserted) ? inserted[0] : inserted;
  return newDoc && newDoc.id ? newDoc.id : null;
}

async function executeFormLibraryTool(name, input, { userId }) {
  if (!userId) throw new FormLibrarySecurityError('form-library tool called without a verified user id');
  if (input && (input.user_id || input.userId)) {
    throw new FormLibrarySecurityError('form-library tool input carried an identity-shaped field');
  }

  if (name === 'list_form_library') {
    try {
      const forms = await loadAttachableForms(input.search);
      return {
        ok: true,
        count: forms.length,
        forms: forms.map((f) => ({ id: f.id, name: f.name, short_name: f.short_name, trec_number: f.trec_number, category: f.category })),
      };
    } catch (err) {
      console.error('[form-library-tools] list failed:', err.message);
      return { ok: false, error: 'could not load the form library' };
    }
  }

  // attach_form_to_deal
  const formName = String(input.form_name || '').trim();
  const dealIdentifier = String(input.deal_identifier || '').trim();
  if (!formName) return { ok: false, error: 'no form named' };
  if (!dealIdentifier) return { ok: false, error: 'no dossier identified' };

  const tx = await resolveOwnedTransaction(userId, dealIdentifier);
  if (!tx) {
    return { ok: false, error: `I couldn't find a dossier for "${dealIdentifier}".` };
  }

  let forms;
  try {
    forms = await loadAttachableForms(formName);
  } catch (err) {
    console.error('[form-library-tools] attach lookup failed:', err.message);
    return { ok: false, error: 'could not search the form library' };
  }

  if (forms.length) {
    const chosen = forms[0];
    try {
      const { documentId } = await attachFormTemplate(userId, chosen.id, tx.id);
      return {
        ok: true,
        source: 'form_library',
        document_id: documentId,
        form_name: chosen.name,
        transaction_id: tx.id,
        property_address: tx.property_address || null,
      };
    } catch (err) {
      console.error('[form-library-tools] attach failed:', err.message);
      return { ok: false, error: 'could not attach that form' };
    }
  }

  // Not in the Form Library — fall back to the member's own stored forms
  // (My Standard Documents / My Forms) before giving up. See header comment.
  let memberForms;
  try {
    memberForms = await loadMemberForms(userId, formName);
  } catch (err) {
    console.error('[form-library-tools] member forms lookup failed:', err.message);
    memberForms = [];
  }

  if (!memberForms.length) {
    return {
      ok: false,
      not_found: true,
      error: `I don't have a form matching "${formName}" in the Form Library, and you don't have one saved under My Forms either. You can add your own copy under Documents → My Forms (or Settings → My Standard Documents) — once it's there I can attach and send it on any dossier.`,
    };
  }

  const chosenMemberForm = memberForms[0];
  try {
    const documentId = await attachMemberForm(userId, chosenMemberForm, tx.id);
    return {
      ok: true,
      source: 'member_form',
      document_id: documentId,
      form_name: chosenMemberForm.label,
      transaction_id: tx.id,
      property_address: tx.property_address || null,
    };
  } catch (err) {
    console.error('[form-library-tools] attach failed:', err.message);
    return { ok: false, error: 'could not attach that form' };
  }
}

module.exports = { FORM_LIBRARY_TOOLS, FORM_LIBRARY_TOOL_NAMES, executeFormLibraryTool, FormLibrarySecurityError };
