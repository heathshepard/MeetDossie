// Vercel Serverless Function: /api/seller-intake
//
// The listing-appointment seller intake — the facts that turn a net sheet from
// a set of plausible numbers into a narrow estimate with its sources named.
//
// GET  ?transaction_id=<id>
//   -> { ok, intake, completeness, questions, derived }
//      `questions` is the field spec (label / type / options / why), so the
//      capture UI and the chat tool ask the SAME questions in the SAME words
//      without either of them hardcoding a list that drifts.
//      `derived` previews which net sheet lines the current answers resolve
//      and which are still unconfirmed — that is what lets the dossier show
//      "4 costs unconfirmed" before an offer ever arrives.
//
// PUT  { transaction_id, ...answers }
//   -> upsert. Partial by design: a listing appointment is a conversation, not
//      a form submission, and an agent who learns the HOA name in month two
//      should not have to re-answer month one.
//
// Authorization: Bearer <supabase user JWT>
//
// MULTI-TENANCY. `transactions` is shared by every Dossie customer and this
// row holds a seller's payoff balance and tax exposure. Every query here is
// filtered by the authenticated user_id, and every write first proves the
// transaction belongs to that user — the request body's transaction_id is
// attacker-controlled and is never trusted on its own. The DB trigger added in
// supabase/migrations/20260920_seller_intake.sql enforces the same invariant a
// second time, because this endpoint is not guaranteed to be the only writer
// forever.
//
// Owner: 2026-09-20.

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const {
  FIELDS, FIELDS_BY_KEY, FIELD_KEYS,
  deriveNetSheetInputs, intakeCompleteness,
} = require('./_lib/seller-intake-fields');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseRest(pathPart, init) {
  return fetch(SUPABASE_URL + '/rest/v1/' + pathPart, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      ...((init && init.headers) || {}),
    },
  });
}

// Proves the transaction exists AND belongs to this user. Returns the row, or
// throws. Never leaks whether a foreign transaction_id exists — a 404 for
// "not yours" and "not real" is the same 404 on purpose.
async function requireOwnedTransaction(transactionId, userId) {
  const resp = await supabaseRest(
    'transactions?id=eq.' + encodeURIComponent(transactionId) +
    '&user_id=eq.' + encodeURIComponent(userId) +
    '&select=id,property_address,seller_name,closing_date,sale_price&limit=1',
    { method: 'GET' },
  );
  if (!resp.ok) throw new Error('transaction lookup failed: ' + resp.status);
  const rows = await resp.json();
  const tx = Array.isArray(rows) ? rows[0] : null;
  if (!tx) throw new ValidationError('No such dossier.', 404);
  return tx;
}

// ---------------------------------------------------------------------------
// Coercion. Driven off the field spec, so a field added to
// api/_lib/seller-intake-fields.js is accepted here without a second edit —
// and a key NOT in the spec is silently dropped rather than written through.
// ---------------------------------------------------------------------------
function coerce(field, raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;

  switch (field.type) {
    case 'money': {
      const n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
      if (!Number.isFinite(n)) throw new ValidationError(field.key + ' must be a number.');
      if (n < 0) throw new ValidationError(field.key + ' cannot be negative.');
      return n;
    }
    case 'int': {
      const n = parseInt(String(raw).replace(/[^0-9\-]/g, ''), 10);
      if (!Number.isFinite(n)) throw new ValidationError(field.key + ' must be a whole number.');
      return n;
    }
    case 'bool': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['true', 'yes', '1'].includes(s)) return true;
      if (['false', 'no', '0'].includes(s)) return false;
      throw new ValidationError(field.key + ' must be yes or no.');
    }
    case 'date': {
      const s = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValidationError(field.key + ' must be YYYY-MM-DD.');
      return s;
    }
    case 'enum': {
      const s = String(raw);
      if (!field.options.includes(s)) {
        throw new ValidationError(field.key + ' must be one of: ' + field.options.join(', '));
      }
      return s;
    }
    case 'enum[]': {
      const arr = Array.isArray(raw) ? raw : String(raw).split(',').map((s) => s.trim());
      for (const v of arr) {
        if (!field.options.includes(v)) {
          throw new ValidationError(field.key + ' contains an unknown value: ' + v);
        }
      }
      return arr;
    }
    case 'json': {
      let val = raw;
      if (typeof val === 'string') {
        try { val = JSON.parse(val); } catch (e) { throw new ValidationError(field.key + ' must be valid JSON.'); }
      }
      if (!Array.isArray(val)) throw new ValidationError(field.key + ' must be a list.');
      // Bound it — this is free-form and goes straight into JSONB.
      if (val.length > 25) throw new ValidationError(field.key + ' has too many entries.');
      return val;
    }
    default:
      return sanitizeString(raw, { maxLength: 500 });
  }
}

function buildPatch(body) {
  const patch = {};
  for (const key of FIELD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const coerced = coerce(FIELDS_BY_KEY[key], body[key]);
    if (coerced !== undefined) patch[key] = coerced;
  }
  if (Object.prototype.hasOwnProperty.call(body, 'notes')) {
    patch.notes = sanitizeString(body.notes, { maxLength: 4000 });
  }
  if (body.captured_via && ['listing_appointment', 'chat', 'form', 'import'].includes(body.captured_via)) {
    patch.captured_via = body.captured_via;
  }
  return patch;
}

// The question set the capture UI and the chat tool both read, so they cannot
// drift apart. `why` is included deliberately: an agent who knows WHY they are
// asking about a T-47 asks it better than one reading a field label.
function questionSet() {
  return FIELDS.map((f) => ({
    key: f.key, label: f.label, type: f.type, group: f.group,
    options: f.options || null, why: f.why, feeds: f.feeds || null,
  }));
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'GET, PUT, POST, OPTIONS' });
  if (req.method === 'OPTIONS') { res.status(corsAllowed ? 204 : 403).end(); return; }
  if (!corsAllowed) { res.status(403).json({ ok: false, error: 'Origin not allowed.' }); return; }
  if (!['GET', 'PUT', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, PUT, POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Server not configured.' });
    return;
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const transactionId = sanitizeString(
      req.method === 'GET' ? (req.query && req.query.transaction_id) : body.transaction_id,
      { maxLength: 200 },
    );
    if (!transactionId) throw new ValidationError('transaction_id is required.');

    const tx = await requireOwnedTransaction(transactionId, userId);

    // ---------------------------------------------------------------- GET
    if (req.method === 'GET') {
      const resp = await supabaseRest(
        'seller_intake?transaction_id=eq.' + encodeURIComponent(transactionId) +
        '&user_id=eq.' + encodeURIComponent(userId) + '&limit=1',
        { method: 'GET' },
      );
      const rows = resp.ok ? await resp.json() : [];
      const intake = Array.isArray(rows) && rows[0] ? rows[0] : null;
      const derived = deriveNetSheetInputs(intake, { closingDate: tx.closing_date });

      return res.status(200).json({
        ok: true,
        intake,
        completeness: intakeCompleteness(intake),
        questions: questionSet(),
        derived: {
          values: derived.values,
          sources: derived.sources,
          labels: derived.labels,
          notes: derived.notes,
          unconfirmed: Object.keys(derived.sources).filter((k) => derived.sources[k] === 'not_confirmed'),
        },
      });
    }

    // ------------------------------------------------------------ PUT/POST
    const patch = buildPatch(body);
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Nothing to save — no recognized intake fields in the request.');
    }
    patch.transaction_id = transactionId;
    patch.user_id = userId;           // ALWAYS the token's user, never the body's.
    patch.captured_at = new Date().toISOString();
    patch.updated_at = new Date().toISOString();

    // Upsert on the UNIQUE(transaction_id) constraint. merge-duplicates keeps
    // answers from earlier sessions that this call did not mention — intake is
    // cumulative, because the HOA management company's fee schedule arrives
    // three weeks after the listing appointment.
    const up = await supabaseRest('seller_intake?on_conflict=transaction_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([patch]),
    });

    if (!up.ok) {
      const detail = await up.text();
      console.error('[seller-intake] upsert failed:', up.status, detail);
      // The cross-tenant trigger raises insufficient_privilege. If that ever
      // fires, the request got past the ownership check above, which would be
      // a real bug — say so loudly rather than returning a generic 500.
      if (detail.includes('transaction owner does not match')) {
        return res.status(403).json({ ok: false, error: 'That dossier is not yours.' });
      }
      return res.status(500).json({ ok: false, error: 'Could not save the seller intake.' });
    }

    const saved = (await up.json())[0] || null;
    const derived = deriveNetSheetInputs(saved, { closingDate: tx.closing_date });

    return res.status(200).json({
      ok: true,
      intake: saved,
      completeness: intakeCompleteness(saved),
      derived: {
        values: derived.values, sources: derived.sources,
        labels: derived.labels, notes: derived.notes,
        unconfirmed: Object.keys(derived.sources).filter((k) => derived.sources[k] === 'not_confirmed'),
      },
    });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[seller-intake] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not load the seller intake. Try again.' });
  }
};
