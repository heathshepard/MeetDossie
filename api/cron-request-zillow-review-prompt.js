// Vercel Serverless Function: /api/cron-request-zillow-review-prompt
//
// Second half of the post-closing testimonial automation (see
// cron-request-testimonial-draft.js and memory
// dossie-post-closing-testimonial-request.md).
//
// Heath, 2026-09-10 (round 2): "are we asking them to post it directly to
// all of the different sites, Zillow, Google, all of them... I don't think
// we can post testimonials ourselves to every place." Zillow will not
// attribute a review that arrives via a pasted link -- it only counts a
// review requested through Zillow's own request-a-review flow on the
// agent's profile. So this is NOT a second email to the client. It is a
// one-time, agent-facing action item -- a to-do telling the agent to go run
// Zillow's own flow themselves -- created ~7 days after the Google ask was
// actually SENT (transactions.google_requested_at), not after closing.
//
// Idempotent: transactions.zillow_prompt_created_at is stamped after the
// action item is created and gates every future run for that dossier,
// forever -- exactly one Zillow prompt per closed deal.
//
// Multi-tenant: every read/write is scoped to the transaction's own user_id
// (transactions-table-is-multi-tenant.md).
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
//
// NOT YET registered in vercel.json: the repo's cron cap is 100/100
// (commit hook enforces this). See cron-request-testimonial-draft.js for
// the same note. Trigger manually in the meantime:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-url>/api/cron-request-zillow-review-prompt

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ZILLOW_PROMPT_AFTER_DAYS = 7;
const BATCH_LIMIT = 50;

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// Resolves the same "who is the agent's client" display name used by
// cron-request-testimonial-draft.js, so the two action items on a dossier
// read consistently.
function clientDisplayName(tx) {
  const isListingSide = tx.role === 'listing';
  const names = (isListingSide ? [tx.seller_name, tx.seller2_name] : [tx.buyer_name, tx.buyer2_name])
    .map((n) => (typeof n === 'string' ? n.trim() : ''))
    .filter(Boolean);
  return names.length ? names.join(' & ') : (isListingSide ? 'your seller' : 'your buyer');
}

module.exports = withTelemetry('cron-request-zillow-review-prompt', async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }

    const cutoff = new Date(Date.now() - ZILLOW_PROMPT_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const txResp = await supabaseFetch(
      `/rest/v1/transactions?google_requested_at=lte.${encodeURIComponent(cutoff)}` +
      `&google_requested_at=not.is.null&zillow_prompt_created_at=is.null` +
      `&select=id,user_id,property_address,role,buyer_name,buyer2_name,seller_name,seller2_name` +
      `&order=google_requested_at.asc&limit=${BATCH_LIMIT}`,
    );
    if (!txResp.ok) {
      return res.status(500).json({ ok: false, error: `transactions fetch failed: ${txResp.status}` });
    }
    const transactions = txResp.data || [];

    const summary = { ok: true, scanned: transactions.length, prompted: 0, errors: [] };

    for (const tx of transactions) {
      const userId = tx.user_id;
      if (!userId) { summary.errors.push({ tx_id: tx.id, error: 'missing user_id' }); continue; }

      const profResp = await supabaseFetch(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=zillow_profile_url&limit=1`,
      );
      const profile = profResp.ok && Array.isArray(profResp.data) && profResp.data[0] ? profResp.data[0] : null;
      const zillowProfileUrl = profile && profile.zillow_profile_url ? profile.zillow_profile_url : null;

      const clientName = clientDisplayName(tx);
      const property = tx.property_address || 'this dossier';

      // Description is deliberately explicit about WHY this can't be an
      // email Dossie sends, per Heath: "Make sure the action item text
      // says exactly that so nobody tries to shortcut it."
      const description = zillowProfileUrl
        ? `Ask ${clientName} for a Zillow review yourself, via Zillow's own review-request tool -- Zillow will not attribute a review that arrives from a pasted link, so Dossie can't send this one for you. Open your Zillow profile's review-request page and send it from there: ${zillowProfileUrl} (re: ${property})`
        : `Ask ${clientName} for a Zillow review yourself, via Zillow's own review-request tool -- Zillow will not attribute a review that arrives from a pasted link, so Dossie can't send this one for you. Add your Zillow profile link in Settings first, then open your Zillow profile's review-request page and send it from there. (re: ${property})`;

      const aiInsert = await supabaseFetch('/rest/v1/action_items', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          transaction_id: String(tx.id),
          action_type: 'zillow_review_prompt',
          description,
          assigned_to_name: clientName,
          // No email_subject/body/sms_draft -- this is never an email
          // Dossie sends to the client. assigned_to_email/due_date stay
          // null so cron-followup.js's generic auto-send sweep can never
          // pick this up either.
          assigned_to_email: null,
          due_date: null,
          status: 'pending',
        }),
      });

      if (!aiInsert.ok) {
        summary.errors.push({ tx_id: tx.id, user_id: userId, error: `action_items insert failed: ${aiInsert.status}` });
        continue; // don't stamp the idempotency marker if the action item failed to write
      }

      const stamp = await supabaseFetch(
        `/rest/v1/transactions?id=eq.${encodeURIComponent(tx.id)}&user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ zillow_prompt_created_at: new Date().toISOString() }),
        },
      );
      if (!stamp.ok) {
        summary.errors.push({ tx_id: tx.id, user_id: userId, error: `idempotency stamp failed: ${stamp.status}` });
        continue;
      }

      summary.prompted++;
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[cron-request-zillow-review-prompt] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
