// Vercel Serverless Function: /api/jarvis-approval-reply
// Captures Heath's free-text reply on a Pending Approvals card. Handles items
// that are actually QUESTIONS (Hadley asking Heath a legal Q, decision_queue
// items requesting a call, heath_actions requesting an answer) rather than
// straight yes/no approvals.
//
// Heath-only. POST { kind, id, text } -> { ok, kind, id, at }
//
// Behavior per kind:
//   - hadley_question -> writes hadley_answer + answered_at (so Hadley picks it
//     up + it drops off the pending list), plus heath_reply_text / heath_reply_at
//     for audit.
//   - heath_action    -> writes heath_reply_text + heath_reply_at; status stays
//     'pending' unless Heath separately taps Approve (reply != resolve).
//   - decision        -> same pattern as heath_action; resolution is separate.
//   - social_post / email_queue / outbound_email / founding_application ->
//     rejected here (these are approve/reject items, not question items).
//
// Owner: Atlas (Jarvis PWA Approval Reply UX, 2026-07-05)

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = {
  api: { bodyParser: true },
  maxDuration: 10,
};

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function sbInsert(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sbInsert ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Fire-and-forget: enqueue a follow-up task so the source agent sees Heath's
// reply. Best-effort: failures are logged but not surfaced to the client.
async function notifyAgentOfReply({ kind, id, text, sourceTitle }) {
  try {
    let agent = 'hadley';
    if (kind === 'heath_action') agent = 'jarvis';
    if (kind === 'decision') agent = 'jarvis';
    const subject = `Heath replied to your ${kind} — pick it up`;
    const brief = [
      `Heath replied via the Jarvis Pending Approvals card.`,
      ``,
      `Original: ${sourceTitle || '(no title)'}`,
      ``,
      `Heath's reply:`,
      text,
    ].join('\n');
    await sbInsert(`agent_queue`, {
      agent_name: agent,
      task_subject: subject,
      task_brief: brief,
      priority: 2,
      depends_on: [],
      venture: 'dossie',
      status: 'pending',
      metadata: {
        source: 'jarvis_approval_reply',
        approval_kind: kind,
        approval_id: id,
      },
    });
  } catch (err) {
    console.warn('notifyAgentOfReply failed', err?.message || err);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: 'unauthorized' });
  }
  if (authUser.email !== 'heath.shepard@kw.com' && authUser.email !== 'heath@meetdossie.com') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const { kind, id, text } = req.body || {};
  if (!kind || !id) return res.status(400).json({ ok: false, error: 'missing_kind_or_id' });
  const replyText = typeof text === 'string' ? text.trim() : '';
  if (!replyText) return res.status(400).json({ ok: false, error: 'empty_reply' });
  if (replyText.length > 8000) return res.status(400).json({ ok: false, error: 'reply_too_long' });

  const now = new Date().toISOString();

  try {
    let updated;
    let sourceTitle = '';

    switch (kind) {
      case 'hadley_question': {
        // Writing hadley_answer + answered_at closes the card AND gives Hadley
        // Heath's answer as her canonical answer. heath_reply_text is kept for
        // audit — it mirrors hadley_answer when Heath is the one answering.
        const patch = {
          hadley_answer: replyText,
          answered_at: now,
          heath_reply_text: replyText,
          heath_reply_at: now,
          updated_at: now,
        };
        updated = await sbPatch(`hadley_unanswered_questions?id=eq.${id}`, patch);
        sourceTitle = Array.isArray(updated) && updated[0]?.question_text ? updated[0].question_text : '';
        break;
      }
      case 'heath_action': {
        // Reply on a heath_action is guidance to the source agent. We record
        // the reply but do NOT auto-close status — Heath approves/dismisses
        // separately via /api/jarvis-approve.
        const patch = {
          heath_reply_text: replyText,
          heath_reply_at: now,
        };
        updated = await sbPatch(`heath_actions?id=eq.${id}&tenant_id=eq.${authUser.userId}`, patch);
        sourceTitle = Array.isArray(updated) && updated[0]?.title ? updated[0].title : '';
        break;
      }
      case 'decision': {
        const patch = {
          heath_reply_text: replyText,
          heath_reply_at: now,
        };
        updated = await sbPatch(`decision_queue?id=eq.${id}`, patch);
        sourceTitle = Array.isArray(updated) && updated[0]?.title ? updated[0].title : '';
        break;
      }
      case 'social_post':
      case 'email_queue':
      case 'outbound_email':
      case 'founding_application':
        return res.status(400).json({
          ok: false,
          error: 'reply_not_supported_for_kind',
          detail: `${kind} is an approve/reject item; use /api/jarvis-approve.`,
        });
      default:
        return res.status(400).json({ ok: false, error: 'unknown_kind', kind });
    }

    // Best-effort: notify the source agent that Heath replied.
    await notifyAgentOfReply({ kind, id, text: replyText, sourceTitle });

    return res.status(200).json({
      ok: true,
      kind,
      id,
      at: now,
      row: Array.isArray(updated) ? updated[0] : updated,
    });
  } catch (err) {
    console.error('jarvis-approval-reply error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err?.message || err) });
  }
}
