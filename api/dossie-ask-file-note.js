// Vercel Serverless Function: /api/dossie-ask-file-note
//
// "If something happens by text or phone, paste it here and I will file it."
//
// That promise was not kept. The panel POSTed straight to /api/dossie-asks with
// the pasted text as both title and body, `transaction_id: null`, and no action
// item — so a note naming a dossier by address filed under "YOUR ACCOUNT" and
// nothing downstream ever moved. It was a notes inbox wearing an assistant's
// label.
//
// This endpoint does the filing:
//   1. Reads the agent's own open dossiers.
//   2. Asks the model to (a) pick which dossier the note is about, from that
//      list ONLY, (b) write a short title in Dossie's voice, (c) pull a due
//      date if the note states one, (d) name the concrete next action.
//   3. Falls back to deterministic address / party-name matching when the model
//      is unavailable or declines — a pasted note must never be silently lost.
//   4. Writes the ask WITH transaction_id.
//   5. Writes a real action_items row when a dossier was matched, so the note
//      turns into work that shows up on the dossier and in the Morning Brief.
//
// Deliberate constraints:
//   - The model may only return an id from the candidate list. Anything else is
//     discarded and the ask files unlinked rather than attached to the wrong
//     deal. Mis-filing a note onto someone else's closing is worse than not
//     filing it.
//   - action_items.transaction_id is NOT NULL, so no match means no action
//     item. We say so in the response instead of inventing a linkage.
//   - Nothing here writes contract terms. It creates a task, never a term.
//
// Authorization: Bearer <supabase user JWT>. Every query is scoped by user_id
// server-side.
//
// Owner: Carter, 2026-08-16.

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const MODEL = 'claude-opus-4-8';
const MAX_NOTE_CHARS = 2000;
const CANDIDATE_LIMIT = 60;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const VALID_URGENCY = new Set(['critical', 'high', 'normal', 'low']);

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (
      ALLOWED_ORIGINS.has(origin)
      || LOCALHOST_ORIGIN_RE.test(origin)
      || origin.endsWith('.vercel.app')
      || origin.endsWith('.meetdossie.com')
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
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { ...init, headers });
  let data = null;
  try {
    data = await res.json();
  } catch (_e) {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Deterministic matcher — the floor under the model.
// ---------------------------------------------------------------------------

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Street number + first street word ("205 kendall") is the cheapest signal that
// actually discriminates between deals. Full-address equality never matches
// how people write in a text message.
function addressTokens(address) {
  const n = normalize(address);
  if (!n) return null;
  const parts = n.split(' ');
  const numIdx = parts.findIndex((p) => /^\d+$/.test(p));
  if (numIdx === -1 || numIdx + 1 >= parts.length) return null;
  return `${parts[numIdx]} ${parts[numIdx + 1]}`;
}

function deterministicMatch(note, candidates) {
  const hay = normalize(note);
  if (!hay) return null;

  // Strongest first: dossier number, then street number + street name.
  for (const c of candidates) {
    if (c.dossier_number && hay.includes(normalize(c.dossier_number))) {
      return { id: c.id, basis: `dossier number ${c.dossier_number}` };
    }
  }
  for (const c of candidates) {
    const tok = addressTokens(c.property_address);
    if (tok && hay.includes(tok)) {
      return { id: c.id, basis: `address "${c.property_address}"` };
    }
  }
  // Party surnames are weaker — only accept when exactly one deal matches, so
  // two Smiths never silently collapse onto one file.
  const nameHits = [];
  for (const c of candidates) {
    const names = [c.buyer_name, c.seller_name].filter(Boolean).join(' ');
    const surnames = normalize(names).split(' ').filter((w) => w.length >= 4);
    const hit = surnames.find((w) => hay.includes(w));
    if (hit) nameHits.push({ id: c.id, basis: `party name "${hit}"` });
  }
  if (nameHits.length === 1) return nameHits[0];
  return null;
}

// ---------------------------------------------------------------------------
// Model pass
// ---------------------------------------------------------------------------

function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (_e) {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_e2) {
      return null;
    }
  }
}

async function parseNoteWithModel(note, candidates, todayIso) {
  if (!ANTHROPIC_API_KEY) return null;

  const list = candidates
    .map((c) => `- id: ${c.id}
  address: ${c.property_address || '(none)'}
  dossier: ${c.dossier_number || '(none)'}
  buyer: ${c.buyer_name || '(none)'}
  seller: ${c.seller_name || '(none)'}
  stage: ${c.stage || '(none)'}
  closing: ${c.closing_date || '(none)'}`)
    .join('\n');

  const systemPrompt = `You are Dossie, a Texas real estate transaction coordinator. An agent pasted something that happened by text or phone. File it.

Return ONLY a JSON object, no prose, with these keys:
{
  "transaction_id": "<one id copied EXACTLY from the candidate list, or null>",
  "match_reason": "<short phrase naming what in the note identified the deal, or null>",
  "title": "<max 70 chars, what happened, plain and specific>",
  "urgency": "critical" | "high" | "normal" | "low",
  "due_at": "<ISO 8601 datetime if the note states a specific date/time, else null>",
  "due_label": "<short human phrase like 'Friday 2pm', else null>",
  "action_description": "<the concrete next step the agent or Dossie must take, imperative, max 140 chars>",
  "action_type": "<one of: inspection, appraisal, survey, title, financing, hoa, repairs, deadline, document, communication, other>"
}

Hard rules:
- transaction_id MUST be copied character-for-character from the candidate list, or be null. Never invent one. If you are not confident which deal it is, use null.
- Do not restate the note as the title. Say what happened.
- Only set due_at when the note actually states a date or time. Never guess one.
- urgency: "critical" only when a TREC deadline or money is at immediate risk.
- Today is ${todayIso}. Resolve relative dates ("Friday", "tomorrow") against it.`;

  const userPrompt = `Agent's open dossiers:
${list || '(none)'}

Pasted note:
"""
${note}
"""

File it.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    console.warn('[dossie-ask-file-note] model call failed:', res.status);
    return null;
  }
  const json = await res.json().catch(() => null);
  const text = ((json && json.content) || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
  return extractJson(text);
}

// ---------------------------------------------------------------------------

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  let userId;
  try {
    const decoded = await verifySupabaseToken(req);
    userId = decoded.sub;
  } catch (err) {
    return res
      .status(err instanceof AuthError && err.status ? err.status : 401)
      .json({ ok: false, error: 'Unauthorized' });
  }

  const body = req.body || {};
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!note) return res.status(400).json({ ok: false, error: 'note is required' });
  if (note.length > MAX_NOTE_CHARS) {
    return res.status(413).json({ ok: false, error: `note exceeds ${MAX_NOTE_CHARS} characters` });
  }

  // 1. The agent's own open dossiers — the only ids a note may be attached to.
  const txnRes = await supabaseFetch(
    `/transactions?user_id=eq.${encodeURIComponent(userId)}`
    + '&select=id,property_address,dossier_number,buyer_name,seller_name,stage,closing_date,status'
    + '&order=updated_at.desc'
    + `&limit=${CANDIDATE_LIMIT}`,
  );
  const candidates = Array.isArray(txnRes.data) ? txnRes.data : [];
  const candidateIds = new Set(candidates.map((c) => c.id));

  const todayIso = new Date().toISOString().slice(0, 10);

  // 2. Model pass, then deterministic fallback. Never let a model failure eat
  //    the note — worst case it files exactly as well as it used to.
  let parsed = null;
  try {
    parsed = await parseNoteWithModel(note, candidates, todayIso);
  } catch (err) {
    console.warn('[dossie-ask-file-note] parse threw:', err && err.message);
  }

  let transactionId = null;
  let matchReason = null;
  let matchedBy = 'none';

  if (parsed && typeof parsed.transaction_id === 'string' && candidateIds.has(parsed.transaction_id)) {
    transactionId = parsed.transaction_id;
    matchReason = typeof parsed.match_reason === 'string' ? parsed.match_reason : null;
    matchedBy = 'model';
  } else {
    const det = deterministicMatch(note, candidates);
    if (det) {
      transactionId = det.id;
      matchReason = det.basis;
      matchedBy = 'deterministic';
    }
  }

  const fallbackTitle = note.length > 70 ? `${note.slice(0, 70).trim()}...` : note;
  const title = (parsed && typeof parsed.title === 'string' && parsed.title.trim())
    ? parsed.title.trim().slice(0, 160)
    : fallbackTitle;

  const urgency = (parsed && VALID_URGENCY.has(parsed.urgency)) ? parsed.urgency : 'normal';
  const dueAt = (parsed && typeof parsed.due_at === 'string' && parsed.due_at.trim()) ? parsed.due_at : null;
  const dueLabel = (parsed && typeof parsed.due_label === 'string' && parsed.due_label.trim())
    ? parsed.due_label.trim().slice(0, 60)
    : null;

  const actionDescription = (parsed && typeof parsed.action_description === 'string' && parsed.action_description.trim())
    ? parsed.action_description.trim().slice(0, 140)
    : null;
  const actionType = (parsed && typeof parsed.action_type === 'string' && parsed.action_type.trim())
    ? parsed.action_type.trim().slice(0, 40)
    : 'other';

  // 3. The ask. Body keeps the note VERBATIM — the agent's own words are the
  //    record; the parse is an interpretation layered on top, never a
  //    replacement.
  const suggestedActions = [{ id: 'handled', label: 'Handled', kind: 'done', effect: 'resolve' }];

  const askPayload = {
    user_id: userId,
    transaction_id: transactionId,
    urgency,
    title,
    body: note,
    due_at: dueAt,
    due_label: dueLabel,
    suggested_actions: suggestedActions,
    created_by: 'agent',
    source: 'pasted-by-agent',
  };

  const askRes = await supabaseFetch('/dossie_asks', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(askPayload),
  });
  if (!askRes.ok) {
    console.error('[dossie-ask-file-note] ask insert failed:', askRes.status, JSON.stringify(askRes.data).slice(0, 300));
    return res.status(500).json({ ok: false, error: 'Could not file that note.' });
  }
  const ask = Array.isArray(askRes.data) ? askRes.data[0] : askRes.data;

  // 4. Real work, not just a card. action_items.transaction_id is NOT NULL, so
  //    an unmatched note cannot produce one — say so rather than fake a link.
  let actionItem = null;
  if (transactionId && actionDescription) {
    const itemRes = await supabaseFetch('/action_items', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        transaction_id: transactionId,
        action_type: actionType,
        description: actionDescription,
        due_date: dueAt ? String(dueAt).slice(0, 10) : null,
        status: 'pending',
      }),
    });
    if (itemRes.ok) {
      actionItem = Array.isArray(itemRes.data) ? itemRes.data[0] : itemRes.data;
    } else {
      // A failed action item must not fail the whole call — the note is
      // already filed and losing it would be worse.
      console.warn('[dossie-ask-file-note] action_item insert failed:',
        itemRes.status, JSON.stringify(itemRes.data).slice(0, 300));
    }
  }

  const matched = candidates.find((c) => c.id === transactionId) || null;

  return res.status(201).json({
    ok: true,
    ask,
    actionItem,
    filing: {
      transaction_id: transactionId,
      property_address: matched ? matched.property_address : null,
      matched_by: matchedBy,
      match_reason: matchReason,
      action_item_created: Boolean(actionItem),
      // Honest about the unmatched case so the UI can ask the agent which deal
      // it belongs to instead of pretending it filed cleanly.
      unmatched_reason: transactionId
        ? null
        : 'Could not tell which dossier this belongs to.',
    },
  });
};
