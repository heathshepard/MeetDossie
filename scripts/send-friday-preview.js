// scripts/send-friday-preview.js — sends ONE preview to Heath's inbox right now
// (no scheduling) so he can eyeball the rendered email before the Friday batch.

const path = require('path');
process.env.SUPABASE_URL ||= 'noop';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'noop';

// Reuse the html/text builders from the main scheduler by reading the source
// and evaluating just the helpers. Cheaper than splitting into a shared module
// for a one-off preview.
const fs = require('fs');
const src = fs.readFileSync(path.join(__dirname, 'send-friday-weekly-update.js'), 'utf-8');
// Include the IMG_* constants (start at SCHEDULED_AT) and helpers (stop before fetchRecipients).
const helperBlock = src.substring(
  src.indexOf('// Friday 2026-06-19'),
  src.indexOf('async function fetchRecipients')
);
eval(helperBlock);

const RESEND_API_KEY = process.env.RESEND_API_KEY;
if (!RESEND_API_KEY) {
  console.error('RESEND_API_KEY required');
  process.exit(1);
}

const PREVIEW_TO = process.env.PREVIEW_TO || 'heath@meetdossie.com';
const PREVIEW_NAME = process.env.PREVIEW_NAME || 'Heath';

async function main() {
  const html = buildHtml(PREVIEW_NAME);
  const text = buildText(PREVIEW_NAME);

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Heath at Dossie <heath@meetdossie.com>',
      to: [PREVIEW_TO],
      reply_to: 'heath@meetdossie.com',
      subject: '[PREVIEW] 7 things shipped in Dossie this week',
      html,
      text,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('FAIL', r.status, JSON.stringify(data));
    process.exit(2);
  }
  console.log('Preview sent to', PREVIEW_TO, 'resend_id=', data.id);
}

main().catch(e => { console.error(e); process.exit(1); });
