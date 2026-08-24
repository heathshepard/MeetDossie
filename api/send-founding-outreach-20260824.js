// Vercel Serverless Function: /api/send-founding-outreach-20260824
//
// One-time personalized outreach email to the 9 active founding members
// (excludes Amanda Nuckles — she got a separate personalized 1:1 email
// the same day re: her cancellation request).
//
// Auth:        Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Idempotency: Only sends if today is 2026-08-24 (UTC). All other days
//              return 200 { skipped: true } immediately.
// One-off — not on vercel.json cron schedule, triggered manually once.

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const FROM_ADDRESS = 'heath@meetdossie.com';
const EMAIL_SUBJECT = 'A genuine ask — what would make Dossie work for you?';
const TARGET_DATE_UTC = '2026-08-24'; // YYYY-MM-DD

const recipients = [
  { name: 'Kimberly', email: 'kimberlyherrera@kw.com' },
  { name: 'Tiffany', email: 'tgill@phyllisbrowning.com' },
  { name: 'Brittney', email: 'brittney@setxrealty.com' },
  { name: 'Suzanne', email: 'k.suzanne.page@gmail.com' },
  { name: 'Miki', email: 'mikirgvrealtor@gmail.com' },
  { name: 'Cecilia', email: 'cecilia@sterlingassociatesre.com' },
  { name: 'Terry', email: 'michellesellshouston@gmail.com' },
  { name: 'Natalie', email: 'natalie@localchoicegroup.com' },
  { name: 'Lisa', email: 'lisanilssontx@gmail.com' },
];

function buildEmailText(firstName) {
  return `Hey ${firstName},

I built Dossie, and I want to be straight with you: I don't have a great sense of how it's actually working for you day to day, and I'd love to fix that.

If something's confusing, missing, or just not quite what you need — tell me. I'm not a support team, I'm the developer. If there's a feature you wish it had, I can build it. If you're not sure how to use something, I'll walk you through it myself — happy to hop on a quick Zoom and show you around, or just answer questions over text.

No pitch here, just: what would it take for Dossie to actually earn a spot in your daily workflow? I'd genuinely love to know.

Thanks,
Heath`;
}

async function sendEmail(toEmail, firstName) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [toEmail],
      subject: EMAIL_SUBJECT,
      text: buildEmailText(firstName),
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

    for (const { name, email } of recipients) {
      const result = await sendEmail(email, name);
      if (result.ok) {
        sent.push({ email, name, id: result.data && result.data.id });
        console.log(`[send-founding-outreach-20260824] sent OK: ${email}`);
      } else {
        failed.push({ email, name, status: result.status, raw: (result.raw || '').slice(0, 300) });
        console.error(`[send-founding-outreach-20260824] send FAILED: ${email}`, result.status, (result.raw || '').slice(0, 300));
      }
    }

    return res.status(200).json({
      ok: true,
      date: todayUTC,
      sent,
      failed,
    });
  } catch (err) {
    console.error('[send-founding-outreach-20260824] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
