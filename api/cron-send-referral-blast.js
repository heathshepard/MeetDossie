// Vercel Serverless Function: /api/cron-send-referral-blast
//
// One-time referral blast to all active paying customers. Asks them to refer
// other Texas agents to Dossie's founding program. Sends via Resend from
// heath@meetdossie.com. Tracks sends via profiles.referral_ask_sent_at so
// the same customer never gets this email twice.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: 30 13 9 6 * (Tuesday June 9 at 13:30 UTC = 8:30 AM CST)
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

// Returns all active non-demo customers who haven't received the referral ask yet
async function fetchEligibleCustomers() {
  const { ok, data } = await supabaseFetch(
    '/rest/v1/subscriptions' +
    '?status=eq.active' +
    '&select=user_id,profiles!inner(id,full_name,email,is_demo,referral_ask_sent_at)' +
    '&profiles.is_demo=eq.false' +
    '&profiles.referral_ask_sent_at=is.null'
  );

  if (!ok || !Array.isArray(data)) return [];

  return data
    .map((row) => row.profiles)
    .filter((p) => p && p.email && !p.is_demo && !p.referral_ask_sent_at);
}

async function markSent(profileId) {
  await supabaseFetch(`/rest/v1/profiles?id=eq.${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ referral_ask_sent_at: new Date().toISOString() }),
  });
}

// ─── Email ────────────────────────────────────────────────────────────────────

function buildFirstName(fullName) {
  if (!fullName) return 'there';
  const first = fullName.trim().split(/\s+/)[0];
  // Capitalize first letter, lowercase rest
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
<p>Hi ${firstName},</p>

<p>Quick ask - can I put you on the spot for two minutes?</p>

<p>I'm trying to fill the last 38 founding spots before I close the program. If you know any Texas agents who are juggling too many apps, spending money on a TC they can barely afford, or just drowning in transaction paperwork - I'd really love an introduction.</p>

<p>The founding link is <a href="https://meetdossie.com/founding">meetdossie.com/founding</a>. $29/month, locked in forever. Same rate you're on.</p>

<p>No pressure at all - just figured if anyone would know the right people, it'd be someone already in the trenches. You're the ones who get it.</p>

<p>Thanks for being one of the first to trust Dossie. It means more than you know.</p>

<p>- Heath</p>

<p style="font-size:13px; color:#888; margin-top:32px;">Heath Shepard | Dossie | <a href="https://meetdossie.com">meetdossie.com</a></p>
</body>
</html>`;
}

function buildEmailText(firstName) {
  return `Hi ${firstName},

Quick ask - can I put you on the spot for two minutes?

I'm trying to fill the last 38 founding spots before I close the program. If you know any Texas agents who are juggling too many apps, spending money on a TC they can barely afford, or just drowning in transaction paperwork - I'd really love an introduction.

The founding link is meetdossie.com/founding. $29/month, locked in forever. Same rate you're on.

No pressure at all - just figured if anyone would know the right people, it'd be someone already in the trenches. You're the ones who get it.

Thanks for being one of the first to trust Dossie. It means more than you know.

- Heath

Heath Shepard | Dossie | meetdossie.com`;
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
      subject: 'Can I ask you a small favor?',
      html: buildEmailHtml(firstName),
      text: buildEmailText(firstName),
    }),
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const errMsg = data?.message || data?.name || res.status;
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

  console.log('[cron-send-referral-blast] starting at', new Date().toISOString());

  const customers = await fetchEligibleCustomers();
  console.log(`[cron-send-referral-blast] eligible customers: ${customers.length}`);

  const results = [];

  for (const customer of customers) {
    const firstName = buildFirstName(customer.full_name);

    try {
      await sendEmail(customer.email, firstName);
      await markSent(customer.id);
      console.log(`[cron-send-referral-blast] sent to ${customer.email}`);
      results.push({ email: customer.email, status: 'sent' });
    } catch (err) {
      console.error(`[cron-send-referral-blast] failed for ${customer.email}:`, err && err.message);
      results.push({ email: customer.email, status: 'failed', error: err && err.message });
    }

    // Brief pause between sends to stay within Resend rate limits
    await new Promise((r) => setTimeout(r, 300));
  }

  const sent = results.filter((r) => r.status === 'sent').length;
  const failed = results.filter((r) => r.status === 'failed').length;

  console.log(`[cron-send-referral-blast] done. sent=${sent} failed=${failed}`);

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    sent,
    failed,
    results,
  });
};
