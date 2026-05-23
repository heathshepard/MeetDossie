// Vercel Serverless Function: /api/send-jen-second-touch
//
// SINGLE-PURPOSE one-shot endpoint. Sends a second-touch email to Jennifer
// Beltran (jenn.casamiateam@gmail.com) re: her unfinished Dossie founding
// signup. Hardcoded recipient + subject + body, so no auth is required —
// a leaked URL can only resend the same email to the same person.
//
// Background: Jennifer created her Dossie account 2026-05-22, replied "got it"
// to Heath's first nudge 2026-05-23, but hasn't paid as of the time this was
// shipped. Heath wants a soft second touch at 5 PM CDT today.
//
// TO BE DELETED after Jennifer either pays or definitively passes (Heath will
// say "delete it" in chat). Until then this file is intentionally one-off.
//
// Schedule: invoked by a one-time Anthropic-cloud routine at 2026-05-23T22:00:00Z.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const STRIPE_FOUNDING_PAYMENT_LINK = process.env.STRIPE_FOUNDING_PAYMENT_LINK;

const TO = 'jenn.casamiateam@gmail.com';
const SUBJECT = 'Quick second-touch on your Dossie founding spot';
const BODY_TEMPLATE = `Hey Jennifer,

Heath again — just floating this back up before your day wraps. Your founding spot at $29/month is still open, and the link below is pre-filled with your email so checkout takes under a minute:

{{FOUNDING_PAYMENT_LINK}}

A few things worth knowing:

- That $29 price is locked for as long as your subscription stays active. Standard pricing is $79/month.
- You'd be the 2nd founding member from the Rio Grande Valley (Miki McCarthy joined a few days ago). RGV is becoming a real beachhead for Dossie and Casa Mia is exactly the kind of brokerage I built this for.
- If something on the payment page didn't work earlier, hit reply and I'll fix it personally — I respond to every founding-member email.

No pressure either way. If now isn't the right time, I'll send your founding spot to the next person on the waitlist and clear it from my pipeline. Just let me know.

— Heath
Founder, Dossie
heath@meetdossie.com`;

// In-memory dedupe so the same Vercel function instance can't double-send
// within a single hot-warm window. (Cold starts reset this — acceptable
// failure mode given the routine is configured to fire exactly once.)
let lastFireMs = 0;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 min

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(text) {
  const escaped = escapeHtml(text).replace(/\n/g, '<br>');
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1C2B3A;line-height:1.7;">${escaped}</div>`;
}

export default async function handler(req, res) {
  // POST-only on purpose. A HEAD or GET probe accidentally fired the
  // handler during initial deploy verification 2026-05-23, sending the
  // email ~7 hours early. Restricting to POST removes that footgun for
  // any future one-shot endpoint based on this pattern.
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'resend_not_configured' });
  }
  if (!STRIPE_FOUNDING_PAYMENT_LINK) {
    return res.status(500).json({ ok: false, error: 'payment_link_not_configured' });
  }

  const now = Date.now();
  if (now - lastFireMs < DEDUPE_WINDOW_MS) {
    return res.status(429).json({ ok: false, error: 'dedupe_window_active', last_fire_ms_ago: now - lastFireMs });
  }

  const url = new URL(STRIPE_FOUNDING_PAYMENT_LINK);
  url.searchParams.set('prefilled_email', TO);
  const bodyText = BODY_TEMPLATE.replace(/\{\{FOUNDING_PAYMENT_LINK\}\}/g, url.toString());

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Heath at Dossie <heath@meetdossie.com>',
        to: [TO],
        subject: SUBJECT,
        html: renderHtml(bodyText),
        reply_to: 'heath@meetdossie.com',
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'resend_failed', status: r.status, data });
    }
    lastFireMs = now;
    return res.status(200).json({ ok: true, id: data?.id, to: TO, fired_at: new Date(now).toISOString() });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'fetch_failed', message: String(err && err.message) });
  }
}
