// Vercel Serverless Function: /api/transaction-offers
// Offer comparison table for seller-side transactions (Block 11C)
//
// GET  ?transactionId=<uuid>          — list all offers for a transaction (active only)
// POST { transaction_id, buyer_name, offer_price, financing_type, down_payment_pct,
//        option_fee, option_days, earnest_money, closing_date, escalation_clause,
//        escalation_cap, notes }      — create an offer
// PATCH { id, status }               — update status: pending|accepted|rejected|countered
// DELETE ?id=<uuid>                  — archive an offer (soft delete)
//
// Authorization: Bearer <supabase user JWT>
//
// Changed 2026-09-21 (hard-delete sibling audit, priority 1): DELETE used to
// hard-delete the offer row. Now it sets archived_at and stops there — same
// pattern as documents.archived_at / transactions.archived_at. See
// supabase/migrations/20260921_transactions_and_offers_archive.sql.

const { sanitizeString, ValidationError } = require('./_middleware/validate');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

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
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

async function supabaseRest(pathPart, init) {
  const url = SUPABASE_URL + '/rest/v1/' + pathPart;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const VALID_STATUSES = new Set(['pending', 'accepted', 'rejected', 'countered', 'retired']);

// 'accepted' and 'retired' route through the atomic accept_offer/retire_offer
// Postgres functions (supabase/migrations/20260921_offers_model_accept_retire_functions.sql)
// instead of a plain field PATCH — see that migration's header for why a
// single RPC call is the correct atomicity boundary here. Every other status
// transition (pending/rejected/countered) never touched the transaction, so
// a plain PATCH is still correct for those.
async function supabaseRpc(fnName, args) {
  return supabaseRest('rpc/' + fnName, {
    method: 'POST',
    body: JSON.stringify(args),
  });
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Server not configured.' });
    return;
  }

  try {
    const { userId } = await verifySupabaseToken(req);
    const safeUid = encodeURIComponent(userId);

    // -------------------------------------------------------------------------
    // GET — list offers for a transaction
    // -------------------------------------------------------------------------
    if (req.method === 'GET') {
      const transactionId = sanitizeString(req.query && req.query.transactionId, { maxLength: 200 });
      if (!transactionId) throw new ValidationError('transactionId query param required.');

      // Verify user owns this transaction
      const txResp = await supabaseRest(
        'transactions?id=eq.' + encodeURIComponent(transactionId) + '&user_id=eq.' + safeUid + '&select=id&limit=1',
        { method: 'GET' },
      );
      const txRows = txResp.ok ? await txResp.json() : [];
      if (!Array.isArray(txRows) || !txRows[0]) {
        return res.status(404).json({ ok: false, error: 'Dossier not found.' });
      }

      const offersResp = await supabaseRest(
        'transaction_offers?transaction_id=eq.' + encodeURIComponent(transactionId) +
        '&archived_at=is.null&order=submitted_at.asc&select=*',
        { method: 'GET' },
      );
      if (!offersResp.ok) {
        const t = await offersResp.text().catch(() => '');
        // Column not there yet (migration hasn't run) — degrade instead of a
        // bare 500: fall back to the unfiltered list rather than break the
        // offer-compare table for every seller-side dossier.
        if (offersResp.status === 400 && /archived_at/.test(t)) {
          const fallbackResp = await supabaseRest(
            'transaction_offers?transaction_id=eq.' + encodeURIComponent(transactionId) +
            '&order=submitted_at.asc&select=*',
            { method: 'GET' },
          );
          if (fallbackResp.ok) {
            const offers = await fallbackResp.json();
            return res.status(200).json({ ok: true, offers: Array.isArray(offers) ? offers : [] });
          }
        }
        throw new Error('offers fetch failed (' + offersResp.status + '): ' + t.slice(0, 200));
      }
      const offers = await offersResp.json();
      return res.status(200).json({ ok: true, offers: Array.isArray(offers) ? offers : [] });
    }

    // -------------------------------------------------------------------------
    // POST — create an offer
    // -------------------------------------------------------------------------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};

      const transactionId = sanitizeString(body.transaction_id, { maxLength: 200 });
      if (!transactionId) throw new ValidationError('transaction_id is required.');

      // Verify ownership
      const txResp = await supabaseRest(
        'transactions?id=eq.' + encodeURIComponent(transactionId) + '&user_id=eq.' + safeUid + '&select=id&limit=1',
        { method: 'GET' },
      );
      const txRows = txResp.ok ? await txResp.json() : [];
      if (!Array.isArray(txRows) || !txRows[0]) {
        return res.status(404).json({ ok: false, error: 'Dossier not found.' });
      }

      const payload = {
        transaction_id: transactionId,
        user_id: userId,
        buyer_name: sanitizeString(body.buyer_name, { maxLength: 200 }) || null,
        offer_price: num(body.offer_price),
        financing_type: sanitizeString(body.financing_type, { maxLength: 100 }) || null,
        down_payment_pct: num(body.down_payment_pct),
        option_fee: num(body.option_fee),
        option_days: body.option_days != null ? parseInt(body.option_days, 10) || null : null,
        earnest_money: num(body.earnest_money),
        closing_date: sanitizeString(body.closing_date, { maxLength: 20 }) || null,
        escalation_clause: Boolean(body.escalation_clause),
        escalation_cap: num(body.escalation_cap),
        notes: sanitizeString(body.notes, { maxLength: 2000 }) || null,
        status: 'pending',
      };

      const createResp = await supabaseRest('transaction_offers', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      if (!createResp.ok) {
        const t = await createResp.text().catch(() => '');
        throw new Error('offer insert failed (' + createResp.status + '): ' + t.slice(0, 300));
      }
      const rows = await createResp.json();
      const offer = Array.isArray(rows) ? rows[0] : rows;
      return res.status(200).json({ ok: true, offer });
    }

    // -------------------------------------------------------------------------
    // PATCH — update offer status
    // -------------------------------------------------------------------------
    if (req.method === 'PATCH') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
      body = body || {};

      const offerId = sanitizeString(body.id, { maxLength: 200 });
      const newStatus = sanitizeString(body.status, { maxLength: 50 });
      if (!offerId) throw new ValidationError('id is required.');
      if (!newStatus || !VALID_STATUSES.has(newStatus)) {
        throw new ValidationError('status must be one of: pending, accepted, rejected, countered, retired.');
      }

      if (newStatus === 'accepted') {
        const rpcResp = await supabaseRpc('accept_offer', { p_offer_id: offerId, p_user_id: userId });
        if (!rpcResp.ok) {
          const t = await rpcResp.text().catch(() => '');
          if (/offer_already_accepted/.test(t)) {
            throw new ValidationError('This offer is already accepted.');
          }
          if (/offer_not_found|transaction_not_found/.test(t)) {
            return res.status(404).json({ ok: false, error: 'Offer or dossier not found.' });
          }
          throw new Error('accept_offer failed (' + rpcResp.status + '): ' + t.slice(0, 300));
        }
        const offerResp = await supabaseRest(
          'transaction_offers?id=eq.' + encodeURIComponent(offerId) + '&select=*',
          { method: 'GET' },
        );
        const offerRows = offerResp.ok ? await offerResp.json() : [];
        return res.status(200).json({ ok: true, offer: Array.isArray(offerRows) ? offerRows[0] : offerRows });
      }

      if (newStatus === 'retired') {
        const reason = sanitizeString(body.reason, { maxLength: 500 }) || null;
        const rpcResp = await supabaseRpc('retire_offer', { p_offer_id: offerId, p_user_id: userId, p_reason: reason });
        if (!rpcResp.ok) {
          const t = await rpcResp.text().catch(() => '');
          if (/offer_not_accepted/.test(t)) {
            throw new ValidationError('Only an accepted offer can be retired.');
          }
          if (/offer_not_found/.test(t)) {
            return res.status(404).json({ ok: false, error: 'Offer not found.' });
          }
          throw new Error('retire_offer failed (' + rpcResp.status + '): ' + t.slice(0, 300));
        }
        const offerResp = await supabaseRest(
          'transaction_offers?id=eq.' + encodeURIComponent(offerId) + '&select=*',
          { method: 'GET' },
        );
        const offerRows = offerResp.ok ? await offerResp.json() : [];
        return res.status(200).json({ ok: true, offer: Array.isArray(offerRows) ? offerRows[0] : offerRows });
      }

      const patchResp = await supabaseRest(
        'transaction_offers?id=eq.' + encodeURIComponent(offerId) + '&user_id=eq.' + safeUid,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ status: newStatus }),
        },
      );
      if (!patchResp.ok) {
        const t = await patchResp.text().catch(() => '');
        throw new Error('offer update failed (' + patchResp.status + '): ' + t.slice(0, 300));
      }
      const rows = await patchResp.json();
      const offer = Array.isArray(rows) ? rows[0] : rows;
      return res.status(200).json({ ok: true, offer });
    }

    // -------------------------------------------------------------------------
    // DELETE — archive an offer (soft delete, nothing destroyed)
    // -------------------------------------------------------------------------
    if (req.method === 'DELETE') {
      const offerId = sanitizeString(req.query && req.query.id, { maxLength: 200 });
      if (!offerId) throw new ValidationError('id query param required.');

      const archiveResp = await supabaseRest(
        'transaction_offers?id=eq.' + encodeURIComponent(offerId) + '&user_id=eq.' + safeUid,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ archived_at: new Date().toISOString() }),
        },
      );
      if (!archiveResp.ok) {
        const t = await archiveResp.text().catch(() => '');
        if (archiveResp.status === 400 && /archived_at/.test(t)) {
          console.error('[transaction-offers] archived_at column missing — run admin-migrate-transactions-archive.');
          return res.status(503).json({ ok: false, error: 'Archiving is not ready yet. Try again shortly.' });
        }
        throw new Error('offer archive failed (' + archiveResp.status + '): ' + t.slice(0, 300));
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });

  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    console.error('[transaction-offers] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not process offer. Try again.' });
  }
};
