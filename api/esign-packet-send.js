// Vercel Serverless Function: /api/esign-packet-send
//
// Two-phase preview/send wrapper that lets Dossie's chat surface (and the
// dossie-app.jsx document tile "Send for sig." action) reach real
// e-signature sending without a second, parallel send implementation.
// mode='send' calls straight into api/esign-create.js's own handler
// in-process — every DocuSeal submission this endpoint ever creates goes
// through THAT code (field placement, the contract-election gate, the
// blank-send gate, the signature_requests row). Nothing here re-implements
// any of it.
//
// POST body:
//   mode                 'preview' (default) | 'send'
//   document_ids          required, array of documents table ids. All must
//                          belong to the SAME transaction and to the caller.
//   recipient_role         optional override (see api/_lib/packet-recipients.js
//                          ROLE_DEFS). Default is the member's OWN client —
//                          buyer or seller, whichever side the dossier says
//                          the member represents. The opposing principal can
//                          never be resolved here, same gate as
//                          send-compliance-packet.js.
//   message                optional cover note, forwarded to DocuSeal
//   confirmation_token     required when mode='send' — issued by the preview
//                          call, verified against a digest of the SAME
//                          recipients + document set + message (see
//                          api/_lib/packet-recipients.js — the same
//                          preview/send-with-a-signed-digest pattern
//                          send-compliance-packet.js uses, reused directly
//                          rather than re-invented here).
//
// mode='preview' resolves signers + documents and creates NOTHING. A spoken
// sentence must never be sufficient to put a signature request in a real
// client's inbox — the confirmation card's own button is the only path to
// mode='send', and that path always carries a fresh token from the preview
// it is confirming.
//
// Authorization: Bearer <supabase user JWT>
//
// Owner: Carter, 2026-09-21.

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  checkRateLimit: checkIpRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { applyCorsHeaders } = require('./_middleware/cors');
const {
  ROLE_DEFS,
  memberSide,
  resolveRoleRecipients,
  issueConfirmationToken,
  verifyConfirmationToken,
} = require('./_lib/packet-recipients');
const esignCreateHandler = require('./esign-create');
// Real field counts, not a separate estimate — the exact same
// buildPacketDocEntry() call the actual send makes. See that function's own
// header comment in api/esign-create.js.
const { computePacketFieldCounts } = require('./esign-create');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_PACKET_DOCUMENTS = 10;
const EXCLUDED_DOC_TYPES = new Set(['signed', 'signing_certificate', 'executed']);

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
      ...(opts.headers || {}),
    },
  });
}

// Loads every requested document, proving each belongs to the caller AND to
// the SAME transaction — a mixed-transaction packet is refused rather than
// silently sent under whichever transaction happened to load first.
async function loadOwnedDocuments(documentIds, userId) {
  const idList = documentIds.map((id) => `"${id}"`).join(',');
  const r = await supa(
    `documents?id=in.(${idList})&user_id=eq.${encodeURIComponent(userId)}` +
    `&select=id,file_name,document_type,status,transaction_id`
  );
  if (!r.ok) throw new Error(`documents fetch failed: ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length !== documentIds.length) {
    throw new ValidationError('One or more of those documents were not found on your account.', 404);
  }
  const txIds = new Set(rows.map((d) => d.transaction_id));
  if (txIds.size !== 1 || !rows[0].transaction_id) {
    throw new ValidationError('Those documents are not all on the same dossier — send them separately.');
  }
  const unsendable = rows.find((d) => EXCLUDED_DOC_TYPES.has(String(d.document_type || '')));
  if (unsendable) {
    throw new ValidationError(`${unsendable.file_name || 'That document'} is already an executed/signed copy — it can't be sent for signature again.`);
  }
  // Preserve the caller's requested order, not the DB's arbitrary return order.
  const byId = new Map(rows.map((d) => [d.id, d]));
  return documentIds.map((id) => byId.get(id));
}

async function loadTransaction(transactionId, userId) {
  const r = await supa(
    `transactions?id=eq.${encodeURIComponent(transactionId)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );
  if (!r.ok) throw new Error(`transactions fetch failed: ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows[0]) throw new ValidationError('That dossier could not be found.', 404);
  return rows[0];
}

async function loadProfile(userId) {
  const r = await supa(`profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,email,brokerage,compliance_email&limit=1`);
  const rows = r.ok ? await r.json().catch(() => []) : [];
  return (Array.isArray(rows) && rows[0]) || {};
}

// Default signer role: the member's OWN client, never the opposing
// principal — resolveRoleRecipients enforces that by construction (a
// principal role only resolves when it matches memberSide(tx)).
function defaultOwnClientRole(tx) {
  const side = memberSide(tx);
  if (side === 'listing') return 'seller';
  if (side === 'buyer') return 'buyer';
  return null;
}

function docusealRoleLabel(baseLabel, index) {
  return index === 0 ? `${baseLabel} 1` : `${baseLabel} ${index + 1}`;
}

// Flattens computePacketFieldCounts()'s per-document/per-role shape into the
// list the confirmation-token digest signs — see packet-recipients.js's
// packetDigest for why counts belong in the digest at all.
function flattenCountsForDigest(perDocumentCounts) {
  const out = [];
  for (const doc of perDocumentCounts) {
    for (const [role, c] of Object.entries(doc.counts || {})) {
      out.push({
        document_id: doc.document_id, role,
        signatures: c.signatures, dates: c.dates, initials: c.initials,
      });
    }
  }
  return out;
}

// Collapses per-document/per-role counts into the single flat object
// SignatureConfirmCard.jsx renders ({signatures, dates, initials,
// executed_block}). This is a SUM of the same real numbers computed above —
// never a separately-estimated figure, so what the member sees cannot drift
// from what computePacketFieldCounts (and therefore the send path) actually
// found.
function aggregateCountsForCard(perDocumentCounts) {
  const totals = { signatures: 0, dates: 0, initials: 0, executed_block: false };
  for (const doc of perDocumentCounts) {
    if (doc.form_type === 'resale_contract') totals.executed_block = true;
    for (const c of Object.values(doc.counts || {})) {
      totals.signatures += c.signatures;
      totals.dates += c.dates;
      totals.initials += c.initials;
    }
  }
  return totals;
}

// Runs the real, shared field-count computation and refuses (throwing
// ValidationError, same shape every other gate in this file throws) the
// instant any document/signer pairing is unsafe. Called from BOTH preview
// and send — "the server refuses, not just the client": a caller that skips
// the confirmation card entirely and calls mode:'send' directly still hits
// this before a token is ever honored.
function computeCountsOrRefuse(docs, signers) {
  const result = computePacketFieldCounts({ documents: docs, signers, callerFields: [] });
  if (!result.ok) {
    throw new ValidationError(result.error, result.status || 422);
  }
  return result.documents;
}

// Invokes api/esign-create.js's real handler in-process — no parallel send
// path. Builds a minimal req/res pair carrying only what that handler reads.
async function callEsignCreate({ authorization, documentIds, signers, message }) {
  let statusCode = 200;
  let body = null;
  const innerReq = {
    method: 'POST',
    headers: { authorization: authorization || '' },
    body: { documentIds, signers, message },
  };
  const innerRes = {
    status(code) { statusCode = code; return innerRes; },
    json(payload) { body = payload; return innerRes; },
    setHeader() { return innerRes; },
    end() { return innerRes; },
  };
  await esignCreateHandler(innerReq, innerRes);
  return { statusCode, body };
}

const TOKEN_ERROR_MESSAGES = {
  expired: 'That signature request timed out — look it over again before sending.',
  packet_changed: 'Something about this changed since you approved it — look it over again before sending.',
  malformed: 'That confirmation was not valid — look it over again before sending.',
  bad_signature: 'That confirmation was not valid — look it over again before sending.',
  unconfigured: 'Signature confirmation is not configured on this server.',
};

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') { res.status(corsAllowed ? 204 : 403).end(); return; }
  if (!corsAllowed) { res.status(403).json({ ok: false, error: 'Origin not allowed.' }); return; }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Service not configured.' });
  }

  try {
    const ip = clientIpFromReq(req);
    await checkIpRateLimit(ip, 'esign-packet-send', 20, 60 * 60 * 1000);

    const { userId } = await verifySupabaseToken(req);
    const body = req.body || {};
    const mode = body.mode === 'send' ? 'send' : 'preview';
    const documentIds = Array.isArray(body.document_ids)
      ? body.document_ids.map((id) => sanitizeString(id, { maxLength: 200 })).filter(Boolean)
      : [];
    const message = body.message ? sanitizeString(body.message, { maxLength: 1000 }) : null;
    const roleOverride = body.recipient_role ? sanitizeString(body.recipient_role, { maxLength: 50 }) : null;

    if (!documentIds.length) throw new ValidationError('document_ids is required.');
    if (new Set(documentIds).size !== documentIds.length) {
      throw new ValidationError('The same document appears more than once.');
    }
    if (documentIds.length > MAX_PACKET_DOCUMENTS) {
      throw new ValidationError(`A signature request can carry at most ${MAX_PACKET_DOCUMENTS} documents.`);
    }

    const docs = await loadOwnedDocuments(documentIds, userId);
    const transactionId = docs[0].transaction_id;
    const tx = await loadTransaction(transactionId, userId);
    const profile = await loadProfile(userId);

    const role = roleOverride || defaultOwnClientRole(tx);
    if (!role) {
      throw new ValidationError(
        'This dossier does not say which side you represent, so I will not send this for signature. Set the side on the dossier and ask me again.'
      );
    }
    const resolved = resolveRoleRecipients({ tx, profile, role });
    if (!resolved.ok) {
      const status = resolved.blocked ? 403 : 400;
      return res.status(status).json({ ok: false, error: resolved.error, blocked: resolved.blocked || null });
    }

    const def = ROLE_DEFS[role];
    const signers = resolved.recipients.map((r, i) => ({
      name: r.name || r.email,
      email: r.email,
      role: docusealRoleLabel(def.label, i),
    }));

    // Real per-document/per-signer field counts — computed (and the packet
    // refused on any unsafe pairing) in BOTH modes, from the same call. A
    // mismatch throws ValidationError here and is caught by the handler's
    // outer try/catch, so preview and send refuse identically and neither
    // ever issues/honors a token for an unsignable or undated packet.
    const perDocumentCounts = computeCountsOrRefuse(docs, signers);
    const countsForDigest = flattenCountsForDigest(perDocumentCounts);
    const cardCounts = aggregateCountsForCard(perDocumentCounts);

    if (mode === 'preview') {
      const token = issueConfirmationToken({
        userId, transactionId, recipients: signers, subject: message || '', documentIds,
        counts: countsForDigest,
      });
      const who = signers.length === 1 ? (signers[0].name || signers[0].email) : `${signers.length} signers`;
      return res.status(200).json({
        ok: true,
        confirmation_token: token,
        transaction_id: transactionId,
        documents: docs.map((d) => {
          const detail = perDocumentCounts.find((p) => p.document_id === d.id);
          return { document_id: d.id, file_name: d.file_name, counts: (detail && detail.counts) || {} };
        }),
        signers: signers.map((s) => ({ name: s.name, email: s.email, role: s.role })),
        message: message || null,
        counts: cardCounts,
        counts_sentence: `${docs.length} document${docs.length === 1 ? '' : 's'} to ${who}, `
          + `${cardCounts.signatures} signature${cardCounts.signatures === 1 ? '' : 's'}, `
          + `${cardCounts.dates} date${cardCounts.dates === 1 ? '' : 's'}, `
          + `${cardCounts.initials} initial${cardCounts.initials === 1 ? '' : 's'}`,
      });
    }

    // ------------------------------------------------------------- send
    const token = body.confirmation_token;
    if (!token) throw new ValidationError('confirmation_token is required to send.');
    // Verified against counts RE-DERIVED just above, not counts carried in
    // the request body (there aren't any — the client only ever echoes
    // document_ids/message/token). If the underlying documents changed
    // between preview and send, countsForDigest differs from what the token
    // was issued against, the digest no longer matches, and this is a
    // 'packet_changed' rejection — the exact replay this digest exists to
    // catch.
    const verify = verifyConfirmationToken(token, {
      userId, transactionId, recipients: signers, subject: message || '', documentIds,
      counts: countsForDigest,
    });
    if (!verify.ok) {
      return res.status(409).json({ ok: false, error: TOKEN_ERROR_MESSAGES[verify.reason] || 'That confirmation was not valid.' });
    }

    const inner = await callEsignCreate({
      authorization: req.headers.authorization || req.headers.Authorization || '',
      documentIds,
      signers: signers.map((s) => ({ name: s.name, email: s.email, role: s.role })),
      message: message || undefined,
    });

    if (inner.statusCode !== 200 || !inner.body || inner.body.ok === false) {
      return res.status(inner.statusCode || 500).json({
        ok: false,
        error: (inner.body && inner.body.error) || 'That signature request could not be sent.',
      });
    }

    return res.status(200).json({
      ok: true,
      submission_id: inner.body.submissionId || null,
      signature_request_id: inner.body.signatureRequestId || null,
      sent_to: signers.map((s) => ({ name: s.name, email: s.email })),
    });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: 'Too many signature requests right now — try again shortly.' });
    }
    console.error('[esign-packet-send] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not prepare that signature request. Try again.' });
  }
};
