'use strict';

// Step 3: Queue Sage's new draft for DossieMarketingBot approval via the
// existing comment-approval flow Carter built.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE creds missing');
  process.exit(1);
}
if (!TELEGRAM_MARKETING_BOT_TOKEN) {
  console.error('TELEGRAM_MARKETING_BOT_TOKEN missing');
  process.exit(1);
}

const { queueCommentForApproval } = require(path.join(__dirname, '..', '..', '..', 'api', '_lib', 'comment-approval.js'));

// Read draft + normalize (strip em-dashes per CLAUDE.md sec 15.7)
let draft = fs.readFileSync(path.join(__dirname, 'sage-draft.txt'), 'utf8').trim();
const beforeLen = draft.length;
draft = draft
  .replace(/—/g, ' - ')   // em-dash
  .replace(/–/g, '-')     // en-dash
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"');

// Collapse double spaces from em-dash replacement
draft = draft.replace(/\s{2,}/g, ' ').trim();

console.log(`[queue] Normalized draft (${beforeLen} → ${draft.length} chars, ${draft.split(/\s+/).length} words):`);
console.log(draft);
console.log('---');

(async () => {
  // Insert new row in reddit_engagements
  const draftId = crypto.randomUUID();
  const postUrl = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/reddit_engagements`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      id: draftId,
      reddit_id: '1u0piq6',
      post_id: '1u0piq6',
      subreddit: 'realtors',
      post_title: 'Why am I losing leads/ clients?',
      post_body: '',
      post_url: postUrl,
      permalink: '/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/',
      our_response_draft: draft,
      status: 'pending',
      keyword_matched: 'sage-rewrite',
      score: 12,
    }),
  });
  if (!insertRes.ok) {
    console.error('[queue] Insert failed:', insertRes.status, await insertRes.text());
    process.exit(2);
  }
  const inserted = await insertRes.json();
  console.log('[queue] Inserted draft id', draftId);

  // Send to DossieMarketingBot for approval
  const result = await queueCommentForApproval({
    platform: 'reddit',
    draftId,
    commentText: draft,
    targetPostUrl: postUrl,
    persona: 'Heath (founder voice)',
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
    telegramToken: TELEGRAM_MARKETING_BOT_TOKEN,
    chatId: TELEGRAM_CHAT_ID,
  });

  console.log('[queue] Approval queued:', JSON.stringify(result));

  fs.writeFileSync(path.join(__dirname, 'queue-result.json'), JSON.stringify({
    draft_id: draftId,
    message_id: result.message_id,
    queued_at: new Date().toISOString(),
    draft_text: draft,
  }, null, 2));
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
