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
      'Attach a blank form from the Form Library to a dossier as a new document, ready to fill. Use when the agent says anything like: attach the [form] to this file, add the HOA addendum, pull in the lead paint addendum, get me the [TREC number] form on this deal. Use list_form_library first if you are not sure of the exact form name.',
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
  if (!forms.length) {
    return { ok: false, error: `I don't have a form matching "${formName}" that I can attach today.` };
  }
  const chosen = forms[0];

  try {
    const { documentId } = await attachFormTemplate(userId, chosen.id, tx.id);
    return {
      ok: true,
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

module.exports = { FORM_LIBRARY_TOOLS, FORM_LIBRARY_TOOL_NAMES, executeFormLibraryTool, FormLibrarySecurityError };
