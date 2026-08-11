// Vercel Serverless Function: /api/cron-cold-email-followup
//
// Runs daily Mon-Fri at 10:00 CDT (15:00 UTC), 1 hour after the daily batch.
// Checks for sent touch-1/2/3 emails that are 3+ days old with no reply,
// no unsubscribe, and no bounce — and queues the next touch.
//
// Sequence:
//   Touch 1: "$400 per file?" (queued by cron-cold-email-daily-batch)
//   Touch 2: 3 days later — short bump, re-ask
//   Touch 3: 3 days later — social proof + specific value
//   Touch 4: 3 days later — breakup, no hard feelings
//
// Auth: Bearer ${CRON_SECRET}
// Schedule: 0 15 * * 1-5

const { recordCronRun } = require('./_lib/cron-telemetry.js');
const { isSuppressed } = require('./_lib/check-suppression.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const FROM_EMAIL = 'heath@meetdossie.com';
const REPLY_TO = 'heath@meetdossie.com';
const FOUNDING_URL = 'https://meetdossie.com/founding?utm_source=cold-email&utm_medium=email&utm_content=followup';
const UNSUB_URL = 'https://meetdossie.com/unsubscribe';
const NW_ADDRESS = 'Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731';

const TOUCH_DELAY_DAYS = 3;
const MAX_FOLLOWUPS_PER_RUN = 25;

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// ── Touch 2: Short bump ─────────────────────────────────────────────

function touch2Subject() {
  return 'quick follow-up';
}

function touch2Text(city, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `Hey - sent you a note a few days ago about what you're paying per file for TC work.

Not trying to be pushy. I built Dossie because I was tired of the $400/file math myself. She handles amendments, deadlines, and follow-up emails for $29/mo flat.

If the timing's wrong, no worries at all. Just reply "not now" and I'll leave you be.

- Heath

---
Unsubscribe: ${unsub}
${NW_ADDRESS}
`;
}

function touch2Html(city, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 560px;">
<p>Hey - sent you a note a few days ago about what you're paying per file for TC work.</p>

<p>Not trying to be pushy. I built Dossie because I was tired of the $400/file math myself. She handles amendments, deadlines, and follow-up emails for $29/mo flat.</p>

<p>If the timing's wrong, no worries at all. Just reply "not now" and I'll leave you be.</p>

<p>- Heath</p>

<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;">
<p style="font-size: 11px; color: #888;">
<a href="${unsub}" style="color: #888;">Unsubscribe</a> | ${NW_ADDRESS}
</p>
</div>`;
}

// ── Touch 3: Social proof + specific value ──────────────────────────

function touch3Subject() {
  return 'the control freak problem';
}

function touch3Text(city, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `One of our founding members - a broker doing 80 transactions a year - told me: "the lack of systems I have in place isn't sustainable."

That's exactly why I built Dossie. She's not a generic task app. She knows TREC deadlines, drafts the actual amendment emails, and follows up so you don't have to.

The agents using her aren't delegating and hoping. They're reviewing what she drafted and hitting send. Big difference.

If you're closing 2+ deals a month, the $29 pays for itself on the first file: ${FOUNDING_URL}

- Heath

---
Unsubscribe: ${unsub}
${NW_ADDRESS}
`;
}

function touch3Html(city, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 560px;">
<p>One of our founding members - a broker doing 80 transactions a year - told me: "the lack of systems I have in place isn't sustainable."</p>

<p>That's exactly why I built Dossie. She's not a generic task app. She knows TREC deadlines, drafts the actual amendment emails, and follows up so you don't have to.</p>

<p>The agents using her aren't delegating and hoping. They're reviewing what she drafted and hitting send. Big difference.</p>

<p>If you're closing 2+ deals a month, the $29 pays for itself on the first file: <a href="${FOUNDING_URL}">meetdossie.com/founding</a></p>

<p>- Heath</p>

<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;">
<p style="font-size: 11px; color: #888;">
<a href="${unsub}" style="color: #888;">Unsubscribe</a> | ${NW_ADDRESS}
</p>
</div>`;
}

// ── Touch 4: Breakup ────────────────────────────────────────────────

function touch4Subject() {
  return 'last one from me';
}

function touch4Text(city, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `Hey - this is my last email. I don't want to be that guy.

If you ever need an AI transaction coordinator that handles the paperwork side for $29/mo, the link's here: ${FOUNDING_URL}

No follow-up, no drip campaign. If the timing's ever right, you know where to find me.

- Heath

---
Unsubscribe: ${unsub}
${NW_ADDRESS}
`;
}

function touch4Html(city, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 560px;">
<p>Hey - this is my last email. I don't want to be that guy.</p>

<p>If you ever need an AI transaction coordinator that handles the paperwork side for $29/mo, the link's here: <a href="${FOUNDING_URL}">meetdossie.com/founding</a></p>

<p>No follow-up, no drip campaign. If the timing's ever right, you know where to find me.</p>

<p>- Heath</p>

<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;">
<p style="font-size: 11px; color: #888;">
<a href="${unsub}" style="color: #888;">Unsubscribe</a> | ${NW_ADDRESS}
</p>
</div>`;
}

// ── Touch builders ──────────────────────────────────────────────────

const TOUCHES = {
  2: { subject: touch2Subject, text: touch2Text, html: touch2Html, hook: 'followup-bump' },
  3: { subject: touch3Subject, text: touch3Text, html: touch3Html, hook: 'followup-control-freak' },
  4: { subject: touch4Subject, text: touch4Text, html: touch4Html, hook: 'followup-breakup' },
};

// ── Main handler ────────────────────────────────────────────────────

async function handler(req, res) {
  const startedAt = Date.now();
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE config' });
  }

  try {
    const result = { queued: 0, suppressed: 0, skipped: 0, errors: 0, by_touch: {} };

    for (const prevTouch of [1, 2, 3]) {
      const nextTouch = prevTouch + 1;
      const touchDef = TOUCHES[nextTouch];
      if (!touchDef) continue;

      const candidates = await findFollowupCandidates(prevTouch);
      result.by_touch[`touch_${prevTouch}_to_${nextTouch}`] = candidates.length;

      for (const prev of candidates) {
        if (result.queued >= MAX_FOLLOWUPS_PER_RUN) break;

        const to = prev.to_email.toLowerCase();
        if (await isSuppressed(to, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)) {
          result.suppressed++;
          continue;
        }

        // Check if this touch was already queued
        if (await touchAlreadyQueued(to, nextTouch)) {
          result.skipped++;
          continue;
        }

        const city = prev.metadata?.city || 'San Antonio';
        const row = {
          to_email: to,
          from_email: FROM_EMAIL,
          subject: touchDef.subject(),
          body_text: touchDef.text(city, to),
          body_html: touchDef.html(city, to),
          reply_to: REPLY_TO,
          status: 'pending',
          metadata: {
            campaign: 'sa-cold-daily-warmup',
            touch: nextTouch,
            hook: touchDef.hook,
            prev_touch_id: prev.id,
            first_name: prev.metadata?.first_name || 'there',
            city,
            brokerage: prev.metadata?.brokerage || '',
            queued_by: 'cron-cold-email-followup',
          },
        };

        const r = await fetch(`${SUPABASE_URL}/rest/v1/outbound_email_queue`, {
          method: 'POST',
          headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify(row),
        });

        if (r.ok || r.status === 201) {
          result.queued++;
        } else {
          result.errors++;
        }
      }
    }

    const duration_ms = Date.now() - startedAt;
    recordCronRun('cron-cold-email-followup', 'ok', { duration_ms, ...result }).catch(() => {});
    return res.status(200).json({ ok: true, duration_ms, ...result });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const msg = err?.message?.slice(0, 500) || 'crash';
    recordCronRun('cron-cold-email-followup', 'error', { duration_ms, error: msg }).catch(() => {});
    return res.status(500).json({ ok: false, error: msg, duration_ms });
  }
}

async function findFollowupCandidates(touchNum) {
  const cutoff = new Date(Date.now() - TOUCH_DELAY_DAYS * 86400000).toISOString();

  // Find sent emails for this touch that are old enough for follow-up.
  // metadata->>touch is stored as a number in JSONB.
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?` +
    `status=eq.sent&` +
    `metadata->>touch=eq.${touchNum}&` +
    `metadata->>campaign=eq.sa-cold-daily-warmup&` +
    `sent_at=lt.${cutoff}&` +
    `select=id,to_email,metadata,sent_at&` +
    `order=sent_at.asc&limit=100`;

  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows : [];
}

async function touchAlreadyQueued(email, touchNum) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?` +
    `to_email=eq.${encodeURIComponent(email)}&` +
    `metadata->>touch=eq.${touchNum}&` +
    `metadata->>campaign=eq.sa-cold-daily-warmup&` +
    `select=id&limit=1`;

  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = handler;
module.exports.default = handler;
