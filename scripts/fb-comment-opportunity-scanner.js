'use strict';

// scripts/fb-comment-opportunity-scanner.js
//
// PART 1 (Discovery) of Sage's comment-opportunity pipeline, built 2026-08-28
// on top of the just-fixed scripts/fb-lead-scraper.js (per-scroll-step DOM
// extraction, see that file's header for the virtualization bug it fixed).
//
// HUMAN-IN-THE-LOOP ONLY. This script never posts, comments, or replies on
// Facebook. It only: (1) scans group_registry groups for TC-pain-signal
// posts using fb-lead-scraper.js's already-established scanGroup() +
// LEAD_KEYWORD_PATTERNS, (2) drafts a proposed comment via Claude Haiku,
// (3) inserts one engagement_queue row per opportunity, status directly at
// 'awaiting_manual_post' (skipping the pending_review/approve gate that
// api/cron-engagement-review.js uses for fb-engagement-scraper.js rows --
// these are already keyword-pre-filtered, so the human gate here is simply
// "does Heath choose to paste this," same effective control, one fewer tap),
// (4) sends Heath exactly ONE Telegram message per opportunity: post link,
// a short excerpt, and the draft in its own monospace block (HTML <pre>) so
// a tap-to-select on mobile grabs only the comment text.
//
// Tapping "Mark Posted" on that message is handled by the EXISTING
// engage_posted_<id> callback in api/telegram-webhook.js -- zero webhook
// changes needed. That handler also inserts a comment_watchlist row
// (direction='heath_commented_on_others') for Part 2, and logs to
// engagement_post_log for audit. See api/telegram-webhook.js's `engage`
// handler and supabase/migrations/20260828_comment_watchlist.sql.
//
// Usage:
//   node scripts/fb-comment-opportunity-scanner.js
//
// Env vars required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
//   TELEGRAM_MARKETING_BOT_TOKEN (or TELEGRAM_BOT_TOKEN), TELEGRAM_CHAT_ID
//
// Anti-ban pacing: shares the same daily group-page-visit budget as
// fb-engagement-scraper.js / fb-group-discovery.js via scripts/_lib/scan-caps.js
// (scripts/.scan-caps-state.json, 25 group-page-visits/day across ALL
// scanning scripts). NOTE: fb-lead-scraper.js's own standalone `main()` does
// NOT currently call scan-caps -- that's a pre-existing gap in that file,
// not introduced here, and is called out separately in this rollout's
// report. This script closes the gap for its own runs by gating every call
// into the shared scanGroup() through canScan()/recordScan().

const path = require('path');
const fs = require('fs');

// Load .env.local when running locally
try {
  const envPath = path.join(__dirname, '..', '.env.local');
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
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  require('os').homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const { scanGroup, LEAD_KEYWORD_PATTERNS } = require('./fb-lead-scraper');
const { canScan, recordScan, randDelay, SCAN_DWELL_MS } = require('./_lib/scan-caps');

const SEEN_FILE = path.join(__dirname, '.comment-opportunity-seen.json');

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')));
  } catch { /* ignore */ }
  return new Set();
}
function saveSeen(set) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...set]), 'utf8'); } catch (e) {
    console.warn('[fb-comment-opportunity-scanner] could not save seen file:', e.message);
  }
}

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function sb(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function loadGroups() {
  const { ok, data } = await sb(
    '/rest/v1/group_registry?select=id,group_name,group_url,skip&skip=eq.false&order=last_posted_at.asc.nullsfirst&limit=50'
  );
  if (!ok || !Array.isArray(data)) return [];
  return data.filter((g) => g.group_url && !g.group_url.includes('PLACEHOLDER'));
}

async function insertOpportunity(row) {
  const { ok, status, data } = await sb('/rest/v1/engagement_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!ok) {
    // 409 = UNIQUE(group_name, original_text) violation -- already queued
    // for this exact post, not a real failure.
    if (status !== 409) {
      console.error('[fb-comment-opportunity-scanner] insert failed:', JSON.stringify(data).slice(0, 300));
    }
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

// ─── Claude Haiku draft ────────────────────────────────────────────────────────
//
// Heath posts this as himself, first person, on his own FB profile inside a
// group thread. "Dossie's voice" (CLAUDE.md Sec. 4: warm, capable, never
// corporate) governs the TONE of the comment and how Dossie herself is
// referred to (always "she/her" when named) -- it does not mean Heath
// speaks in third person as Dossie.

const DRAFT_SYSTEM_PROMPT = `You are drafting a Facebook GROUP COMMENT for Heath Shepard, a licensed Texas REALTOR who built Dossie, an AI transaction coordinator for Texas agents.

Voice rules:
- Heath writes in first person, casual, like he's typing on his phone between showings. Short sentences, no corporate language, never "excited," "thrilled," "game-changer," "leverage," "solution."
- If Dossie comes up by name in the comment, always refer to her as "she/her" (never "it") -- warm, capable, never corporate is her brand voice.
- Genuinely respond to what the poster said first. Do not open with a pitch.
- Only mention Dossie if it's a natural, non-pushy fit for what they're describing -- one sentence, then meetdossie.com if relevant. Many good comments won't mention Dossie at all -- that's fine and often better.
- Max 2-3 sentences.
- No em dashes, no curly quotes, plain ASCII only.`;

async function draftComment(groupName, authorName, postText, matchedPattern) {
  if (!ANTHROPIC_API_KEY) return null;

  const userMsg = `Facebook group: ${groupName}
Post from ${authorName || 'an agent'} (matched signal: ${matchedPattern}):
"${String(postText || '').slice(0, 600)}"

Draft a comment for Heath to leave on this post.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        system: DRAFT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    return text || null;
  } catch (err) {
    console.error('[fb-comment-opportunity-scanner] draftComment failed:', err && err.message);
    return null;
  }
}

// ─── Telegram — ONE message per opportunity ────────────────────────────────────
//
// HTML parse_mode, <pre> wraps ONLY the draft text so a tap-to-select on
// mobile grabs exactly the comment and nothing else. Mark Posted button
// reuses the existing engage_posted_<id> handler in api/telegram-webhook.js.

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendOpportunity(row, opportunityId) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  const text = [
    `<b>Comment opportunity</b> — ${escapeHtml(row.group_name)}`,
    '',
    row.author_name ? `${escapeHtml(row.author_name)} wrote:` : 'Post:',
    `"${escapeHtml(row.original_text.slice(0, 300))}"`,
    row.permalink ? escapeHtml(row.permalink) : '(no direct post URL captured — find it in the group feed)',
    '',
    'Proposed comment (tap to select, copy, paste):',
    `<pre>${escapeHtml(row.drafted_reply)}</pre>`,
    '',
    'Nothing has been posted. Paste it yourself, then tap Mark Posted below.',
  ].join('\n');

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[{ text: '✅ Mark Posted', callback_data: `engage_posted_${opportunityId}` }]],
      },
    }),
  });
  const data = await res.json().catch(() => null);
  return data?.result?.message_id || null;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[fb-comment-opportunity-scanner] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[fb-comment-opportunity-scanner] TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID required');
    process.exit(1);
  }

  const seenIds = loadSeen();
  const groups = await loadGroups();
  if (!groups.length) {
    console.log('[fb-comment-opportunity-scanner] No groups in group_registry');
    return;
  }

  const gate = canScan(groups.length);
  const groupsToScan = gate.allowed ? groups : groups.slice(0, gate.remaining);
  console.log(`[fb-comment-opportunity-scanner] scan-caps: ${gate.used}/${gate.cap} used today, scanning ${groupsToScan.length}/${groups.length} groups this run`);
  if (groupsToScan.length === 0) {
    console.log('[fb-comment-opportunity-scanner] Daily scan cap already spent — skipping this run entirely.');
    return;
  }

  const { chromium } = require('playwright');
  console.log('[fb-comment-opportunity-scanner] Launching Chrome with DossieBot profile');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();
  let opportunitiesSent = 0;

  try {
    for (const group of groupsToScan) {
      const leads = await scanGroup(page, group, seenIds).catch((err) => {
        console.warn(`[fb-comment-opportunity-scanner] scan error on ${group.group_name}:`, err.message);
        return [];
      });
      recordScan(1);
      await randDelay(SCAN_DWELL_MS);

      for (const lead of leads) {
        const draft = await draftComment(lead.groupName, lead.authorName, lead.text, lead.matchedPattern);
        if (!draft) {
          console.warn('[fb-comment-opportunity-scanner] draft failed, skipping lead');
          continue;
        }

        const row = {
          source: 'fb_lead_scraper',
          group_name: lead.groupName,
          group_url: group.group_url,
          content_type: 'post',
          author_name: lead.authorName || null,
          original_text: lead.text,
          permalink: lead.postUrl || null,
          matched_pattern: lead.matchedPattern || null,
          drafted_reply: draft,
          draft_model: HAIKU_MODEL,
          status: 'awaiting_manual_post',
        };

        const saved = await insertOpportunity(row);
        if (!saved) continue; // null = already queued (409) or insert error, already logged

        const messageId = await sendOpportunity(row, saved.id);
        if (messageId) {
          await sb(`/rest/v1/engagement_queue?id=eq.${encodeURIComponent(saved.id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({
              telegram_sent_at: new Date().toISOString(),
              telegram_message_id: messageId,
              handoff_message_id: messageId,
              handoff_sent_at: new Date().toISOString(),
            }),
          });
        }
        opportunitiesSent++;
        await new Promise((r) => setTimeout(r, 1500)); // don't flood Telegram
      }

      saveSeen(seenIds);
    }
  } finally {
    await context.close();
  }

  console.log(`[fb-comment-opportunity-scanner] done. Opportunities sent: ${opportunitiesSent}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fb-comment-opportunity-scanner] fatal error:', err && err.message);
    process.exit(1);
  });
}

module.exports = { draftComment, DRAFT_SYSTEM_PROMPT };
