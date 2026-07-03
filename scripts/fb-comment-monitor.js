'use strict';

// scripts/fb-comment-monitor.js
//
// Playwright script: checks recent group_posts for new Facebook comments,
// drafts a reply in Heath's voice via Claude Haiku, sends to DossieMarketingBot
// in veto mode (auto-posts after 10 min unless Heath taps STOP).
//
// Usage:
//   node scripts/fb-comment-monitor.js
//
// Monitors group_posts where status='posted' AND posted_at > 7 days ago.
// For each post, navigates to the FB group post URL (group_posts.post_url).
// Skips posts without a post_url — those haven't been navigated back to yet.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY
//   TELEGRAM_MARKETING_BOT_TOKEN (or TELEGRAM_BOT_TOKEN)
//   TELEGRAM_CHAT_ID

const path = require('path');
const os = require('os');

// Load .env.local when running locally
try {
  const fs = require('fs');
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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Chrome profile path — Heath's existing session
const CHROME_PROFILE_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

// Heath's Facebook name — used to exclude his own comments
const HEATH_FB_NAMES = ['Heath Shepard', 'Heath'];

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchRecentGroupPosts() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.posted&posted_at=gte.${encodeURIComponent(sevenDaysAgo)}&post_url=not.is.null&select=id,group_name,post_url,post_body&order=posted_at.desc&limit=20`,
  );
  if (!ok || !Array.isArray(data)) return [];
  return data.filter((p) => p.post_url);
}

async function fetchKnownReplies(groupPostId) {
  const { data } = await supabaseFetch(
    `/rest/v1/fb_comment_replies?group_post_id=eq.${encodeURIComponent(groupPostId)}&select=reply_author,reply_text`,
  );
  if (!Array.isArray(data)) return new Set();
  return new Set(data.map((r) => `${r.reply_author}::${r.reply_text.slice(0, 80)}`));
}

async function saveReply(groupPostId, author, text, draft) {
  const row = {
    group_post_id: groupPostId,
    reply_author: author,
    reply_text: text,
    our_response_draft: draft,
    status: 'pending',
  };
  const { ok, data } = await supabaseFetch('/rest/v1/fb_comment_replies', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(row),
  });
  if (!ok) {
    console.error('[fb-comment-monitor] saveReply failed:', JSON.stringify(data).slice(0, 200));
    return null;
  }
  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function markTelegramSent(replyId, messageId) {
  await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      telegram_sent_at: new Date().toISOString(),
      telegram_message_id: messageId ? String(messageId) : null,
    }),
  });
}

// ─── Claude Haiku draft ────────────────────────────────────────────────────────

const REPLY_SYSTEM_PROMPT = `You are drafting a Facebook comment reply for Heath Shepard, a licensed Texas REALTOR who built Dossie (an AI transaction coordinator for Texas agents).

Heath's voice: warm, casual, genuine, first-person, self-deprecating. Sounds like a real working agent, not a marketer. Short sentences. No corporate language. Never use "excited," "thrilled," "game-changer," "leverage," "solution."

Rules:
- Reply as if Heath is typing it on his phone between showings
- Be genuinely helpful - answer their question or acknowledge their comment
- If they asked "what do you use?" or "what is Dossie?" - one sentence about Dossie, then meetdossie.com/founding
- If they made a general comment - engage authentically, no pitch
- Max 2-3 sentences
- No em dashes, no curly quotes, plain ASCII only`;

async function draftReply(groupName, replyAuthor, replyText, postBody) {
  if (!ANTHROPIC_API_KEY) return 'Thanks for the comment!';

  const userMsg = `Facebook group: ${groupName}
Our original post: ${String(postBody || '').slice(0, 300)}
Comment from ${replyAuthor}: "${replyText}"

Draft a reply for Heath.`;

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
        system: REPLY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    return text || null;
  } catch (err) {
    console.error('[fb-comment-monitor] draftReply failed:', err && err.message);
    return null;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function tgSend(text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      reply_markup: replyMarkup || undefined,
    }),
  });
  const data = await res.json().catch(() => null);
  return data?.result?.message_id || null;
}

async function sendVetoMessages(groupName, replyAuthor, replyText, draft, replyId) {
  // Message 1: show the incoming comment, no buttons
  const msg1 = `New reply in ${groupName}\n\n${replyAuthor}: "${replyText}"`;
  await tgSend(msg1, null);

  // Message 2: draft + STOP/PREVIEW buttons
  const msg2 = `Draft reply:\n\n${draft}\n\nAuto-posts in 10 min - tap STOP to cancel`;
  const keyboard = {
    inline_keyboard: [[
      { text: 'STOP', callback_data: `reply_stop_${replyId}` },
      { text: 'PREVIEW', callback_data: `reply_preview_${replyId}` },
    ]],
  };
  const messageId = await tgSend(msg2, keyboard);
  return messageId;
}

// ─── Playwright scraping ───────────────────────────────────────────────────────

async function scrapeCommentsForPost(page, postUrl) {
  console.log(`[fb-comment-monitor] navigating to: ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    throw new Error('Facebook redirected to login. Chrome must be logged in as Heath.');
  }

  // Expand comments if needed — Facebook collapses some
  try {
    const viewMore = page.locator('text=/View more comments|View [0-9]+ more comments/i').first();
    if (await viewMore.isVisible({ timeout: 3000 })) {
      await viewMore.click();
      await page.waitForTimeout(2000);
    }
  } catch {
    // No "view more" button — that's fine
  }

  // Scrape comment author + text pairs
  // Facebook comment structure varies — try the most common selectors
  const comments = [];
  try {
    const commentEls = await page.$$('[data-testid="UFI2Comment/body"]');
    for (const el of commentEls) {
      try {
        const authorEl = await el.$('[data-testid="UFI2Comment/authorName"]');
        const textEl = await el.$('[data-testid="UFI2Comment/body"] > span');
        const author = authorEl ? (await authorEl.textContent()).trim() : null;
        const text = textEl ? (await textEl.textContent()).trim() : null;
        if (author && text) comments.push({ author, text });
      } catch { continue; }
    }
  } catch { /* fallback below */ }

  // Fallback: aria-based scraping
  if (comments.length === 0) {
    try {
      const commentBlocks = await page.$$('div[aria-label][role="article"]');
      for (const block of commentBlocks) {
        try {
          const spans = await block.$$('span[dir="auto"]');
          let author = null;
          let text = null;
          for (let i = 0; i < spans.length; i++) {
            const t = (await spans[i].textContent()).trim();
            if (!t) continue;
            if (!author) { author = t; }
            else if (!text && t !== author) { text = t; break; }
          }
          if (author && text) comments.push({ author, text });
        } catch { continue; }
      }
    } catch { /* nothing found */ }
  }

  return comments;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const posts = await fetchRecentGroupPosts();
  console.log(`[fb-comment-monitor] monitoring ${posts.length} recent group posts`);
  if (posts.length === 0) {
    console.log('[fb-comment-monitor] no posts to monitor (all > 7 days old or no post_url set)');
    return;
  }

  const { chromium } = require('playwright');
  console.log('[fb-comment-monitor] NOTE: Close all Chrome windows before running this script.');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();
  let newRepliesFound = 0;

  try {
    for (const post of posts) {
      if (!post.post_url) continue;

      console.log(`[fb-comment-monitor] checking "${post.group_name}" post ${post.id}`);

      let comments;
      try {
        comments = await scrapeCommentsForPost(page, post.post_url);
      } catch (err) {
        console.error(`[fb-comment-monitor] scrape failed for post ${post.id}:`, err && err.message);
        continue;
      }

      console.log(`[fb-comment-monitor] found ${comments.length} comments on post ${post.id}`);

      const knownReplies = await fetchKnownReplies(post.id);

      for (const { author, text } of comments) {
        // Skip Heath's own comments
        if (HEATH_FB_NAMES.some((n) => author.toLowerCase().includes(n.toLowerCase()))) continue;

        const key = `${author}::${text.slice(0, 80)}`;
        if (knownReplies.has(key)) continue;

        console.log(`[fb-comment-monitor] new comment from ${author}: "${text.slice(0, 60)}"`);

        const draft = await draftReply(post.group_name, author, text, post.post_body);
        if (!draft) {
          console.warn('[fb-comment-monitor] draft failed for comment, skipping');
          continue;
        }

        const savedReply = await saveReply(post.id, author, text, draft);
        if (!savedReply) continue;

        const messageId = await sendVetoMessages(post.group_name, author, text, draft, savedReply.id);
        await markTelegramSent(savedReply.id, messageId);
        newRepliesFound++;

        // Brief pause between Telegram messages to avoid rate limiting
        await page.waitForTimeout(1000);
      }
    }
  } finally {
    await context.close();
  }

  console.log(`[fb-comment-monitor] done. New replies found: ${newRepliesFound}`);
}

main().catch((err) => {
  console.error('[fb-comment-monitor] fatal error:', err && err.message);
  process.exit(1);
});
