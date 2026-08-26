// Vercel Serverless Function: /api/send-reply-ticket-503a1d1b
//
// One-time reply to support ticket 503a1d1b-3c49-4a25-abe1-27eb94afd62f
// (Amanda Nuckles, amanda@amandanuckles.com, filed 2026-08-24 19:26 UTC:
// "How do I cancel my account?").
//
// Investigation: her cancellation was already processed manually by Heath the
// same day (see docs/CUSTOMERS.md) and she already received both a Stripe
// cancellation-confirmation email and a separate thank-you email
// (api/send-thankyou-cancelled-20260824.js). The underlying gap her question
// exposed — no self-serve cancel button in Settings — is fixed and confirmed
// live in production (commits b578037b/978bddfa/866197c5/6787d410; verified
// against https://meetdossie.com/app via scripts/carter-cancel-sub-verify.js).
//
// This is a short, direct answer to her literal question, closing the loop —
// not a third "sorry about the bug" email. No dwelling on the underlying gap.
//
// Auth:        Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Idempotency: Only sends if today is 2026-08-26 (UTC), unless ?force=1.
// One-off — not on vercel.json cron schedule, triggered manually once.

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_ADDRESS = 'heath@meetdossie.com';
const TARGET_DATE_UTC = '2026-08-26'; // YYYY-MM-DD
const TO_ADDRESS = 'amanda@amandanuckles.com';

const SUBJECT = 'Re: How do I cancel my account?';
const TEXT = `Hey Amanda,

Answering directly — your account is already cancelled. You'll keep full access through 2026-09-20 (the end of your paid period), then it locks. No further action needed on your end.

I've also added a "Cancel Subscription" button right in Settings > Billing, so if you (or anyone) ever need to do this again it's one click — no need to email in.

Thanks again for giving Dossie a shot.

Heath`;

async function sendEmail() {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [TO_ADDRESS],
      subject: SUBJECT,
      text: TEXT,
      bcc: ['heath@meetdossie.com'],
    }),
  });
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  return { ok: r.ok, status: r.status, data, raw };
}

module.exports = async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const todayUTC = new Date().toISOString().slice(0, 10);
    if (todayUTC !== TARGET_DATE_UTC && req.query.force !== '1') {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: `today is ${todayUTC}, target date is ${TARGET_DATE_UTC}`,
      });
    }

    if (!RESEND_API_KEY) {
      return res.status(500).json({ ok: false, error: 'RESEND_API_KEY not configured' });
    }

    const result = await sendEmail();
    if (!result.ok) {
      console.error('[send-reply-ticket-503a1d1b] send FAILED:', result.status, (result.raw || '').slice(0, 300));
      return res.status(502).json({ ok: false, status: result.status, raw: (result.raw || '').slice(0, 300) });
    }

    console.log('[send-reply-ticket-503a1d1b] sent OK:', TO_ADDRESS);
    return res.status(200).json({ ok: true, to: TO_ADDRESS, id: result.data && result.data.id });
  } catch (err) {
    console.error('[send-reply-ticket-503a1d1b] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
