// Vercel Serverless Function: /api/cron-thursday-blast
//
// One-time subscriber blast announcing pre-listing/pre-buyer pipeline stages.
// Sends personalized email to all 12 active founding members via Resend.
// Target: Thursday June 10, 2026 at 8:30 AM CDT (13:30 UTC).
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
//
// Environment:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY
//   CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// ─── Supabase ─────────────────────────────────────────────────────────────────

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
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchRecipients() {
  const subResp = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=user_id');
  if (!subResp.ok || !Array.isArray(subResp.data)) return [];

  const userIds = subResp.data.map((s) => s.user_id).filter(Boolean);
  if (userIds.length === 0) return [];

  const filter = userIds.map((id) => `"${id}"`).join(',');
  const profResp = await supabaseFetch(
    `/rest/v1/profiles?id=in.(${filter})&select=id,email,full_name,is_demo`
  );
  if (!profResp.ok || !Array.isArray(profResp.data)) return [];

  return profResp.data.filter((p) => p && p.email && !p.is_demo);
}

// ─── Email ────────────────────────────────────────────────────────────────────

function buildFirstName(fullName) {
  if (!fullName) return 'there';
  const first = fullName.trim().split(/\s+/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function buildEmailHtml(firstName) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: Georgia, serif; font-size: 16px; line-height: 1.6; color: #1A1A2E; max-width: 560px; margin: 0 auto; padding: 32px 16px; }
  a { color: #C9A96E; }
  p { margin: 0 0 16px; }
</style>
</head>
<body>
<p>${firstName},</p>

<p>One of you emailed me last week with a real product gap: Dossie had no way to track warm clients before they go to contract. No pre-listing stage. No pre-buyer stage. Just a blank before the dossier starts.</p>

<p>That was a fair call. We built it.</p>

<p>Pre-listing and pre-buyer pipeline stages are live in your dashboard now -- with client name fields, so you can track your warm contacts from first conversation through contract.</p>

<p>Log in and check it out. If something is off or you want it to work differently, reply to this email. I read every one.</p>

<p>This is what founding membership actually means: you tell me what's broken, and it gets fixed.</p>

<p>Heath<br>heath@meetdossie.com</p>

<p style="font-size:13px; color:#888; margin-top:32px;">Heath Shepard | Dossie | <a href="https://meetdossie.com">meetdossie.com</a></p>
</body>
</html>`;
}

function buildEmailText(firstName) {
  return `${firstName},

One of you emailed me last week with a real product gap: Dossie had no way to track warm clients before they go to contract. No pre-listing stage. No pre-buyer stage. Just a blank before the dossier starts.

That was a fair call. We built it.

Pre-listing and pre-buyer pipeline stages are live in your dashboard now -- with client name fields, so you can track your warm contacts from first conversation through contract.

Log in and check it out. If something is off or you want it to work differently, reply to this email. I read every one.

This is what founding membership actually means: you tell me what's broken, and it gets fixed.

Heath
heath@meetdossie.com`;
}

async function sendEmail(to, firstName) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: 'Heath at Dossie <heath@meetdossie.com>',
      to: [to],
      subject: 'She asked. We built it.',
      html: buildEmailHtml(firstName),
      text: buildEmailText(firstName),
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errMsg = (data && (data.message || data.name)) || res.status;
    throw new Error(`Resend error for ${to}: ${errMsg}`);
  }

  return data;
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'RESEND_API_KEY not configured' });
  }

  const now = new Date();
  const isJune10 = now.getUTCFullYear() === 2026 && now.getUTCMonth() === 5 && now.getUTCDate() === 10;
  if (!isJune10) {
    console.log('[cron-thursday-blast] skipped — not June 10 2026, got', now.toISOString());
    return res.status(200).json({ ok: true, skipped: true, reason: 'not-june-10-2026' });
  }

  console.log('[cron-thursday-blast] starting at', now.toISOString());

  const recipients = await fetchRecipients();
  console.log(`[cron-thursday-blast] recipients: ${recipients.length}`);

  const results = [];

  for (const recipient of recipients) {
    const firstName = buildFirstName(recipient.full_name);

    try {
      await sendEmail(recipient.email, firstName);
      console.log(`[cron-thursday-blast] sent to ${recipient.email}`);
      results.push({ email: recipient.email, firstName, status: 'sent' });
    } catch (err) {
      console.error(`[cron-thursday-blast] failed for ${recipient.email}:`, err && err.message);
      results.push({ email: recipient.email, firstName, status: 'failed', error: err && err.message });
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  console.log(`[cron-thursday-blast] done. sent=${sent} failed=${failed}`);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    sent,
    failed,
    results,
  });
};
