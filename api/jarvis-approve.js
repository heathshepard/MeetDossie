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
// EXCEPTION (2026-08-13, Carter): outbound_email is the one kind where that
// assumption broke. cron-send-outbound-emails (the only thing that ever
// turns status='pending' into a sent email) has been schedule="0 0 1 1 *"
// (once a year) since 2026-08-10, deliberately disabled after a stale
// cold-email copy incident — see vercel.json history. That cron staying off
// is still the right call for *unsupervised* bulk sending, but it also
// silently broke Heath's one-by-one manual review: clicking Approve on an
// outbound_email row used to just touch updated_at and leave status=
// 'pending', so the item never left the Jarvis Work Items list and nothing
// ever actually sent. Approve on this one kind now sends for real via
// ./_lib/outbound-email-send.js (same Resend + suppression path the batch
// cron uses) — a single explicit Heath tap, not the automatic loop. The
// automatic cron itself stays off; only per-item human approval sends.
//
// Owner: Atlas (Jarvis PWA Tier 1)

import { verifySupabaseToken } from './_middleware/auth.js';
import { sendOutboundEmailRow } from './_lib/outbound-email-send.js';

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

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${text.slice(0, 200)}`);
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
        if (action === 'reject') {
          newStatus = 'cancelled';
          updated = await sbPatch(`outbound_email_queue?id=eq.${id}`, {
            status: 'cancelled',
            updated_at: now,
            error_text: reason || 'Heath rejected via Jarvis HUD',
          });
          break;
        }

        // Approve = send now. The batch cron that used to do this is
        // deliberately disabled (see file header) — a single Heath tap is
        // the only thing that sends an outbound_email row today.
        const rows = await sbGet(`outbound_email_queue?id=eq.${id}&select=*`);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) return res.status(404).json({ ok: false, error: 'row_not_found' });

        if (row.status !== 'pending') {
          // Already actioned (sent/cancelled/failed elsewhere) — idempotent,
          // don't double-send. Report current state so the UI can settle.
          return res.status(200).json({
            ok: true, kind, id, action, new_status: row.status, row, at: now, already_actioned: true,
          });
        }

        // Conditional claim so a double-tap (or a future re-enabled cron)
        // can't send the same row twice.
        const claimedRows = await sbPatch(`outbound_email_queue?id=eq.${id}&status=eq.pending`, {
          status: 'sending', locked_at: now, updated_at: now,
        });
        const claimed = Array.isArray(claimedRows) ? claimedRows[0] : null;
        if (!claimed) {
          return res.status(409).json({ ok: false, error: 'already_claimed', detail: 'Another send is already in progress for this row.' });
        }

        const send = await sendOutboundEmailRow(claimed);
        if (send.ok) {
          updated = await sbPatch(`outbound_email_queue?id=eq.${id}`, {
            status: 'sent', sent_at: now, resend_message_id: send.id || null, error_text: null, updated_at: now,
          });
          newStatus = 'sent';
          break;
        }

        // Send failed — put it back to 'pending' (not 'failed') so it stays
        // visible in the Work Items list and Heath can see why + retry,
        // instead of it silently vanishing without ever actually sending.
        await sbPatch(`outbound_email_queue?id=eq.${id}`, {
          status: 'pending', locked_at: null, error_text: send.errorText || 'send_failed', updated_at: now,
        });
        return res.status(502).json({ ok: false, error: 'send_failed', detail: send.errorText || 'unknown error' });
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
