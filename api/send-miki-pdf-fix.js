// One-time email to Miki confirming PDF upload fix is live on production.
// Run via: curl -H "Authorization: Bearer $CRON_SECRET" https://meetdossie.com/api/send-miki-pdf-fix

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const RECIPIENT_EMAIL = 'mikirgvrealtor@gmail.com';
const FROM_ADDRESS = 'heath@meetdossie.com';

const emailText = `Hey Miki,

Update — the PDF upload bug you flagged is now fixed and live on meetdossie.com.

Quick context: the issue wasn't your PDFs. Vercel (the host) was silently rejecting files over a size threshold before our code ever saw them. We rerouted uploads to go directly to our storage, which removes that ceiling. Every customer benefits, but you're the one who surfaced it.

To see the fix on your end:
- Desktop: Ctrl + Shift + R (Windows) or Cmd + Shift + R (Mac)
- Phone: close and reopen the browser, or pull down to refresh
- If the new upload still errors out, please reply to this email with a screenshot — that's the fastest way to diagnose

Then give the executed contract upload another try. Should work first time.

Genuinely thank you. You found a problem that was hitting almost every founding member silently and you took the time to tell us instead of bouncing. That's the kind of feedback that makes Dossie sharper.

— Heath`;

async function sendEmail() {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [RECIPIENT_EMAIL],
      subject: 'Update — upload fix is live',
      text: emailText,
      bcc: ['heath@meetdossie.com'],
    }),
  });

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch {}

  return { ok: res.ok, status: res.status, data, raw };
}

module.exports = async function handler(req, res) {
  // Auth
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'RESEND_API_KEY not configured' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const result = await sendEmail();
    if (result.ok && result.data && result.data.id) {
      console.log(`[send-miki-pdf-fix] sent OK to ${RECIPIENT_EMAIL}, message ID: ${result.data.id}`);
      return res.status(200).json({
        ok: true,
        recipient: RECIPIENT_EMAIL,
        messageId: result.data.id,
      });
    } else {
      console.error(`[send-miki-pdf-fix] send FAILED:`, result.status, (result.raw || '').slice(0, 300));
      return res.status(500).json({
        ok: false,
        error: `Resend returned ${result.status}`,
        details: result.data,
      });
    }
  } catch (err) {
    console.error('[send-miki-pdf-fix] uncaught error:', err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
