// One-time endpoint: send TREC July 1 compliance alert to all active subscribers.
// Auth: Authorization: Bearer ${CRON_SECRET}
// Fire once via curl — not scheduled.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // 1. Fetch active subscriptions
    const subsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?status=eq.active&select=user_id,plan`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!subsRes.ok) {
      const err = await subsRes.text();
      return res.status(500).json({ error: 'Failed to fetch subscriptions', detail: err });
    }
    const subscriptions = await subsRes.json();

    // 2. Fetch non-demo profiles
    const profilesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?is_demo=eq.false&select=id,full_name,email`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!profilesRes.ok) {
      const err = await profilesRes.text();
      return res.status(500).json({ error: 'Failed to fetch profiles', detail: err });
    }
    const profiles = await profilesRes.json();

    // 3. Build lookup: profile id -> { full_name, email }
    const profileMap = {};
    for (const p of profiles) {
      profileMap[p.id] = p;
    }

    // 4. Build recipient list
    const recipients = [];
    for (const sub of subscriptions) {
      const profile = profileMap[sub.user_id];
      // Use profile email if present, fall back to subscription email
      const email = profile && profile.email ? profile.email : null;
      if (!email) continue;

      const fullName = profile && profile.full_name ? profile.full_name : '';
      const firstName = fullName.trim().split(/\s+/)[0] || 'there';

      recipients.push({ email, firstName });
    }

    // 5. Send emails via Resend
    const sent = [];
    const failed = [];

    // Optional: only send to specific emails (for retrying failed sends)
    const onlyEmails = req.body && req.body.only_emails;
    const targets = onlyEmails
      ? recipients.filter(r => onlyEmails.includes(r.email))
      : recipients;

    for (const { email, firstName } of targets) {
      const body = `Hey ${firstName},

Quick heads up on something that affects every deal you close after July 1.

TREC is replacing most of its major promulgated forms next month. The big ones: the One to Four Family Resale contract goes from version 20-18 to 20-19, the Amendment to Contract changes to 39-11, and most of the standard addenda are getting new versions as well. There's also a new mandatory Water Disclosure form that kicks in at the same time.

After July 1, the old form versions are noncompliant. Worth checking with your broker on your firm's process for making the switch.

I wanted to make sure you heard this before it snuck up on you. Dossie will have the updated form versions in the app before July 1 - so if you're working transactions through her, she'll automatically be using the right versions when the date hits.

Check trec.texas.gov for the full list if you want to read the actual changes ahead of time. I've already been through them and will make sure nothing slips through.

More soon,

Heath
heath@meetdossie.com
Licensed Texas REALTOR | Founder, Dossie`;

      // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
      const sendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Heath Shepard <heath@meetdossie.com>',
          to: email,
          subject: 'Heads up - TREC forms are changing July 1',
          text: body,
        }),
      });

      if (sendRes.ok) {
        sent.push(email);
      } else {
        const errText = await sendRes.text();
        failed.push({ email, error: errText });
      }

      // Stay under Resend's 5 req/sec rate limit
      await new Promise(r => setTimeout(r, 300));
    }

    return res.status(200).json({
      sent,
      failed,
      total: recipients.length,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
