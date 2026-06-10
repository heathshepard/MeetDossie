'use strict';

// Re-normalize the draft preserving paragraph breaks, update DB, edit Telegram message.

const path = require('path');
const fs = require('fs');

// Load env
try {
  const envPath = path.join(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const queueState = JSON.parse(fs.readFileSync(path.join(__dirname, 'queue-result.json'), 'utf8'));
const DRAFT_ID = queueState.draft_id;
const OLD_MSG_ID = queueState.message_id;

// Re-normalize preserving paragraph breaks
let draft = fs.readFileSync(path.join(__dirname, 'sage-draft.txt'), 'utf8').trim();
draft = draft
  .replace(/—/g, ' - ')
  .replace(/–/g, '-')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"');

// Collapse SINGLE-line internal double-spaces but preserve newlines
draft = draft.split('\n').map(line => line.replace(/  +/g, ' ').trim()).join('\n');

// Strip triple+ newlines down to double
draft = draft.replace(/\n{3,}/g, '\n\n').trim();

const wc = draft.split(/\s+/).length;
console.log(`[fix] Re-normalized draft (${draft.length} chars, ${wc} words):`);
console.log(draft);
console.log('---');

(async () => {
  // Update DB row with corrected draft
  const patch = await fetch(
    `${SUPABASE_URL}/rest/v1/reddit_engagements?id=eq.${encodeURIComponent(DRAFT_ID)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ our_response_draft: draft }),
    }
  );
  if (!patch.ok) {
    console.error('[fix] DB patch failed', patch.status, await patch.text());
    process.exit(1);
  }
  console.log('[fix] DB updated');

  // Edit the existing Telegram message text to show the corrected draft
  const platformLabel = 'Reddit';
  const postUrl = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';
  const lines = [
    `<b>${platformLabel} comment draft (corrected — paragraphs restored)</b>`,
    '',
    `<b>Target:</b> ${postUrl}`,
    `<b>Persona:</b> Heath (founder voice)`,
    '',
    `<b>Comment:</b>`,
    draft,
    '',
    `<i>Auto-approves in 10 min if no veto. (Original draft had paragraph breaks merged - this is the fix.)</i>`,
  ];

  const editRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      message_id: OLD_MSG_ID,
      text: lines.join('\n'),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `comment_approve:reddit:${DRAFT_ID}` },
          { text: 'Reject',  callback_data: `comment_reject:reddit:${DRAFT_ID}` },
        ]],
      },
    }),
  });
  const editText = await editRes.text();
  console.log('[fix] Telegram edit:', editRes.status, editText.slice(0, 300));

  fs.writeFileSync(path.join(__dirname, 'fix-result.json'), JSON.stringify({
    draft_id: DRAFT_ID,
    final_draft: draft,
    final_word_count: wc,
    edited_at: new Date().toISOString(),
  }, null, 2));
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
