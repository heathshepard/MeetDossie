// Vercel Serverless Function: /api/send-thankyou-cancelled-20260824
//
// One-time thank-you emails to two cancelled founding members (Miki, Amanda).
// Heath approved both bodies verbatim — send exactly as written, no rewording.
//
// Auth:        Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Idempotency: Only sends if today is 2026-08-24 (UTC), unless ?force=1.
// One-off — not on vercel.json cron schedule, triggered manually once.

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_ADDRESS = 'heath@meetdossie.com';
const TARGET_DATE_UTC = '2026-08-24'; // YYYY-MM-DD

const emails = [
  {
    key: 'miki',
    to: 'mikirgvrealtor@gmail.com',
    subject: 'Thank you, Miki',
    text: `Hey Miki,

Thank you for the feedback — genuinely, it's some of the most useful I've gotten. The PDF upload bug you hit is already fixed, and everything else you flagged is going into how I think about building this going forward. You helped make Dossie better, even on your way out, and I mean that.

Your account's cancelled as of your request. If you'd be open to it, I'd love to send you the occasional update as Dossie keeps improving — no pressure either way, and no obligation to come back. But the door's open whenever you want it, hopefully to a much better version of this.

Thanks again,
Heath`,
  },
  {
    key: 'amanda',
    to: 'amanda@amandanuckles.com',
    subject: 'Thank you, Amanda',
    text: `Hey Amanda,

Thank you so much for being part of Dossie from the start. Your account's cancelled as of your request — no hard feelings at all, and I really appreciate you giving it a shot.

The door's always open if you ever want to come back once it's even better.

Thanks,
Heath`,
  },
];

async function sendEmail({ to, subject, text }) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      text,
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

    const sent = [];
    const failed = [];

    for (const email of emails) {
      const result = await sendEmail(email);
      if (result.ok) {
        sent.push({ key: email.key, to: email.to, id: result.data && result.data.id });
        console.log(`[send-thankyou-cancelled-20260824] sent OK: ${email.to}`);
      } else {
        failed.push({ key: email.key, to: email.to, status: result.status, raw: (result.raw || '').slice(0, 300) });
        console.error(`[send-thankyou-cancelled-20260824] send FAILED: ${email.to}`, result.status, (result.raw || '').slice(0, 300));
      }
    }

    return res.status(200).json({
      ok: true,
      date: todayUTC,
      sent,
      failed,
    });
  } catch (err) {
    console.error('[send-thankyou-cancelled-20260824] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
