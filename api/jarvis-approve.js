// Vercel Serverless Function: /api/jarvis-approve
// Single-tap approve handler for the Pending Approvals HUD card.
// Routes to the right backing system based on { kind, id }.
//
// Heath-only. POST { kind, id, action? }  ->  { ok, kind, id, new_status }
// Reject support: POST { kind, id, action: 'reject', reason? }
//
// Behavior is intentionally conservative — for items that already have a
// downstream API (founding applications, social posts) we mark the row
// approved and let the existing publisher/cron pick it up. We do NOT
// re-implement sending here.
//
// Owner: Atlas (Jarvis PWA Tier 1)

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

  const { kind, id, action = 'approve', reason = null } = req.body || {};
  if (!kind || !id) return res.status(400).json({ ok: false, error: 'missing_kind_or_id' });
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ ok: false, error: 'bad_action' });

  const now = new Date().toISOString();

  try {
    let updated;
    let newStatus;

    switch (kind) {
      case 'social_post': {
        newStatus = action === 'approve' ? 'approved' : 'rejected';
        const patch = action === 'approve'
          ? { status: 'approved', approved_at: now, approved_by: authUser.userId, copy_approved: true }
          : { status: 'rejected', rejection_reason: reason || 'Heath rejected via Jarvis HUD' };
        updated = await sbPatch(`social_posts?id=eq.${id}`, patch);
        break;
      }
      case 'email_queue': {
        // email_queue is processed by an existing cron — flipping to 'pending'
        // is a no-op (already pending). For approve we mark approved_at via metadata.
        newStatus = action === 'approve' ? 'approved' : 'cancelled';
        const patch = action === 'approve'
          ? { status: 'approved', updated_at: now }
          : { status: 'cancelled', updated_at: now };
        updated = await sbPatch(`email_queue?id=eq.${id}`, patch);
        break;
      }
      case 'outbound_email': {
        // outbound_email_queue cron polls status='pending' and sends. Approving
        // a pending row is a soft confirmation — we just touch updated_at.
        // Rejecting flips status to 'cancelled' so the cron skips it.
        newStatus = action === 'approve' ? 'pending' : 'cancelled';
        const patch = action === 'approve'
          ? { updated_at: now }
          : { status: 'cancelled', updated_at: now, error_text: reason || 'Heath rejected via Jarvis HUD' };
        updated = await sbPatch(`outbound_email_queue?id=eq.${id}`, patch);
        break;
      }
      case 'founding_application': {
        // Mark decision + status. Downstream Pierce/Cole flow handles email send.
        newStatus = action === 'approve' ? 'approved' : 'rejected';
        const patch = {
          status: newStatus,
          reviewed_at: now,
          decision: action === 'approve' ? 'approve' : (reason || 'reject'),
        };
        updated = await sbPatch(`founding_applications?id=eq.${id}`, patch);
        break;
      }
      case 'decision': {
        newStatus = action === 'approve' ? 'resolved_yes' : 'resolved_no';
        const patch = { status: newStatus, resolved_at: now };
        updated = await sbPatch(`decision_queue?id=eq.${id}`, patch);
        break;
      }
      case 'hadley_question': {
        // For Hadley Qs, "approve" without an answer means defer to Hadley.
        // We record acknowledgement; Hadley fills hadley_answer + answered_at via her own flow.
        newStatus = action === 'approve' ? 'acknowledged' : 'dismissed';
        // No status column on this table — we touch updated_at and let Hadley
        // pick it up. To actually clear from the HUD on reject, set answered_at.
        const patch = action === 'reject'
          ? { answered_at: now, hadley_answer: reason || '(dismissed via Jarvis HUD)', updated_at: now }
          : { updated_at: now };
        updated = await sbPatch(`hadley_unanswered_questions?id=eq.${id}`, patch);
        break;
      }
      case 'heath_action': {
        // heath_actions are generic Heath tasks. Approve marks status='done'.
        newStatus = action === 'approve' ? 'done' : 'dismissed';
        const patch = {
          status: newStatus,
          approved_at: now,
          completed_at: now,
        };
        updated = await sbPatch(`heath_actions?id=eq.${id}&tenant_id=eq.${authUser.userId}`, patch);
        break;
      }
      default:
        return res.status(400).json({ ok: false, error: 'unknown_kind', kind });
    }

    return res.status(200).json({
      ok: true,
      kind,
      id,
      action,
      new_status: newStatus,
      row: Array.isArray(updated) ? updated[0] : updated,
      at: now,
    });
  } catch (err) {
    console.error('jarvis-approve error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err?.message || err) });
  }
}
