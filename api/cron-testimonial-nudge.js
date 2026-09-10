// Vercel Serverless Function: /api/cron-testimonial-nudge
//
// Part of the post-closing testimonial automation (see
// cron-request-testimonial-draft.js and memory
// dossie-post-closing-testimonial-request.md).
//
// If a testimonial_request action item has sat un-actioned (not sent, not
// dismissed, not completed) for 7+ days, sends the AGENT one -- and only
// one -- nudge email pointing back at the draft. This never emails the
// client; the client-facing send only ever happens when the agent taps
// Send (send-testimonial-request.js). reminder_sent_at is stamped
// immediately after a successful nudge and gates every future run for that
// row, forever -- "No second reminder."
//
// Multi-tenant: every write is scoped to the action item's own user_id.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
//
// NOT YET registered in vercel.json: the repo's cron cap is 100/100
// (commit hook enforces this). Needs a freed slot or external scheduling
// before this runs unattended -- see cron-request-testimonial-draft.js for
// the same note. Trigger manually in the meantime:
//   curl -H "Authorization: Bearer $CRON_SECRET" \
//     https://<preview-url>/api/cron-testimonial-nudge

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { customerFirstName } = require('./_lib/personalization.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';
const NUDGE_AFTER_DAYS = 7;
const BATCH_LIMIT = 100;

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

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function sendResend(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

module.exports = withTelemetry('cron-testimonial-nudge', async function handler(req, res) {
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
    if (!RESEND_API_KEY) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'RESEND_API_KEY not set' });
    }

    const cutoff = new Date(Date.now() - NUDGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const itemsResp = await supabaseFetch(
      `/rest/v1/action_items?action_type=eq.testimonial_request&status=in.(pending,overdue)` +
      `&reminder_sent_at=is.null&created_at=lte.${encodeURIComponent(cutoff)}` +
      `&select=id,user_id,transaction_id,description,assigned_to_name,created_at&order=created_at.asc&limit=${BATCH_LIMIT}`,
    );
    if (!itemsResp.ok) {
      return res.status(500).json({ ok: false, error: `action_items fetch failed: ${itemsResp.status}` });
    }
    const items = itemsResp.data || [];

    const summary = { ok: true, scanned: items.length, nudged: 0, skipped_no_agent_email: 0, errors: [] };

    for (const item of items) {
      const profResp = await supabaseFetch(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(item.user_id)}&select=email,full_name,is_demo&limit=1`,
      );
      const profile = profResp.ok && Array.isArray(profResp.data) && profResp.data[0] ? profResp.data[0] : null;
      if (!profile || !profile.email) { summary.skipped_no_agent_email++; continue; }

      let propertyAddress = null;
      if (item.transaction_id) {
        const txResp = await supabaseFetch(
          `/rest/v1/transactions?id=eq.${encodeURIComponent(item.transaction_id)}&select=property_address&limit=1`,
        );
        if (txResp.ok && Array.isArray(txResp.data) && txResp.data[0]) {
          propertyAddress = txResp.data[0].property_address || null;
        }
      }

      const agentFirst = customerFirstName(profile);
      const dealTag = propertyAddress ? ` for ${escapeHtml(propertyAddress)}` : '';
      const subject = `Still waiting: testimonial request${dealTag}`;
      const html = `<div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">
        <p>Hi ${escapeHtml(agentFirst)},</p>
        <p style="margin:0 0 16px;">A week ago I drafted a testimonial request${dealTag ? ` to ${escapeHtml(item.assigned_to_name || 'your client')}${dealTag}` : ` to ${escapeHtml(item.assigned_to_name || 'your client')}`} and it's still sitting unsent in your Emails queue. Reviews are easiest to collect while the experience is fresh -- worth a quick look when you have a minute.</p>
        <p style="margin:0 0 16px;"><a href="https://meetdossie.com/app" style="display:inline-block;background:#1A1A2E;color:#F5E6E0;padding:12px 20px;border-radius:6px;text-decoration:none;font-size:14px;">Open the draft</a></p>
        <p style="margin:0 0 16px;font-size:13px;color:#7A7468;">This is the only reminder Dossie will send on this one -- no need to dismiss it to stop future nudges.</p>
        <p style="margin:0 0 16px;">- Dossie</p>
      </div>`;

      const sent = await sendResend(profile.email, subject, html);
      if (!sent.ok) {
        summary.errors.push({ item_id: item.id, user_id: item.user_id, status: sent.status, error: (sent.raw || '').slice(0, 200) });
        continue;
      }

      await supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}&user_id=eq.${encodeURIComponent(item.user_id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ reminder_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      summary.nudged++;
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[cron-testimonial-nudge] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
