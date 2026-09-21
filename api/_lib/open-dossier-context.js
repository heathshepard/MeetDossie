// api/_lib/open-dossier-context.js
//
// Resolves the currently-open dossier for api/chat.js's action mode.
//
// Heath, 2026-09-21, live: 23 Nopalito was open on screen at $999,000, he
// said "can you upload the 99k offer we received?", and Dossie said she
// couldn't see an active file near that price — "this deal"/"the 999k
// offer"/"send that to the seller" all fail to resolve because she never
// knew what was on screen.
//
// The client passes the open dossier's id (dealDetailId in
// Dossie/dossie-app.jsx) as `open_transaction_id`. That id is CALLER-SUPPLIED
// and is re-verified here as belonging to the authenticated member before
// anything is read from it or handed to the model — it is a hint about what
// to load, never an authorization token. This is the same shape of mistake
// as the 2026-09-17 impersonation bug
// (security-mt-acting-user-impersonation-2026-09-17): a signed-in caller
// could otherwise supply ANY transaction id and have its data read back,
// regardless of who owns it. Every query here is filtered by BOTH id AND
// user_id, and a miss (wrong owner, deleted, bad id) is treated as "no open
// dossier" rather than an error — the turn still proceeds normally.
//
// Deliberately a small, separate module (pure CJS, no Anthropic SDK) so it's
// testable without booting api/chat.js's handler — same reasoning as
// api/_lib/chat-deal-deadlines.js.
//
// Owner: Carter, 2026-09-21.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const SELECT_FIELDS = [
  'id', 'property_address', 'city_state_zip', 'buyer_name', 'seller_name',
  'sale_price', 'stage', 'role', 'transaction_type',
  'contract_effective_date', 'closing_date', 'option_expiration_date',
  'loan_approval_deadline',
].join(',');

async function fetchOwnedTransaction(transactionId, userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}` +
    `&user_id=eq.${encodeURIComponent(userId)}&select=${SELECT_FIELDS}&limit=1`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) {
    console.warn('[open-dossier-context] transactions fetch failed:', res.status);
    return null;
  }
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]) || null;
}

function money(n) {
  if (n === null || n === undefined || n === '') return null;
  const num = Number(n);
  return Number.isFinite(num) ? `$${num.toLocaleString('en-US')}` : String(n);
}

/**
 * Loads and formats the open-dossier block for the action-mode system
 * prompt. Returns { block: string, transaction: object|null } — block is ''
 * when there is nothing to show (no id given, or the id didn't resolve to
 * a transaction owned by this member).
 */
async function loadOpenDossierContext(openTransactionId, userId) {
  const id = (typeof openTransactionId === 'string' ? openTransactionId : '').trim();
  if (!id || !userId) return { block: '', transaction: null };

  let tx = null;
  try {
    tx = await fetchOwnedTransaction(id, userId);
  } catch (err) {
    console.warn('[open-dossier-context] lookup threw:', err && err.message);
    return { block: '', transaction: null };
  }
  if (!tx) return { block: '', transaction: null };

  const parties = [tx.buyer_name, tx.seller_name].filter(Boolean).join(' / ');
  const summary = {
    id: tx.id,
    property_address: tx.property_address || null,
    city_state_zip: tx.city_state_zip || null,
    parties: parties || null,
    sale_price: money(tx.sale_price),
    stage: tx.stage || null,
    contract_effective_date: tx.contract_effective_date || null,
    closing_date: tx.closing_date || null,
    option_expiration_date: tx.option_expiration_date || null,
    loan_approval_deadline: tx.loan_approval_deadline || null,
  };

  const block = `
CURRENTLY OPEN DOSSIER — the member has this specific deal open on screen right now: ${JSON.stringify(summary, null, 2)}
When the member says something ambiguous that could refer to "this deal" — "this one", "that offer", "the seller", "send that to them", a dollar figure or partial address that plausibly matches THIS open deal — prefer this deal over asking which one they mean.
AMBIGUITY, NOT ASSUMPTION: if what they say could just as plausibly mean a DIFFERENT deal in AGENT'S ACTIVE DEALS (a different address named, a price that matches another deal better, "the other one") do NOT silently act on the open deal — use answer_question to confirm which deal they mean first. Acting on the wrong file is worse than one clarifying question. This mirrors the standing rule on conflicting data: surface it, let the member choose.
`;

  return { block, transaction: summary };
}

module.exports = { loadOpenDossierContext, SELECT_FIELDS };
