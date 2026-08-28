// api/_lib/seller-disclosure-check.js
//
// TREC 20-19 ¶7B (Seller's Disclosure Notice) verification — productized
// version of the manual check Cole/Heath ran on a real offer 2026-08-27:
// before a contract can say "Buyer has received the Seller's Disclosure
// Notice," Dossie actually looks for the document instead of trusting a
// default.
//
// Called at the one real trigger point that matters — the moment a
// transaction's resale contract is being filled (api/fill-form.js,
// resolvedFormType === 'resale-contract') — so this runs for every
// subscriber's every buyer-side deal, not just Heath's.
//
// Contract with the caller:
//   1. If the agent already told Dossie the answer (transactions.
//      sellers_disclosure_received_at is set — the timestamp api/chat.js's
//      natural-language extraction writes when an agent says "seller's
//      disclosure received"), that human decision is FINAL. Never overridden.
//      (Not transactions.sdn_received alone — that column is `NOT NULL
//      DEFAULT false`, so `false` is indistinguishable from "never touched.")
//   2. Otherwise, look for a real Seller's Disclosure document attached to
//      this transaction (documents.document_type IN
//      ('sellers_disclosure','trec-sellers-disclosure')).
//        - Found  -> auto-check received=true, persist it to the
//          transaction (so this is a one-time determination, not a
//          re-fetch every render), cite the document.
//        - Missing -> leave the field alone (fill-trec-20-19.js's own rule
//          is "never guess a legally material field" — undefined means
//          NEITHER ¶7B checkbox gets marked), and raise a Dossie Ask with a
//          DRAFT email to the listing agent. The draft never sends itself —
//          suggested_actions carries the draft inline (to/subject/body) and
//          api/dossie-ask-respond.js only sends it when the subscriber
//          clicks the button.
//
// Never runs for the listing side of a deal (role === 'listing') — a
// listing agent doesn't need to email themselves for their own seller's
// disclosure.
//
// Owner: Carter, 2026-08-27.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SDN_DOCUMENT_TYPES = ['sellers_disclosure', 'trec-sellers-disclosure'];
const SDN_MISSING_ASK_SOURCE = 'system:sdn-missing';

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function dealLabel(address) {
  if (!address || typeof address !== 'string') return 'this deal';
  return address.split(',')[0].trim();
}

function draftDisclosureRequestEmail({ address, listingAgentName, buyerName }) {
  const label = dealLabel(address);
  const greeting = listingAgentName ? `Hi ${String(listingAgentName).split(' ')[0]},` : 'Hi,';
  const subject = `Seller's Disclosure Notice — ${label}`;
  const body = [
    greeting,
    '',
    `I don't have the Seller's Disclosure Notice on file yet for ${address || label}` +
      (buyerName ? ` (Buyer: ${buyerName}).` : '.'),
    "Could you send it over when you have a chance? I need it on file before we can mark paragraph 7B as received on the contract.",
    '',
    'Thanks,',
  ].join('\n');
  return { subject, body };
}

/**
 * @param {object} tx a transactions row — must include at least:
 *   id, user_id, property_address, role, sdn_received,
 *   listing_agent_name, listing_agent_email_addr, buyer_name
 * @returns {Promise<{
 *   received: boolean|undefined,   // value to feed fv.seller_disclosure_received
 *                                  // (undefined = leave both ¶7B checkboxes blank)
 *   source: 'manual'|'document'|'missing',
 *   documentId?: string, fileName?: string,
 *   askId?: string, askCreated?: boolean,
 * }>}
 */
async function checkSellerDisclosure(tx) {
  if (!tx || !tx.id) return { received: undefined, source: 'missing' };

  // Rule 1 — an explicit human answer always wins, never re-derived.
  //
  // NOT `tx.sdn_received === false` here — confirmed live 2026-08-27:
  // `sdn_received` is `boolean NOT NULL DEFAULT false`, so `false` is
  // indistinguishable from "nobody has ever looked at this," not a real
  // decision. The one signal that IS a real human determination is
  // `sellers_disclosure_received_at` — the timestamp api/chat.js's
  // natural-language extraction sets when an agent actually says "seller's
  // disclosure received" (chat.js:641). This function also stamps that same
  // column when IT determines the document is on file (below), so a repeat
  // call short-circuits here instead of re-querying documents every time.
  if (tx.sellers_disclosure_received_at) {
    return { received: Boolean(tx.sdn_received), source: 'manual' };
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    // Can't check documents without Supabase — fail safe (leave blank,
    // never guess "received").
    return { received: undefined, source: 'missing' };
  }

  // Rule 2 — look for the real document.
  const typeFilter = SDN_DOCUMENT_TYPES.map((t) => `"${t}"`).join(',');
  const docRes = await supabaseFetch(
    `/rest/v1/documents?select=id,file_name,status,uploaded_at` +
      `&transaction_id=eq.${encodeURIComponent(tx.id)}` +
      `&document_type=in.(${typeFilter})` +
      `&order=uploaded_at.desc.nullslast` +
      `&limit=5`,
  );
  // status='blank' means an unfilled template placeholder, not a real
  // document — filtered in JS (not PostgREST `not.eq`) because that operator
  // silently excludes NULL-status rows too, and most real uploads here have
  // a null status (verified live 2026-08-27: 8 of 11 real sellers_disclosure
  // rows have status=null, none have status='blank').
  const candidates = docRes.ok && Array.isArray(docRes.data) ? docRes.data : [];
  const doc = candidates.find((d) => d.status !== 'blank') || null;

  if (doc) {
    // Auto-check + persist so this is a one-time determination per
    // transaction, and so the Compliance Vault / other surfaces that read
    // sdn_received see it too.
    await supabaseFetch(
      `/rest/v1/transactions?id=eq.${encodeURIComponent(tx.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          sdn_received: true,
          sellers_disclosure_received_at: new Date().toISOString(),
        }),
      },
    );
    return { received: true, source: 'document', documentId: doc.id, fileName: doc.file_name };
  }

  // Missing. Never guess the checkbox — leave it blank (received: undefined)
  // and raise a Dossie Ask with a DRAFT (never auto-sent) request to the
  // listing agent, unless this transaction IS the listing side (no one to
  // email) or an open ask already exists (idempotent).
  if (tx.role === 'listing') {
    return { received: undefined, source: 'missing' };
  }

  const existing = await supabaseFetch(
    `/rest/v1/dossie_asks?select=id` +
      `&transaction_id=eq.${encodeURIComponent(tx.id)}` +
      `&source=eq.${encodeURIComponent(SDN_MISSING_ASK_SOURCE)}` +
      `&status=in.(open,snoozed)&limit=1`,
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    return { received: undefined, source: 'missing', askId: existing.data[0].id, askCreated: false };
  }

  const listingAgentEmail = tx.listing_agent_email_addr || null;
  const draft = draftDisclosureRequestEmail({
    address: tx.property_address,
    listingAgentName: tx.listing_agent_name,
    buyerName: tx.buyer_name,
  });

  const suggestedActions = [];
  if (listingAgentEmail) {
    suggestedActions.push({
      id: 'send_sdn_request',
      label: 'Send request to listing agent',
      kind: 'primary',
      effect: 'send_email',
      email: {
        to: listingAgentEmail,
        subject: draft.subject,
        body: draft.body,
      },
    });
  }
  suggestedActions.push({
    id: 'sdn_not_needed',
    label: listingAgentEmail ? 'Skip for now' : 'Add listing agent email first',
    kind: 'secondary',
    effect: listingAgentEmail ? 'snooze' : 'reply',
  });

  // The full draft is quoted inline (not just summarized) so "review it and
  // send when ready" is a real review, not a blind click — the ask card has
  // no separate preview surface today.
  const bodyText = listingAgentEmail
    ? `I don't see the Seller's Disclosure Notice on file for ${tx.property_address || 'this deal'} yet, so I've left paragraph 7B unchecked. Here's a draft to ${tx.listing_agent_name || 'the listing agent'} (${listingAgentEmail}) — review it and send when ready. Subject: "${draft.subject}". ${draft.body.replace(/\n+/g, ' ').trim()}`
    : `I don't see the Seller's Disclosure Notice on file for ${tx.property_address || 'this deal'} yet, so I've left paragraph 7B unchecked. Add the listing agent's email to this dossier and I can draft a request for you.`;

  const insertRes = await supabaseFetch('/rest/v1/dossie_asks', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: tx.user_id,
      transaction_id: tx.id,
      urgency: 'high',
      title: `Seller's Disclosure Notice missing — ${dealLabel(tx.property_address)}`,
      body: bodyText,
      suggested_actions: suggestedActions,
      created_by: 'system',
      source: SDN_MISSING_ASK_SOURCE,
    }),
  });

  const created = insertRes.ok && Array.isArray(insertRes.data) ? insertRes.data[0] : null;
  return {
    received: undefined,
    source: 'missing',
    askId: created ? created.id : null,
    askCreated: Boolean(created),
  };
}

module.exports = {
  checkSellerDisclosure,
  draftDisclosureRequestEmail,
  SDN_DOCUMENT_TYPES,
  SDN_MISSING_ASK_SOURCE,
};
