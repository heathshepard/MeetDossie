'use strict';

// api/_lib/transaction-send-gate.js
//
// Gate 1 + Gate 2 — docs/DOSSIE-TRANSACTION-AGENT-SPEC.md §3.
//
// The single checkpoint any OUTBOUND recipient (a real email send, an
// e-sign-invite signer) must pass before api/send-email.js or
// api/esign-create.js is allowed to use it. Confirmed by reading both files
// on 2026-10-01: neither had any check on recipient identity at all — a
// member could ask Dossie to email or e-sign-invite anyone, and it would.
//
// This is not a new design — it is api/_lib/packet-recipients.js's existing,
// already-proven opposing-principal blocklist (the module
// api/esign-packet-send.js and api/send-compliance-packet.js already gate
// through), wired into the two places that skip it, plus the two checks
// that module does not do on its own:
//
//   1. GATE 1 — "parties come from the executed contract only"
//      (feedback_parties-come-from-the-executed-contract.md). If a
//      contract-type document exists on the transaction, exactly one copy
//      must be marked executed (documents.executed_at) before this gate
//      will trust the transaction row's buyer/seller/agent columns at all.
//      Zero or more than one such document refuses outright — a near-match
//      is evidence of the WRONG document, not the right one.
//
//   2. FAIL CLOSED ON UNKNOWN SIDE — packet-recipients.js's hand-typed-
//      address check (assertNotOpposingPrincipal) returns an EMPTY
//      blocklist when memberSide(tx) can't be determined, which is the
//      correct behavior for THAT module (nothing to check a role against)
//      but is fail-OPEN for a raw address a model produced with no human
//      review. A gate that is supposed to fail closed on ambiguity cannot
//      rely on a helper that fails open on the same ambiguity — so this
//      refuses outright whenever the side is unknown AND the deal already
//      has a buyer or seller of record (nothing to protect if no parties
//      are on file yet, e.g. a brand-new listing).
//
// Every refusal is a plain, member-facing sentence. This runs server-side,
// after the model has already committed to a to_email / signer list — a
// member saying "just send it anyway" has nothing to talk around, because
// the refusal never runs inside the conversation at all.
//
// Owner: Carter, 2026-10-01.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same convention used across this codebase today (contract-extraction-
// tools.js, inbox-tools.js Phase 3/4c): document_type === 'trec-20-17' marks
// "this is the 1-4 family contract." Reused here, not reinvented.
const CONTRACT_DOCUMENT_TYPE = 'trec-20-17';

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

// GATE 1 — zero or more than one executed contract on the transaction means
// the transaction's own party/price/agent columns cannot be trusted yet.
async function resolveExecutedContractStatus(userId, transactionId) {
  const { ok, data } = await sbGet(
    `documents?select=id,file_name,executed_at`
    + `&transaction_id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + `&document_type=eq.${encodeURIComponent(CONTRACT_DOCUMENT_TYPE)}`,
  );
  if (!ok) return { ok: false, reason: 'lookup_failed' };
  const rows = Array.isArray(data) ? data : [];
  // No contract on file at all is a legitimate pre-contract state (a fresh
  // listing with no buyer yet) — nothing here to trace to, so nothing to
  // refuse on this gate.
  if (rows.length === 0) return { ok: true, document: null };
  const executed = rows.filter((d) => d && d.executed_at);
  if (executed.length === 0) return { ok: false, reason: 'no_executed_contract' };
  if (executed.length > 1) return { ok: false, reason: 'ambiguous_contract' };
  return { ok: true, document: executed[0] };
}

async function loadTransactionForGate(userId, transactionId) {
  const { ok, data } = await sbGet(
    `transactions?id=eq.${encodeURIComponent(transactionId)}`
    + `&user_id=eq.${encodeURIComponent(userId)}`
    + `&select=id,role,transaction_type,buyer_name,buyer_email,buyer2_name,buyer2_email,`
    + `seller_name,seller_email,seller2_name,seller2_email,parties&limit=1`,
  );
  if (!ok) return null;
  return Array.isArray(data) && data[0] ? data[0] : null;
}

const CONTRACT_GATE_MESSAGES = {
  no_executed_contract:
    "This dossier's contract on file isn't confirmed executed yet, so I won't use it to identify who to send to. Confirm the signed contract first and ask me again.",
  ambiguous_contract:
    "This dossier has more than one contract on file and none is flagged as the single executed copy — I won't guess which one is real. Tell me which one is the signed contract first.",
  lookup_failed:
    "I couldn't confirm this dossier's contract status just now — try again in a moment.",
};

/**
 * The one checkpoint every outbound send / e-sign invite must pass before an
 * address is used as a real recipient.
 *
 * @param {object} args
 * @param {string} args.userId          verified-session user id
 * @param {string|null} args.transactionId
 * @param {string} args.email           the candidate recipient / signer address
 * @param {object} [args.tx]            an already-loaded transaction row
 *                                       (e.g. api/esign-create.js's
 *                                       getFullTransactionRow result) — when
 *                                       provided, this skips its own
 *                                       transactions fetch and reuses it, so
 *                                       callers that already loaded the row
 *                                       for prefill don't pay for it twice.
 * @returns {Promise<{ok:true}|{ok:false,status:number,blocked:string,error:string}>}
 */
async function gateOutboundRecipient({ userId, transactionId, email, tx: providedTx }) {
  if (!transactionId || !email) {
    // No deal context (or nothing to check) — there is no represented party
    // to protect here. send-email.js's own validation already requires a
    // syntactically valid address; esign-create.js's own validation already
    // requires a name — this gate is purely about identity, not format.
    return { ok: true };
  }

  const contractStatus = await resolveExecutedContractStatus(userId, transactionId);
  if (!contractStatus.ok) {
    return {
      ok: false,
      status: 422,
      blocked: contractStatus.reason,
      error: CONTRACT_GATE_MESSAGES[contractStatus.reason] || CONTRACT_GATE_MESSAGES.lookup_failed,
    };
  }

  const tx = providedTx || await loadTransactionForGate(userId, transactionId);
  if (!tx) {
    return {
      ok: false,
      status: 404,
      blocked: 'transaction_not_found',
      error: 'That dossier could not be verified on your account.',
    };
  }

  // Lazily required — avoids a load-time dependency cycle risk and keeps
  // this module importable on its own for tests.
  const { memberSide, assertNotOpposingPrincipal } = require('./packet-recipients');

  const side = memberSide(tx);
  const hasAnyPartyOnFile = Boolean(tx.buyer_email || tx.buyer2_email || tx.seller_email || tx.seller2_email);
  if (!side && hasAnyPartyOnFile) {
    return {
      ok: false,
      status: 422,
      blocked: 'side_unknown',
      error:
        "This dossier does not say which side you represent, so I can't confirm this address isn't the other side's client. Set the side on the dossier and ask me again.",
    };
  }

  const check = assertNotOpposingPrincipal({ tx, email });
  if (!check.ok) {
    return {
      ok: false,
      status: 403,
      blocked: check.blocked || 'opposing_principal',
      error: check.error,
    };
  }

  return { ok: true };
}

module.exports = {
  gateOutboundRecipient,
  resolveExecutedContractStatus,
  loadTransactionForGate,
  CONTRACT_DOCUMENT_TYPE,
};
