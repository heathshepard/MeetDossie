// Vercel Serverless Function: /api/send-customer-update
//
// One-time product update email to all founding members — plain text, from
// heath@meetdossie.com, personalized by first name.
//
// Auth:        Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Idempotency: Only sends if today is 2026-05-27 (UTC). All other days return
//              200 { skipped: true } immediately.
// Schedule:    vercel.json — "0 13 27 5 *" (13:00 UTC = 8:00 AM CDT May 27 2026)
//
// After sending, fires a Telegram notification to Heath summarizing results.

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID = '7874782923';
const FROM_ADDRESS = 'heath@meetdossie.com';
const EMAIL_SUBJECT = 'Two things just got better in Dossie';

const TARGET_DATE_UTC = '2026-05-27'; // YYYY-MM-DD

const recipients = [
  { name: 'Brittney', email: 'brittney@setxrealty.com' },
  { name: 'Suzanne', email: 'k.suzanne.page@gmail.com' },
  { name: 'Miki', email: 'mikirgvrealtor@gmail.com' },
  { name: 'Cecilia', email: 'cecilia@sterlingassociatesre.com' },
  { name: 'Terry', email: 'michellesellshouston@gmail.com' },
  { name: 'Amanda', email: 'amanda@amandanuckles.com' },
  { name: 'Zelda', email: 'zelda@a2zrealestateconsultants.com' },
  { name: 'Natalie', email: 'natalie@localchoicegroup.com' },
  { name: 'Jennifer', email: 'jenn.casamiateam@gmail.com' },
];

// ─── Email body builder ──────────────────────────────────────────────────

function buildEmailText(firstName) {
  return `Hey ${firstName},

Quick update - two things just shipped.

Mobile is fixed. The dossier detail view had layout issues on Android and iPhone - required docs, action items, and documents were all formatting incorrectly. That's resolved.

Amendment drafting is live. Open any dossier, tap Talk to Dossie, and tell her what needs to change. "Extend the option period by 7 days" or "update closing date to June 15." She generates a pre-filled TREC 39-10 amendment PDF you can download and send for signatures.

Log in at meetdossie.com/app and try it. Reply with any questions - I read every message.

- Heath`;
}

// ─── Resend sender ───────────────────────────────────────────────────────

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
    }),
  });
  const raw = await r.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}
  return { ok: r.ok, status: r.status, data, raw };
}

// ─── Telegram notifier ───────────────────────────────────────────────────

async function sendTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error('[send-customer-update] Telegram notify failed:', err.message);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  try {
    // Auth: Vercel cron header OR manual Bearer token
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // Idempotency: only fire on the target date (UTC)
    const todayUTC = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (todayUTC !== TARGET_DATE_UTC) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: `today is ${todayUTC}, target date is ${TARGET_DATE_UTC}`,
      });
    }

    if (!RESEND_API_KEY) {
      return res.status(500).json({ ok: false, error: 'RESEND_API_KEY not configured' });
    }
    if (!TELEGRAM_BOT_TOKEN) {
      console.warn('[send-customer-update] TELEGRAM_BOT_TOKEN not set — Telegram notify will be skipped');
    }

    const sent = [];
    const failed = [];

    for (const { name, email } of recipients) {
      const result = await sendEmail(email, name);
      if (result.ok) {
        sent.push(email);
        console.log(`[send-customer-update] sent OK: ${email}`);
      } else {
        failed.push({ email, status: result.status, raw: (result.raw || '').slice(0, 200) });
        console.error(`[send-customer-update] send FAILED: ${email}`, result.status, (result.raw || '').slice(0, 200));
      }
    }

    // Telegram summary
    const lines = [
      `*Customer update email sent* (${TARGET_DATE_UTC})`,
      `Sent: ${sent.length}/${recipients.length}`,
    ];
    if (failed.length > 0) {
      lines.push(`Failed: ${failed.map((f) => f.email).join(', ')}`);
    } else {
      lines.push('All delivered successfully.');
    }
    await sendTelegram(lines.join('\n'));

    return res.status(200).json({
      ok: true,
      date: todayUTC,
      sent: sent.length,
      failed: failed.length,
      failures: failed,
    });
  } catch (err) {
    console.error('[send-customer-update] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
