// POST /api/team/tc-request
// DOD-A-10: admin sends one-tap TC consent request to agent via email/telegram
//
// Body: { org_id, agent_user_id, tc_user_id, channels: ('email'|'telegram')[] }
//
// Flow:
//   1. Admin check
//   2. Create request row + return raw token (only time it exists in plaintext)
//   3. Mint one-tap URL: https://meetdossie.com/consent/tc/<token>
//   4. Deliver via Resend (email) and/or DossieMarketingBot (telegram)
//   5. Return { ok, request_id }
//
// Idempotency: caller can fire multiple requests for the same (agent,tc) pair —
// each gets a new single-use token. Old pending ones remain valid until expiry
// or cancellation.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://meetdossie.com';
const RESEND_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = 'Dossie <heath@meetdossie.com>';
const TG_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;

const VALID_CHANNELS = new Set(['email', 'telegram']);

async function sendResendEmail({ to, subject, html }) {
  if (!RESEND_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, error: `resend ${r.status}: ${txt}` };
  }
  const j = await r.json().catch(() => ({}));
  return { ok: true, id: j.id || null };
}

async function sendTelegramDM({ chat_id, text, button_text, button_url }) {
  if (!TG_TOKEN) return { ok: false, error: 'TELEGRAM_MARKETING_BOT_TOKEN not configured' };
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id,
      text,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: button_text, url: button_url }]] },
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    return { ok: false, error: `telegram ${r.status}: ${txt}` };
  }
  return { ok: true };
}

function buildEmailHtml({ adminName, tcName, orgName, oneTapUrl }) {
  // DOD-U-4 brand voice. Cormorant headings, system body, blush palette.
  return `
<!doctype html><html><body style="margin:0;padding:0;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1A1A2E;">
  <div style="max-width:560px;margin:40px auto;padding:32px;background:#fff;border:1px solid #f0e6e0;border-radius:12px;">
    <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;line-height:1.2;margin-bottom:16px;color:#1A1A2E;">
      ${escapeHtml(tcName)} would like permission to send emails on your behalf
    </div>
    <p style="font-size:16px;line-height:1.6;color:#333;">
      ${escapeHtml(adminName)} on the <strong>${escapeHtml(orgName)}</strong> team asked us to check with you.
    </p>
    <p style="font-size:16px;line-height:1.6;color:#333;">
      If you authorize ${escapeHtml(tcName)}, they'll be able to send emails from your queue on your behalf — things like vendor coordination, client follow-ups, and TC handoffs. They won't be able to sign documents in your name; signing always stays with you.
    </p>
    <p style="font-size:16px;line-height:1.6;color:#333;">
      You can revoke this any time from Settings → Email Delegation.
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${oneTapUrl}" style="display:inline-block;padding:14px 32px;background:#E8836B;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">
        Authorize ${escapeHtml(tcName)}
      </a>
    </div>
    <p style="font-size:13px;color:#999;text-align:center;margin-top:24px;">
      This link expires in 7 days and can only be used once. If you didn't expect this, you can ignore it — nothing happens until you tap.
    </p>
  </div>
</body></html>`.trim();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);
    const body = req.body || {};
    const orgId = body.org_id;
    const agentUserId = body.agent_user_id;
    const tcUserId = body.tc_user_id;
    const channels = Array.isArray(body.channels) ? body.channels : ['email'];

    if (!orgId || !agentUserId || !tcUserId) {
      return res.status(400).json({ ok: false, error: 'org_id, agent_user_id, tc_user_id required' });
    }
    if (channels.length === 0 || !channels.every((c) => VALID_CHANNELS.has(c))) {
      return res.status(400).json({ ok: false, error: 'channels must be non-empty subset of email/telegram' });
    }

    const supabase = getServiceClient();

    // Create request via RPC (admin check enforced inside)
    const { data: rpcRows, error } = await supabase.rpc('create_tc_consent_request', {
      p_org_id: orgId,
      p_agent_user_id: agentUserId,
      p_tc_user_id: tcUserId,
      p_delivery_channels: channels,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[tc-request] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }
    const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
    if (!row || !row.raw_token) {
      return res.status(500).json({ ok: false, error: 'RPC returned no token' });
    }

    const oneTapUrl = `${BASE_URL}/consent/tc/${row.raw_token}`;

    // Look up display names for the email/telegram body
    const [{ data: orgRow }, { data: adminUser }, { data: tcUser }, { data: agentUser }] = await Promise.all([
      supabase.from('organizations').select('name').eq('id', orgId).maybeSingle(),
      supabase.auth.admin.getUserById(caller.id),
      supabase.auth.admin.getUserById(tcUserId),
      supabase.auth.admin.getUserById(agentUserId),
    ]);
    const orgName = (orgRow && orgRow.name) || 'your team';
    const adminName = (adminUser && adminUser.user && (adminUser.user.user_metadata?.full_name || adminUser.user.email)) || 'A team admin';
    const tcName = (tcUser && tcUser.user && (tcUser.user.user_metadata?.full_name || tcUser.user.email)) || 'a TC';
    const agentEmail = (agentUser && agentUser.user && agentUser.user.email) || null;

    const deliveryResults = {};

    if (channels.includes('email')) {
      if (!agentEmail) {
        deliveryResults.email = { ok: false, error: 'agent has no email' };
      } else {
        const html = buildEmailHtml({ adminName, tcName, orgName, oneTapUrl });
        const r = await sendResendEmail({
          to: agentEmail,
          subject: `${tcName} would like permission to send emails on your behalf`,
          html,
        });
        deliveryResults.email = r;
      }
    }

    if (channels.includes('telegram')) {
      // Look up agent's telegram chat_id from profiles (best-effort)
      const { data: profileRow } = await supabase
        .from('profiles')
        .select('telegram_chat_id')
        .eq('id', agentUserId)
        .maybeSingle();
      const chatId = profileRow && profileRow.telegram_chat_id;
      if (!chatId) {
        deliveryResults.telegram = { ok: false, error: 'agent has no telegram_chat_id' };
      } else {
        const text = `<b>${escapeHtml(tcName)}</b> would like permission to send emails on your behalf on the <b>${escapeHtml(orgName)}</b> team.\n\nAuthorize below — you can revoke any time from Settings → Email Delegation.`;
        const r = await sendTelegramDM({
          chat_id: chatId,
          text,
          button_text: `Authorize ${tcName}`,
          button_url: oneTapUrl,
        });
        deliveryResults.telegram = r;
      }
    }

    return res.status(200).json({
      ok: true,
      request_id: row.request_id,
      delivery: deliveryResults,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
