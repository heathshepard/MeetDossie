// Vercel Serverless Function: /api/deal-inconsistencies
//
// The three steps of Heath's inconsistency flow, over HTTP.
//
//   GET  ?transactionId=<uuid>[&trigger=deal_open|document_gate][&columns=a,b]
//        STEP 1 — what disagrees on this deal that the member has not already
//        answered, worst first, with both values and their sources. Raising is
//        recorded so the same thing is not raised again tomorrow (see
//        _lib/inconsistency-flow.js "SURFACING IS NOT NAGGING").
//
//   POST { transactionId, conflictId, choice, value?, note? }
//        STEP 2 + STEP 3 — the member says which value is correct; the response
//        carries the remedy plan that follows from WHERE the wrong value lives.
//
// choice: 'dossier' | 'document' | 'same' | 'other' | 'not_now'
//
// NOTHING IS SENT FROM HERE. A dossier field may be corrected (that is a
// records change and it is ours to make). An amendment, a document re-send, or
// a notice to a title company are returned as PENDING work for the member to
// authorise — the endpoint never drafts or sends them as a side effect of
// answering a question.
//
// Authorization: Bearer <supabase user JWT>

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const {
  reviewDealInconsistencies,
  recordSurfaced,
  resolveInconsistency,
  CHOICE,
} = require('./_lib/inconsistency-flow-store');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || VERCEL_PREVIEW_RE.test(origin)) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

// The store half expects {ok, status, data}; the REST call gives a Response.
async function makeSb() {
  return async function sb(pathPart, init) {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/${pathPart}`, {
      ...init,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        ...((init && init.headers) || {}),
      },
    });
    let data = null;
    if (resp.status !== 204) data = await resp.json().catch(() => null);
    return { ok: resp.ok, status: resp.status, data };
  };
}

const VALID_TRIGGERS = new Set(['deal_open', 'document_gate', 'scan']);
const VALID_CHOICES = new Set(Object.values(CHOICE));

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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Server not configured.' });
    return;
  }

  try {
    const { userId } = await verifySupabaseToken(req);
    const sb = await makeSb();

    // -----------------------------------------------------------------------
    // GET — STEP 1: surface
    // -----------------------------------------------------------------------
    if (req.method === 'GET') {
      const transactionId = sanitizeString(req.query && req.query.transactionId, { maxLength: 200 });
      if (!transactionId) throw new ValidationError('transactionId query param required.');

      const triggerRaw = sanitizeString(req.query && req.query.trigger, { maxLength: 40 }) || 'deal_open';
      if (!VALID_TRIGGERS.has(triggerRaw)) {
        throw new ValidationError(`trigger must be one of: ${[...VALID_TRIGGERS].join(', ')}.`);
      }

      // At a document gate, only the fields that document actually uses are
      // relevant — asking about a title officer's phone while someone is
      // filling a price amendment is noise.
      const columnsRaw = sanitizeString(req.query && req.query.columns, { maxLength: 800 });
      const aboutToUseColumns = columnsRaw
        ? columnsRaw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 60)
        : null;

      const review = await reviewDealInconsistencies(sb, {
        userId, transactionId, trigger: triggerRaw, aboutToUseColumns,
      });
      if (!review.ok) {
        return res.status(404).json({ ok: false, error: 'Dossier not found.' });
      }

      // Record that we raised these, so tomorrow's deal-open is quiet. A ledger
      // write failure must not hide the conflict from the member, so it is
      // awaited for log fidelity but never allowed to fail the response.
      if (review.raise.length && triggerRaw !== 'document_gate') {
        try {
          await recordSurfaced(sb, { userId, transactionId, raised: review.raise });
        } catch (e) {
          console.error('[deal-inconsistencies] ledger write threw:', e && e.message);
        }
      }

      const blocking = review.raise.filter((r) => r.blocking);
      return res.status(200).json({
        ok: true,
        transaction: review.transaction,
        trigger: review.trigger,
        raise: review.raise,
        held: review.held,
        counts: {
          raised: review.raise.length,
          held: review.held.length,
          recorded_conflicts: review.recorded_conflicts,
          executed_documents: review.executed_documents,
        },
        // True only at a document gate with a high/critical unresolved conflict
        // on a field that document uses. Same shape as contract-election-gate:
        // stop, a human decides.
        blocks_document: triggerRaw === 'document_gate' && blocking.length > 0,
        blocking_conflict_ids: blocking.map((r) => r.conflict_id),
      });
    }

    // -----------------------------------------------------------------------
    // POST — STEP 2 (the member chooses) + STEP 3 (the remedy)
    // -----------------------------------------------------------------------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body && typeof body === 'object' ? body : {};

      const transactionId = sanitizeString(body.transactionId || body.transaction_id, { maxLength: 200 });
      if (!transactionId) throw new ValidationError('transactionId required.');

      // Either an explicit conflict id, or the column when the member answered
      // by voice about a mismatch that was just raised.
      const conflictId = sanitizeString(body.conflictId || body.conflict_id, { maxLength: 64 });
      const column = sanitizeString(body.column || body.field, { maxLength: 80 });
      if (!conflictId && !column) {
        throw new ValidationError('conflictId or field required.');
      }

      const choice = sanitizeString(body.choice, { maxLength: 30 });
      if (!VALID_CHOICES.has(choice)) {
        throw new ValidationError(`choice must be one of: ${[...VALID_CHOICES].join(', ')}.`);
      }

      // The member's own typed value ('other') or the legal spelling ('same').
      const value = body.value != null ? sanitizeString(body.value, { maxLength: 300 }) : null;
      const note = body.note != null ? sanitizeString(body.note, { maxLength: 1000 }) : null;

      if (choice === CHOICE.OTHER && !value) {
        throw new ValidationError('Pick "neither" and I need the correct value.');
      }

      const result = await resolveInconsistency(sb, {
        userId, transactionId, conflictId, column, choice, value, note,
      });

      if (!result.ok) {
        if (result.reason === 'deal_not_found_for_user') {
          return res.status(404).json({ ok: false, error: 'Dossier not found.' });
        }
        if (result.reason === 'conflict_not_found' || result.reason === 'conflict_not_specified') {
          return res.status(404).json({ ok: false, error: 'I no longer have that mismatch on file — reopen the deal and I will re-check.' });
        }
        if (result.reason === 'ambiguous_conflict') {
          // Refusing beats guessing: attributing the answer to the wrong
          // mismatch would record a decision the member never made, and on a
          // party name that decision is what does or does not trigger an
          // amendment.
          return res.status(409).json({
            ok: false,
            error: `There are ${result.count} open mismatches on ${result.column} — tell me which one you mean and I'll record it.`,
          });
        }
        if (result.reason === 'bad_choice') {
          return res.status(400).json({ ok: false, error: result.error });
        }
        return res.status(500).json({ ok: false, error: 'Could not record that answer. Try again.' });
      }

      return res.status(200).json({
        ok: true,
        resolved: result.resolved,
        conflict_id: result.conflict_id,
        column: result.column,
        choice: result.choice,
        correct_value: result.correct_value,
        headline: result.headline,
        summary: result.summary,
        remedies: result.remedies,
        // Already done — a dossier field correction and nothing else.
        applied: result.applied || [],
        // Still needs the member: amendments, document re-sends, third-party
        // notices. Returned as a plan; nothing here has happened.
        pending: result.pending || [],
      });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[deal-inconsistencies] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not check this file for mismatches. Try again.' });
  }
};
