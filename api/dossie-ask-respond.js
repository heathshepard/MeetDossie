// Vercel Serverless Function: /api/dossie-ask-respond
//
// Handles a response to a "Dossie asks" card — either a quick-action button or
// free text. This is what stops the reply box being a dead input.
//
//   POST /api/dossie-ask-respond  { askId, actionId?, text? }
//
// Behaviour:
//   * The chosen quick action declares an `effect` (reply | snooze | resolve).
//     Free text has no declared effect, so intent is classified first —
//     "already handled, they signed" resolves the card, "what should I say?"
//     does not.
//   * Anything that needs words routes into the existing Talk-to-Dossie
//     backend (/api/chat) with the deal's real facts attached, so the answer
//     is grounded in the transaction rather than generic.
//   * Every turn is appended to the ask's `thread`, so the conversation stays
//     bound to the ask it answers instead of scrolling away.
//
// NOTE ON CONTEXT: /api/chat accepts a `transactionContext` field but only
// uses it to pick a model — it never reaches the prompt. So the deal facts are
// composed into the message body here. Verified against api/chat.js:936-943.
//
// Authorization: Bearer <supabase user JWT>
//
// Owner: Carter, 2026-08-14 (SV-ENG-DOSSIE-ASKS)

const Anthropic = require('@anthropic-ai/sdk');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const MAX_THREAD_ENTRIES = 40;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin) ||
      LOCALHOST_ORIGIN_RE.test(origin) ||
      origin.endsWith('.vercel.app') ||
      origin.endsWith('.meetdossie.com')
    ) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin) || !origin;
}

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
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

// Compact, factual context block. Only fields that actually help Dossie answer
// — dumping the whole 200-column transaction row would bury the signal.
function buildContextBlock(ask, tx) {
  const lines = [];
  if (tx) {
    lines.push(`Property: ${tx.property_address || 'unknown'}`);
    if (tx.role) lines.push(`Agent's side: ${tx.role}`);
    if (tx.stage) lines.push(`Stage: ${tx.stage}`);
    if (tx.seller_name) lines.push(`Seller: ${String(tx.seller_name).trim()}`);
    if (tx.buyer_name) lines.push(`Buyer: ${String(tx.buyer_name).trim()}`);
    if (tx.sale_price) lines.push(`Sale price: $${Number(tx.sale_price).toLocaleString()}`);
    if (tx.closing_date) lines.push(`Closing date: ${tx.closing_date}`);
    if (tx.option_expiration_date) {
      lines.push(`Option expiration (on record): ${tx.option_expiration_date}`);
    }
    if (tx.title_company) lines.push(`Title company: ${tx.title_company}`);
  }
  if (ask.due_at) lines.push(`This item is due: ${ask.due_at}`);
  if (ask.due_label) lines.push(`Deadline shown to agent: ${ask.due_label}`);
  return lines.join('\n');
}

async function callChatBackend({ req, ask, tx, agentText }) {
  const context = buildContextBlock(ask, tx);
  const message = [
    'You raised this with the agent on their home screen:',
    `"${ask.title} — ${ask.body}"`,
    '',
    'Deal facts on record:',
    context || '(none on file)',
    '',
    `The agent replied: "${agentText}"`,
    '',
    'Respond directly to the agent in two or three sentences. Be concrete and',
    'do the next useful thing — if they asked you to draft something, write the',
    'actual draft. Do not restate the situation back to them.',
  ].join('\n');

  // Reuse the real chat backend rather than duplicating its prompt, model
  // routing and rate limiting. Same-origin call, forwarding the caller's JWT
  // so their own plan limits apply.
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: req.headers.authorization || '',
    },
    body: JSON.stringify({
      message,
      transactionContext: tx ? { id: tx.id, address: tx.property_address } : undefined,
    }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.ok) {
    return null;
  }
  return typeof json.reply === 'string' ? json.reply : null;
}

// Free text carries no declared effect, so decide whether it closes the ask.
// Conservative by design: when in doubt the card STAYS OPEN. A card wrongly
// left open is a small annoyance; a deal-critical card wrongly closed is the
// exact failure this whole surface exists to prevent.
async function classifyIntent(ask, agentText) {
  if (!process.env.ANTHROPIC_API_KEY) return 'reply';
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 16,
      system:
        'You classify a real estate agent\'s reply to a task reminder. Answer with exactly one word.\n' +
        'DONE  - the underlying task is already finished or no longer needed.\n' +
        'DOING - the agent is personally handling it but it is not finished yet.\n' +
        'REPLY - anything else, including questions or requests for you to do work.\n' +
        'If you are not certain the task is finished, do not answer DONE.',
      messages: [
        {
          role: 'user',
          content: `Reminder: "${ask.title} — ${ask.body}"\nAgent reply: "${agentText}"`,
        },
      ],
    });
    const text = (result.content || [])
      .map((b) => (b && b.type === 'text' ? b.text : ''))
      .join('')
      .trim()
      .toUpperCase();
    if (text.startsWith('DONE')) return 'resolve';
    if (text.startsWith('DOING')) return 'snooze';
    return 'reply';
  } catch {
    return 'reply';
  }
}

// Snooze target, never past the deadline. Snoozing an ask beyond the moment it
// stops being fixable would silently bury it — clamp to 30 minutes before due.
function snoozeTarget(ask) {
  const fourHours = Date.now() + 4 * 3600000;
  if (!ask.due_at) return new Date(fourHours).toISOString();
  const due = new Date(ask.due_at).getTime();
  if (Number.isNaN(due)) return new Date(fourHours).toISOString();
  const guard = due - 30 * 60000;
  if (guard <= Date.now()) return null; // too close to the wire — keep it visible
  return new Date(Math.min(fourHours, guard)).toISOString();
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') {
    return res.status(corsAllowed ? 204 : 403).end();
  }
  if (!corsAllowed) {
    return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const { askId, actionId, text } = req.body || {};
  if (!askId) return res.status(400).json({ ok: false, error: 'askId required' });

  const trimmedText = typeof text === 'string' ? text.trim().slice(0, 2000) : '';
  if (!actionId && !trimmedText) {
    return res.status(400).json({ ok: false, error: 'actionId or text required' });
  }

  // Scoped by user_id — an ask id belonging to another tenant simply 404s.
  const askRes = await supabaseFetch(
    `/rest/v1/dossie_asks?select=*,transactions(*)&id=eq.${encodeURIComponent(askId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}`,
  );
  if (!askRes.ok || !Array.isArray(askRes.data) || askRes.data.length === 0) {
    return res.status(404).json({ ok: false, error: 'Ask not found' });
  }

  const ask = askRes.data[0];
  const tx = ask.transactions || null;

  const actions = Array.isArray(ask.suggested_actions) ? ask.suggested_actions : [];
  const action = actionId ? actions.find((a) => a && a.id === actionId) : null;
  if (actionId && !action) {
    return res.status(400).json({ ok: false, error: 'Unknown action for this ask' });
  }

  const agentText = trimmedText || (action ? action.label : '');
  let effect = action ? action.effect || 'reply' : await classifyIntent(ask, agentText);

  // Dossie only speaks when the card is staying in play, or when the agent
  // actually typed something. Tapping "Already done" should just close it.
  let reply = null;
  if (effect !== 'resolve' || trimmedText) {
    reply = await callChatBackend({ req, ask, tx, agentText });
  }

  const now = new Date().toISOString();
  const thread = Array.isArray(ask.thread) ? ask.thread.slice() : [];
  thread.push({
    at: now,
    role: 'agent',
    text: agentText,
    action_id: action ? action.id : null,
  });
  if (reply) thread.push({ at: now, role: 'dossie', text: reply });

  const patch = { thread: thread.slice(-MAX_THREAD_ENTRIES) };

  if (effect === 'resolve') {
    patch.status = 'resolved';
    patch.resolution = action ? action.id : 'free_text';
    patch.resolution_note = agentText;
    patch.resolved_at = now;
  } else if (effect === 'snooze') {
    const until = snoozeTarget(ask);
    if (until) {
      patch.status = 'snoozed';
      patch.snoozed_until = until;
    }
    patch.resolution_note = agentText;
  }

  const upd = await supabaseFetch(
    `/rest/v1/dossie_asks?id=eq.${encodeURIComponent(askId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    },
  );

  if (!upd.ok || !Array.isArray(upd.data) || upd.data.length === 0) {
    return res.status(500).json({ ok: false, error: 'Could not record response' });
  }

  const saved = upd.data[0];
  delete saved.transactions;

  return res.status(200).json({
    ok: true,
    effect,
    reply,
    ask: saved,
  });
};
