'use strict';

// Vercel Serverless Function: /api/sage-webhook
// Telegram webhook for the DossieSageBot — lets Heath DM Sage (Head of Social
// Media) directly without going through Cole. Loads conversation history from
// sage_conversations and replies with Claude Sonnet, using Sage's system
// prompt (embedded below; mirrors ~/.claude/agents/sage.md).
//
// Auth: this endpoint is publicly callable (Telegram doesn't sign requests),
// so we enforce two gates:
//   1. Optional X-Telegram-Bot-Api-Secret-Token header check (set via setWebhook)
//   2. Hard chat_id allowlist — only the configured TELEGRAM_CHAT_ID can talk
//      to Sage. Everything else is dropped silently.
//
// Register: scripts/set-sage-webhook.js
//   curl -X POST "https://api.telegram.org/bot${SAGE_TOKEN}/setWebhook" \
//     -d "url=https://meetdossie.com/api/sage-webhook" \
//     -d "secret_token=${SAGE_WEBHOOK_SECRET}"

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_SAGE_WEBHOOK_SECRET;

const SAGE_MODEL = 'claude-sonnet-4-6';
const HISTORY_LIMIT = 30;   // pull last 30 messages for context
const MAX_REPLY_CHARS = 3800;

// Sage's system prompt — mirrors ~/.claude/agents/sage.md identity section.
// Keep this in sync manually when the agent file changes. The full agent file
// is too long and includes process steps that don't apply to a DM context; this
// is the condensed identity + expertise block plus a Telegram-specific addendum.
const SAGE_SYSTEM_PROMPT = `You are Sage, Head of Social Media & Content Distribution for Shepard Ventures. You report to Heath Shepard, the founder of Dossie (an AI transaction coordinator for Texas REALTORs).

## Identity & voice
- Calm, precise, action-oriented. When Heath asks "what should I do," you give him a specific action, not a framework lecture.
- You live inside the algorithms. You know exactly why a reel performs at 8 AM versus 6:30 AM and you can cite it.
- You speak in outcomes: reach, watch time, completion rate, follower growth, link clicks. Vanity metrics are downstream.
- You hold the schedule sacred. Consistency is the algorithm's #1 trust signal.
- This is Telegram. Keep replies short by default — 1-3 sentences unless Heath asks for a deep dive. Heath reads slowly. No preamble.

## Platform expertise (baked in)

### Instagram Reels
Algorithm weights: watch time > saves > shares > comments > likes. Optimal length: 7-15 seconds. First 1.5 seconds must hook. Post 3-5 reels/week minimum. Best times CDT: 8-9 AM, 11 AM-1 PM, 5-7 PM. Hashtags: 8-10 per post (3 broad + 4 niche + 2-3 brand). Never cross-post with TikTok watermark.

### Facebook Reels
Native reels get 40-60% more organic reach than standard videos. Algorithm: shares > comments > reactions > link clicks. Captions mandatory (85% watched without sound). Best times: 9 AM-12 PM, 7-9 PM CDT Tue-Thu. No hashtags. Square or vertical only.

### TikTok
Content quality first — follower count irrelevant for reach. Completion rate is #1 signal. Hook in first 1-3 seconds. 1-3 posts/day for growth. B2B niche performs Tue-Thu evenings. 3-5 niche hashtags only.

### LinkedIn
Algorithm: long comments > short comments > reactions > reshares. Native video 5x better than YouTube links. Best times: Tue-Thu 8-10 AM and 12-1 PM CDT. 3-4 posts/week. Victor persona is the right voice here. Video optimal 60-90s. 3-5 professional hashtags.

### Twitter / X
First 30 minutes of engagement determines reach. Threads outperform single tweets — max 6 chunks. 2-4 posts/day. Best times: 8-10 AM, 12-1 PM, 5-6 PM CDT. 2-3 hashtags max. Images/video outperform text 3x.

### YouTube
Search engine first. Title must answer a search query, not a creative hook. Watch time is #1 signal. Long-form: 8-15 min for in-depth tutorials. Shorts (<60s) is a separate algorithm. Best posting Tue-Thu 2-4 PM CDT.

## Dossie context
Audience: Texas REALTORs, primarily female 30-50, mix of solo agents, team leads, brokers. Pain points: losing control, TC costs ($300-400/file), deadline stress.

Content pillars (performance order):
1. Control — strongest for high-volume agents (Brittney insight)
2. Cost — $400/file -> $29/month
3. Visibility — for team leads and brokers
4. Speed — for part-timers like Patricia

Personas: Brenda (emotional, relatable), Patricia (practical, time-constrained), Victor (volume agent, authoritative).

Social accounts: Facebook, Instagram, Twitter, LinkedIn, TikTok — all connected via Zernio. Pipeline: cron-generate-posts (6 AM CDT) -> cron-send-for-approval -> DossieMarketingBot approval -> cron-publish-approved (every 30 min).

## Rules
1. Always cite the platform rule when recommending a change — name the algorithm signal it serves.
2. Never recommend manual posting — everything goes through the automated pipeline. If pipeline doesn't support a format, flag it to Carter.
3. Consistency beats quality at this stage. Dossie has <50 followers on most platforms — the algorithm rewards showing up daily.
4. Don't fabricate stats or customer quotes. Use verified numbers only.
5. If Heath asks you to draft a post or caption — do it. Sage owns all social copy.

You are Heath's direct line to social strategy. Be specific. Be fast. Be useful.`;

// ─── Helpers ───────────────────────────────────────────────────────────────

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

async function tgSend(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function sendTelegramText(chatId, text) {
  const chunks = [];
  let s = String(text || '');
  while (s.length > 0) {
    chunks.push(s.slice(0, MAX_REPLY_CHARS));
    s = s.slice(MAX_REPLY_CHARS);
  }
  for (const chunk of chunks) {
    await tgSend('sendMessage', {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
    });
  }
}

async function loadHistory(chatId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/sage_conversations?chat_id=eq.${encodeURIComponent(chatId)}&order=created_at.desc&limit=${HISTORY_LIMIT}&select=role,text`,
  );
  if (!ok || !Array.isArray(data)) return [];
  // Reverse to chronological order (oldest -> newest), shape for Anthropic API.
  return data.reverse().map((row) => ({
    role: row.role === 'sage' ? 'assistant' : 'user',
    content: row.text,
  }));
}

async function storeMessage(chatId, role, text, telegramMessageId) {
  await supabaseFetch('/rest/v1/sage_conversations', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      chat_id: String(chatId),
      role,
      text: String(text || ''),
      telegram_message_id: telegramMessageId ? String(telegramMessageId) : null,
    }),
  });
}

async function callSage(history, userText) {
  const messages = [...history, { role: 'user', content: userText }];

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: SAGE_MODEL,
      max_tokens: 1500,
      system: SAGE_SYSTEM_PROMPT,
      messages,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error('[sage-webhook] Anthropic error:', res.status, text.slice(0, 300));
    throw new Error(`Anthropic ${res.status}`);
  }
  const data = JSON.parse(text);
  return data?.content?.[0]?.text || '';
}

// ─── Handler ───────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true, info: 'sage-webhook is alive — POST only' });
  }

  // Optional secret-token check (Telegram sends X-Telegram-Bot-Api-Secret-Token).
  if (TELEGRAM_WEBHOOK_SECRET) {
    const sent = req.headers['x-telegram-bot-api-secret-token'];
    if (sent !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn('[sage-webhook] bad webhook secret — rejecting');
      return res.status(401).json({ ok: false });
    }
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!ANTHROPIC_API_KEY) missing.push('ANTHROPIC_API_KEY');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_SAGE_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) {
    console.error('[sage-webhook] missing env:', missing.join(', '));
    // Return 200 so Telegram doesn't retry endlessly.
    return res.status(200).json({ ok: false, error: `missing env: ${missing.join(', ')}` });
  }

  const update = req.body || {};
  const message = update.message || update.edited_message;
  if (!message || !message.text) {
    return res.status(200).json({ ok: true, skipped: 'no message text' });
  }

  const chatId = message.chat?.id;
  const userText = String(message.text || '').trim();

  // Hard allowlist — only Heath's chat can talk to Sage.
  if (String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    console.warn('[sage-webhook] dropping message from unauthorized chat_id', chatId);
    return res.status(200).json({ ok: true, skipped: 'unauthorized chat_id' });
  }

  // Slash command: /start /reset /help
  if (userText === '/start' || userText === '/help') {
    await sendTelegramText(chatId,
      "I'm Sage — Head of Social Media for Shepard Ventures. Ask me anything about platform strategy, content timing, algorithm signals, or what to post. I keep replies short by default. Send /reset to clear our conversation history.",
    );
    return res.status(200).json({ ok: true });
  }
  if (userText === '/reset') {
    await supabaseFetch(
      `/rest/v1/sage_conversations?chat_id=eq.${encodeURIComponent(chatId)}`,
      { method: 'DELETE', headers: { Prefer: 'return=minimal' } },
    );
    await sendTelegramText(chatId, 'History cleared. Fresh start.');
    return res.status(200).json({ ok: true });
  }

  // Store the user's message, load context, call Sage, reply.
  await storeMessage(chatId, 'user', userText, message.message_id);

  const history = await loadHistory(chatId);
  // loadHistory now includes the message we just stored — strip the trailing
  // user turn so we pass it as the live message instead of duplicating it.
  const contextHistory = history.slice(0, -1);

  let reply;
  try {
    reply = await callSage(contextHistory, userText);
  } catch (err) {
    console.error('[sage-webhook] Sage call failed:', err && err.message);
    await sendTelegramText(chatId, `Sage hit an error: ${err.message}. Try again in a moment.`);
    return res.status(200).json({ ok: false });
  }

  if (!reply) {
    await sendTelegramText(chatId, 'Sage returned an empty reply — try rephrasing.');
    return res.status(200).json({ ok: true });
  }

  await sendTelegramText(chatId, reply);
  await storeMessage(chatId, 'sage', reply, null);

  return res.status(200).json({ ok: true });
};
