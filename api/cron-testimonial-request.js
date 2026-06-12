// Vercel Serverless Function: /api/cron-testimonial-request
//
// Daily cron: finds transactions that closed 3-4 days ago with no testimonial
// reminder sent yet, then emails the agent a ready-to-forward review request
// with their Google and Zillow review links pre-populated.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 14 * * *" (2PM UTC = 9AM CDT daily)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';
const BRAND_SAGE = '#8BA888';

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

function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.startsWith('heath.shepard@')) return true;
  if (e.includes('demo')) return true;
  return false;
}

function todayChicagoYMD() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function addDaysYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function buildEmailHtml({ firstName, propertyAddress, googleReviewUrl, zillowReviewUrl }) {
  const name = (firstName || '').trim() || 'there';
  const property = propertyAddress || 'your recently closed property';

  const googleBlock = googleReviewUrl
    ? `<a href="${googleReviewUrl}" style="display: inline-block; margin: 6px 8px 6px 0; padding: 10px 20px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 14px;">Leave a Google Review</a>`
    : `<span style="font-size: 13px; color: ${BRAND_MUTED};">Google review link not set - add it in <a href="https://meetdossie.com/app" style="color: ${BRAND_CORAL};">Settings</a>.</span>`;

  const zillowBlock = zillowReviewUrl
    ? `<a href="${zillowReviewUrl}" style="display: inline-block; margin: 6px 8px 6px 0; padding: 10px 20px; background: ${BRAND_NAVY}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 14px;">Leave a Zillow Review</a>`
    : `<span style="font-size: 13px; color: ${BRAND_MUTED};">Zillow review link not set - add it in <a href="https://meetdossie.com/app" style="color: ${BRAND_CORAL};">Settings</a>.</span>`;

  const suggestedCopy = `Hi [Client name],

It was such a pleasure working with you on ${property}. I hope you're settling in and loving the new place.

If you have a moment, I'd be grateful if you could leave a quick review - it means everything to small businesses like mine and helps other buyers/sellers find someone they can trust.

${googleReviewUrl ? `Google: ${googleReviewUrl}` : ''}
${zillowReviewUrl ? `Zillow: ${zillowReviewUrl}` : ''}

Thank you so much - it was truly a joy to work with you.

[Your name]`;

  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE &middot; REVIEW REQUEST</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 32px; line-height: 1.2; margin: 0 0 22px; color: ${BRAND_NAVY};">Hi ${name},</h1>
  <p style="font-size: 17px; color: ${BRAND_NAVY}; line-height: 1.6; margin: 0 0 10px;">Your client from <strong>${property}</strong> closed 3 days ago - a great time to ask for a review while the experience is still fresh.</p>
  <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">Forward the message below to your client, or use your own words. Your review links are ready to go.</p>

  <div style="margin: 0 0 28px;">
    <div style="font-size: 12px; font-weight: 700; letter-spacing: 1px; color: ${BRAND_MUTED}; text-transform: uppercase; margin-bottom: 12px;">Your review links</div>
    <div>${googleBlock}</div>
    <div style="margin-top: 8px;">${zillowBlock}</div>
  </div>

  <div style="background: #F5F0EA; border-radius: 12px; padding: 20px 22px; margin: 0 0 28px;">
    <div style="font-size: 12px; font-weight: 700; letter-spacing: 1px; color: ${BRAND_MUTED}; text-transform: uppercase; margin-bottom: 12px;">Suggested message to forward</div>
    <pre style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 14px; color: ${BRAND_NAVY}; line-height: 1.7; white-space: pre-wrap; margin: 0;">${suggestedCopy}</pre>
  </div>

  <a href="https://meetdossie.com/app" style="display: inline-block; padding: 16px 32px; background: ${BRAND_SAGE}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; letter-spacing: 0.2px;">Open Dossie</a>

  <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: ${BRAND_NAVY}; line-height: 1.4; margin: 28px 0 4px;">- Dossie</p>
  <p style="margin-top: 36px; font-size: 12px; color: ${BRAND_MUTED}; line-height: 1.6;">This reminder fires once, 3 days after a deal closes. To add or update your review links, go to Settings inside Dossie.</p>
</div>`;
}

async function sendResend(to, subject, html) {
  // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

module.exports = withTelemetry('cron-testimonial-request', async function handler(req, res) {
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

    const today = todayChicagoYMD();
    // "3 days ago" = closing_date between 3 and 4 days ago (exclusive window to avoid double-sends)
    const threeDaysAgo = addDaysYMD(today, -3);
    const fourDaysAgo = addDaysYMD(today, -4);

    // Fetch closed transactions with closing_date exactly 3 days ago, no testimonial sent yet.
    // Using gte(fourDaysAgo) AND lt(threeDaysAgo) creates a one-day exclusive window.
    const txResp = await supabaseFetch(
      `/rest/v1/transactions?status=eq.closed&closing_date=eq.${threeDaysAgo}&testimonial_requested_at=is.null&select=id,user_id,property_address,closing_date`,
    );
    if (!txResp.ok) {
      return res.status(500).json({ ok: false, error: `transactions fetch failed: ${txResp.status}` });
    }
    const transactions = txResp.data || [];

    if (transactions.length === 0) {
      return res.status(200).json({ ok: true, today, threeDaysAgo, scanned: 0, sent: 0, errors: [] });
    }

    // Collect unique user IDs and fetch their profiles + subscription status in bulk.
    const userIds = [...new Set(transactions.map((t) => t.user_id).filter(Boolean))];
    const filterStr = userIds.map((id) => `"${id}"`).join(',');

    const [profResp, subResp] = await Promise.all([
      supabaseFetch(`/rest/v1/profiles?id=in.(${filterStr})&select=id,email,full_name,is_demo,google_review_url,zillow_review_url`),
      supabaseFetch(`/rest/v1/subscriptions?user_id=in.(${filterStr})&status=eq.active&select=user_id`),
    ]);

    const profilesById = new Map((profResp.data || []).map((p) => [p.id, p]));
    const activeUserIds = new Set((subResp.data || []).map((s) => s.user_id));

    const summary = {
      ok: true,
      today,
      threeDaysAgo,
      scanned: transactions.length,
      sent: 0,
      skipped_no_sub: 0,
      skipped_excluded: 0,
      errors: [],
    };

    for (const tx of transactions) {
      const profile = profilesById.get(tx.user_id);
      if (!profile) continue;
      if (profile.is_demo) continue;
      if (isExcludedEmail(profile.email)) { summary.skipped_excluded++; continue; }
      if (!activeUserIds.has(tx.user_id)) { summary.skipped_no_sub++; continue; }

      const firstName = (profile.full_name || profile.email || '').split(/[\s.@]/)[0] || 'there';
      const subject = `Your client from ${tx.property_address || 'your closed deal'} is ready for a review request`;
      const html = buildEmailHtml({
        firstName,
        propertyAddress: tx.property_address,
        googleReviewUrl: profile.google_review_url || null,
        zillowReviewUrl: profile.zillow_review_url || null,
      });

      const send = await sendResend(profile.email, subject, html);
      if (!send.ok) {
        console.error('[cron-testimonial-request] resend failed', profile.email, send.status, (send.raw || '').slice(0, 200));
        summary.errors.push({ user_id: tx.user_id, tx_id: tx.id, status: send.status, error: (send.raw || '').slice(0, 200) });
        continue;
      }

      // Mark the transaction so we don't send again.
      await supabaseFetch(
        `/rest/v1/transactions?id=eq.${encodeURIComponent(tx.id)}&user_id=eq.${encodeURIComponent(tx.user_id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ testimonial_requested_at: new Date().toISOString() }),
        },
      );

      summary.sent++;
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[cron-testimonial-request] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
