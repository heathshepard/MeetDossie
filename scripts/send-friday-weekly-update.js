// scripts/send-friday-weekly-update.js
//
// Schedules the Friday 2026-06-19 8:30am CST Weekly Update via Resend's native
// scheduled_at feature. Approved body lives inline below (Heath signed off).
//
// Run locally with env vars from .env.local.restored-round2-2026-06-17:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RESEND_API_KEY=... \
//     node scripts/send-friday-weekly-update.js
//
// Behavior:
//   1. Loads recipients via Supabase REST: active subscriptions + non-demo profiles,
//      excludes Heath's test accounts.
//   2. Per recipient, derives first_name from full_name (first whitespace-split token).
//   3. POSTs to Resend with scheduled_at = 2026-06-19T13:30:00.000Z (CDT 8:30am).
//   4. Logs each Resend message_id so we can cancel/inspect later.
//
// Idempotency: if you re-run, Resend will create new scheduled emails — DO NOT
// re-run unless you first cancel the previous batch via the Resend dashboard.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
  console.error('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY');
  process.exit(1);
}

// Friday 2026-06-19 8:30am America/Chicago (CDT = UTC-5) -> 13:30 UTC
const SCHEDULED_AT = '2026-06-19T13:30:00.000Z';

// DRY_RUN=1 will preview the roster + HTML without hitting Resend.
const DRY_RUN = process.env.DRY_RUN === '1';

const FROM = 'Heath at Dossie <heath@meetdossie.com>';
const REPLY_TO = 'heath@meetdossie.com';
const SUBJECT = '7 things shipped in Dossie this week';

const IMG_HELP_CENTER = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/email-assets/friday-2026-06-19-help-center.png';
const IMG_TESTIMONIAL = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/email-assets/friday-2026-06-19-testimonial-button.png';
const IMG_TREC = 'https://pgwoitbdiyubjugwufhk.supabase.co/storage/v1/object/public/email-assets/friday-2026-06-19-trec-autofill.png';

// Heath's test accounts — exclude.
const EXCLUDE_EMAILS = new Set([
  'heath.shepard+test3@gmail.com',
  'heath.shepard+test4@gmail.com',
  'heathtestaccount@gmail.com',
]);

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function firstNameFrom(fullName, email) {
  const trimmed = String(fullName || '').trim();
  if (trimmed) {
    const first = trimmed.split(/\s+/)[0];
    if (first && first.length > 0) return first;
  }
  // Fallback: derive from local-part of email, title-cased.
  const local = String(email || '').split('@')[0].split(/[._+-]/)[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1).toLowerCase() : 'there';
}

function buildHtml(firstName) {
  const imgStyle = 'max-width:100%;border-radius:8px;display:block;margin:14px 0 22px 0;border:1px solid #EAE1D8;';
  const wrap = 'font-family:Georgia, "Cormorant Garamond", serif;max-width:620px;margin:0 auto;padding:40px 24px;color:#1A1A2E;line-height:1.7;font-size:16px;';
  const strong = 'font-family:Georgia, "Cormorant Garamond", serif;font-weight:700;color:#1A1A2E;font-size:18px;display:block;margin-top:28px;margin-bottom:6px;';
  const p = 'margin:0 0 12px 0;';
  const footer = 'margin-top:36px;padding-top:18px;border-top:1px solid #EAE1D8;color:#7E776F;font-size:13px;line-height:1.6;';

  const safeFirst = escapeHtml(firstName);

  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#FBF7F2;">
<div style="${wrap}">
<p style="${p}">Hey ${safeFirst},</p>

<p style="${p}">Quick rundown of what's new in your workspace this week.</p>

<span style="${strong}">Help Center is live</span>
<p style="${p}">Tap the "?" in your sidebar for a searchable library covering Morning Brief, Talk to Dossie, DossieSign, TREC deadlines, Compliance Vault, and more.</p>
<img src="${IMG_HELP_CENTER}" alt="Help Center" style="${imgStyle}" />

<span style="${strong}">Request a Testimonial in one tap (Tiffany Gill asked for this)</span>
<p style="${p}">Every closed deal now has a Request Testimonial button. Tap it and Dossie emails your client a review request with your Google and Zillow links pre-filled. It also auto-fires 3 days post-close so you never have to remember.</p>
<img src="${IMG_TESTIMONIAL}" alt="Request Testimonial button on closed dossier" style="${imgStyle}" />

<span style="${strong}">Save your review links in Settings</span>
<p style="${p}">Add your Google Business and Zillow profile URLs once. Every testimonial Dossie sends after that uses your links automatically.</p>

<span style="${strong}">Both client names on every dossier card (Brittney's catch)</span>
<p style="${p}">Pipeline cards now show buyer and seller names together so you can spot the right deal at a glance.</p>

<span style="${strong}">Move a dossier to any stage (Brittney again)</span>
<p style="${p}">A new Change Stage button on the dossier detail page lets you walk a file forward or backward in your pipeline.</p>

<span style="${strong}">Large PDF uploads now smooth (Miki's catch)</span>
<p style="${p}">Executed contracts and bigger PDFs upload through a direct path now, so heavier files land without a hitch.</p>

<span style="${strong}">Auto-fill on more TREC contracts</span>
<p style="${p}">Dossie now auto-fills the One to Four Family Residential Contract (TREC 20-18), New Home Incomplete and Completed Construction (TREC 23-20 and 24-20), and Farm and Ranch (TREC 25-17). More forms coming.</p>
<img src="${IMG_TREC}" alt="TREC 20-18 auto-fill" style="${imgStyle}" />

<p style="${p}">Reply with anything that feels off, or whatever you'd want next. I read every one.</p>

<p style="${p}">Heath</p>

<div style="${footer}">
Reply to this email or text me — Heath<br>
You're getting this as a founding member of Dossie. <a href="mailto:heath@meetdossie.com?subject=Unsubscribe%20Weekly%20Update" style="color:#7E776F;text-decoration:underline;">Unsubscribe</a>
</div>
</div>
</body>
</html>`;
}

function buildText(firstName) {
  return `Hey ${firstName},

Quick rundown of what's new in your workspace this week.

HELP CENTER IS LIVE
Tap the "?" in your sidebar for a searchable library covering Morning Brief, Talk to Dossie, DossieSign, TREC deadlines, Compliance Vault, and more.

REQUEST A TESTIMONIAL IN ONE TAP (Tiffany Gill asked for this)
Every closed deal now has a Request Testimonial button. Tap it and Dossie emails your client a review request with your Google and Zillow links pre-filled. It also auto-fires 3 days post-close so you never have to remember.

SAVE YOUR REVIEW LINKS IN SETTINGS
Add your Google Business and Zillow profile URLs once. Every testimonial Dossie sends after that uses your links automatically.

BOTH CLIENT NAMES ON EVERY DOSSIER CARD (Brittney's catch)
Pipeline cards now show buyer and seller names together so you can spot the right deal at a glance.

MOVE A DOSSIER TO ANY STAGE (Brittney again)
A new Change Stage button on the dossier detail page lets you walk a file forward or backward in your pipeline.

LARGE PDF UPLOADS NOW SMOOTH (Miki's catch)
Executed contracts and bigger PDFs upload through a direct path now, so heavier files land without a hitch.

AUTO-FILL ON MORE TREC CONTRACTS
Dossie now auto-fills the One to Four Family Residential Contract (TREC 20-18), New Home Incomplete and Completed Construction (TREC 23-20 and 24-20), and Farm and Ranch (TREC 25-17). More forms coming.

Reply with anything that feels off, or whatever you'd want next. I read every one.

Heath

--
Reply to this email or text me — Heath
You're getting this as a founding member of Dossie.`;
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Supabase fetch failed (${path}): ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json();
}

async function fetchRecipients() {
  // No FK between profiles & subscriptions in PostgREST — do two fetches + client-side join.
  const subs = await sbGet('subscriptions?select=user_id,status,plan&status=in.(active,trialing)');
  const userIds = subs.map(s => s.user_id).filter(Boolean);
  if (userIds.length === 0) return [];

  // Chunk-safe: 16 IDs fit comfortably in URL.
  const idsCsv = userIds.map(id => `"${id}"`).join(',');
  const profiles = await sbGet(`profiles?select=id,email,full_name,is_demo&id=in.(${idsCsv})&is_demo=eq.false`);

  return profiles.filter(p => {
    const emailLower = (p.email || '').toLowerCase();
    return p.email && !EXCLUDE_EMAILS.has(emailLower);
  });
}

async function scheduleEmail(toEmail, firstName, fullName) {
  const html = buildHtml(firstName);
  const text = buildText(firstName);

  const payload = {
    from: FROM,
    to: [toEmail],
    reply_to: REPLY_TO,
    subject: SUBJECT,
    html,
    text,
    scheduled_at: SCHEDULED_AT,
    bcc: ['heath@meetdossie.com'],
    headers: {
      'X-Dossie-Campaign': 'friday-weekly-update-2026-06-19',
    },
  };

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, status: r.status, error: data, fullName, toEmail };
  }
  return { ok: true, id: data.id, fullName, toEmail };
}

async function main() {
  console.log('Friday Weekly Update scheduler');
  console.log('Scheduled for:', SCHEDULED_AT, '(2026-06-19 8:30am CST)');
  console.log('DRY_RUN:', DRY_RUN);
  console.log('---');

  const recipients = await fetchRecipients();
  console.log(`Recipients: ${recipients.length}`);
  recipients.forEach(r => {
    const first = firstNameFrom(r.full_name, r.email);
    console.log(`  ${r.email.padEnd(40)} -> ${first} (${r.full_name || '<no name>'})`);
  });
  console.log('---');

  if (DRY_RUN) {
    console.log('DRY_RUN=1: skipping Resend calls.');
    // Print HTML preview for the first recipient
    if (recipients[0]) {
      const first = firstNameFrom(recipients[0].full_name, recipients[0].email);
      console.log('\nHTML preview for first recipient:');
      console.log(buildHtml(first).slice(0, 800) + '...\n[truncated]');
    }
    return;
  }

  const results = [];
  for (const row of recipients) {
    const firstName = firstNameFrom(row.full_name, row.email);
    const res = await scheduleEmail(row.email, firstName, row.full_name);
    results.push(res);
    if (res.ok) {
      console.log(`OK  ${row.email.padEnd(40)} resend_id=${res.id}`);
    } else {
      console.log(`ERR ${row.email.padEnd(40)} status=${res.status} err=${JSON.stringify(res.error).slice(0, 200)}`);
    }
    // tiny gap to be polite to Resend
    await new Promise(r => setTimeout(r, 150));
  }

  console.log('---');
  console.log(`Scheduled: ${results.filter(r => r.ok).length} / ${results.length}`);
  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.log('FAILURES:', JSON.stringify(failed, null, 2));
    process.exit(2);
  }
  console.log('All recipients queued. Cancel via Resend dashboard if needed.');
}

main().catch(err => {
  console.error('FATAL:', err && err.message ? err.message : err);
  process.exit(1);
});
