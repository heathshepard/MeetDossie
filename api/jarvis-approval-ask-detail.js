// Vercel Serverless Function: /api/jarvis-approval-ask-detail
// Marks a pending approval card as "Heath asked for more detail." Stamps
// heath_ask_for_detail_at on the source row + enqueues a follow-up task for
// the originating agent to expand the item into a new pending card with
// full context.
//
// The card stays visible (still pending) but is flagged in-panel as
// "waiting for expand." The originating agent (usually Hadley for questions,
// Pierce for emails, Jarvis for heath_actions) picks up the agent_queue
// task, drafts a longer explanation, and either patches the same row or
// posts a new pending item.
//
// Heath-only. POST { kind, id } -> { ok, kind, id, asked_at }
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

function agentForKind(kind) {
  if (kind === 'hadley_question') return 'hadley';
  if (kind === 'social_post') return 'sage';
  if (kind === 'sage_research_draft') return 'sage';
  if (kind === 'email_queue') return 'pierce';
  if (kind === 'outbound_email') return 'pierce';
  if (kind === 'founding_application') return 'pierce';
  if (kind === 'heath_action') return 'jarvis';
  if (kind === 'decision') return 'jarvis';
  return 'jarvis';
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

  const { kind, id } = req.body || {};
  if (!kind || !id) return res.status(400).json({ ok: false, error: 'missing_kind_or_id' });

  const now = new Date().toISOString();

  try {
    let updated;
    let sourceTitle = '';

    switch (kind) {
      case 'hadley_question': {
        const patch = { heath_ask_for_detail_at: now, updated_at: now };
        updated = await sbPatch(`hadley_unanswered_questions?id=eq.${id}`, patch);
        sourceTitle = Array.isArray(updated) && updated[0]?.question_text ? updated[0].question_text : '';
        break;
      }
      case 'heath_action': {
        const patch = { heath_ask_for_detail_at: now };
        updated = await sbPatch(`heath_actions?id=eq.${id}&tenant_id=eq.${authUser.userId}`, patch);
        sourceTitle = Array.isArray(updated) && updated[0]?.title ? updated[0].title : '';
        break;
      }
      case 'decision': {
        const patch = { heath_ask_for_detail_at: now };
        updated = await sbPatch(`decision_queue?id=eq.${id}`, patch);
        sourceTitle = Array.isArray(updated) && updated[0]?.title ? updated[0].title : '';
        break;
      }
      // For approve/reject content items (social/email/founding) we don't
      // stamp a column — we just enqueue the agent to expand context in the
      // next refresh cycle.
      case 'social_post':
      case 'sage_research_draft':
      case 'email_queue':
      case 'outbound_email':
      case 'founding_application':
        updated = null;
        break;
      default:
        return res.status(400).json({ ok: false, error: 'unknown_kind', kind });
    }

    // Enqueue the follow-up so the source agent expands the item.
    const agent = agentForKind(kind);
    try {
      await sbInsert(`agent_queue`, {
        agent_name: agent,
        task_subject: `Heath asked for more detail on your ${kind}`,
        task_brief: [
          `Heath tapped "Ask for Detail" on a Pending Approvals card.`,
          ``,
          `Kind: ${kind}`,
          `Source row id: ${id}`,
          `Source title: ${sourceTitle || '(unknown)'}`,
          ``,
          `Action: draft a fuller explanation of this item — background,`,
          `options, tradeoffs, your recommendation — and either update the`,
          `source row or post a new pending approval card so Heath can`,
          `decide with full context.`,
        ].join('\n'),
        priority: 2,
        depends_on: [],
        venture: 'dossie',
        status: 'pending',
        metadata: {
          source: 'jarvis_approval_ask_detail',
          approval_kind: kind,
          approval_id: id,
        },
      });
    } catch (err) {
      console.warn('ask-detail enqueue failed', err?.message || err);
    }

    return res.status(200).json({
      ok: true,
      kind,
      id,
      asked_at: now,
      row: Array.isArray(updated) ? updated[0] : updated,
    });
  } catch (err) {
    console.error('jarvis-approval-ask-detail error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err?.message || err) });
  }
}
