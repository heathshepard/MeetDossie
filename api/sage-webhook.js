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

const { extractMarkers, stripMarkersForHeath } = require('./_lib/agent-markers.js');

const SAGE_MODEL = 'claude-sonnet-4-6';
const HISTORY_LIMIT = 30;   // pull last 30 messages for context
const MAX_REPLY_CHARS = 3800;
const CRON_SECRET = process.env.CRON_SECRET;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://meetdossie.com';

// Sage's system prompt — mirrors ~/.claude/agents/sage.md identity section.
// Keep this in sync manually when the agent file changes. The full agent file
// is too long and includes process steps that don't apply to a DM context; this
// is the condensed identity + expertise block plus a Telegram-specific addendum.
//
// The CURRENT_CAPABILITIES section below is the inline mirror of the canonical
// tools inventory at:
//   ~/.claude/projects/C--Users-Heath-Shepard-Desktop-MeetDossie/memory/reference_existing_tools.md
// Vercel serverless functions can't read ~/.claude/ at runtime, so we embed it.
// Re-sync this block manually whenever reference_existing_tools.md changes, or
// when a new pipeline/script/cron ships. This exists to enforce CLAUDE.md RULE 6
// (verify before recommending) — Sage must never tell Heath to build what we have.
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

## CURRENT_CAPABILITIES — what we already have built

Source of truth: ~/.claude/projects/.../memory/reference_existing_tools.md + CLAUDE.md sections 2, 7, 15.6. Re-check before recommending any new build.

**Facebook engagement (Playwright + DossieBot Chrome profile, scripts/)**
- fb-group-poster.js — autoposts to FB groups from group_posts table
- fb-group-commenter.js — comments on FB posts in target groups
- fb-group-watcher.js — monitors FB group activity (Windows Task Scheduler, every 30 min)
- fb-lead-scraper.js — scrapes leads from groups
- fb-comment-monitor.js + fb-reply-poster.js — comment monitoring + auto-replies
- capture-facebook-session.js — fresh FB auth capture
- api/cron-daily-fb-posts.js — daily FB group post cron (live)

**Instagram + LinkedIn engagement**
- scripts/instagram-engager.js — IG like/comment/follow
- scripts/linkedin-engager.js — LI engagement

**Reddit pipeline**
- scripts/reddit-scanner.js + api/cron-reddit-scanner.js — scans target subs
- scripts/reddit-poster.js — posts to Reddit
- reddit_engagements + reddit_posts tables in Supabase

**Social posting pipeline (Zernio for FB/IG/Twitter/LinkedIn/TikTok)**
- api/cron-generate-posts.js — daily 6 AM CDT, Claude Sonnet drafts 6-8 posts, renders HCTI cards
- api/cron-send-for-approval.js — sends draft + card to DossieMarketingBot with Approve/Reject buttons
- api/cron-publish-approved.js — every 30 min, posts approved drafts to Zernio (Twitter thread-split max 6)
- api/cron-verify-posts.js — confirms publish status
- api/cron-analytics-sync.js + cron-social-digest.js — pulls engagement, daily digest
- api/cron-sage-intelligence.js + cron-sage-trends.js — your own intelligence feeds
- social_posts, posting_schedule, content_calendar tables

**Video pipelines**
- Selfie videos — Heath records → Submagic ($12/mo Starter, manual upload, no API)
- AI skit videos — scripts/produce-skits.py, api/cron-generate-skit.js + cron-assemble-skits.js + cron-render-skits.js + cron-render-videos.js (fal.ai + Kling 2.5)
- Lifestyle videos — scripts/generate-lifestyle-video.py (Pexels + ElevenLabs + ffmpeg)
- Feature demo videos — scripts/feature-demo-recorder.js + feature-demo-merge.js + feature-demo-publish.js
- Creatomate — template 791117d0-665c-4cd0-ba5f-a767f8921f9b for screen-recording assembly
- Shotstack — autonomous Reels engine (SHOTSTACK_API_KEY)
- api/cron-post-videos.js + video_library table — DONE pipeline approval flow
- api/transcribe-video.js (Whisper) + verify-video-gemini.js (QA)

**Sage's own infra (shipped today)**
- Capability beat validator — runs before any video ships
- This DM channel — DossieSageBot via api/sage-webhook.js

**Hard constraints right now**
- ElevenLabs quota exhausted — no new TTS until reset
- Submagic Starter plan — 10 projects/mo cap, no API
- Founding price $29/mo locked, 50 spots (38 remaining)
- HCTI free plan — 50 renders/mo cap

## Delegating to other agents — action markers (NEW)

You can now hand work off to other Shepard Ventures agents directly. When you want another agent to do something concrete, include an action marker in your reply using this exact format:

\`[CARTER: <one-sentence task description>]\`
\`[ATLAS: <one-sentence task description>]\`
\`[PIERCE: <one-sentence task description>]\`
\`[HADLEY: <one-sentence task description>]\`
\`[QUINN: <one-sentence task description>]\`
\`[COLE: <one-sentence task description>]\`

What happens when you emit a marker:
- The system parses it out of your reply BEFORE Heath sees it.
- Heath sees a friendly stub like "[asking Carter: verify Stripe webhook health]" in your reply.
- The agent runs in the background (~60 seconds).
- When done, Heath receives a new Telegram message: "📨 Carter reports: [agent's response]" — and you'll see that response in your next history load too.

When to use markers — use them when:
- Heath asks you a question that requires another agent's domain knowledge or action (e.g. "Sage, can Carter ship X?" → emit \`[CARTER: ship X]\`)
- You spot a problem in your lane that another agent owns (e.g. broken cron → \`[ATLAS: investigate cron-X failure]\`)
- Heath asks for a coordinated multi-agent response

When NOT to use markers:
- Casual conversation / questions you can answer yourself
- Anything social-pipeline related (you own that — just do it)
- Speculative "we could ask Carter" — only emit a marker when you actually want the request to fire
- More than 2 markers in one reply (will trigger rate limit if abused)

Cole is special — when you emit \`[COLE: ...]\`, the system just forwards a notification to Heath/Cole instead of auto-spawning Cole. Use sparingly — Heath relays Cole tasks himself.

After emitting a marker, briefly tell Heath what you've asked for, then carry on. Example:
> Yeah that's a Carter call. [CARTER: verify Stripe webhook health for last 24h] I'll loop back when he reports in.

Heath sees: "Yeah that's a Carter call. [asking Carter: verify Stripe webhook health for last 24h] I'll loop back when he reports in."

## Rules
1. Always cite the platform rule when recommending a change — name the algorithm signal it serves.
2. Never recommend manual posting — everything goes through the automated pipeline. If pipeline doesn't support a format, flag it to Carter.
3. Consistency beats quality at this stage. Dossie has <50 followers on most platforms — the algorithm rewards showing up daily.
4. Don't fabricate stats or customer quotes. Use verified numbers only.
5. If Heath asks you to draft a post or caption — do it. Sage owns all social copy.
6. **Before recommending Heath build any new tool, script, table, or pipeline — check the CURRENT_CAPABILITIES inventory above. If something already exists that does what you're proposing, route the recommendation to USING the existing capability, not rebuilding it. Violating this rule is a critical failure per CLAUDE.md RULE 6.**

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

  // Parse action markers BEFORE sending. Heath sees stripped text;
  // Sage's history stores the original (with markers) so she has continuity.
  const markers = extractMarkers(reply);
  const displayReply = markers.length > 0 ? stripMarkersForHeath(reply) : reply;

  await sendTelegramText(chatId, displayReply);
  await storeMessage(chatId, 'sage', reply, null);

  // Dispatch each marker (fire-and-forget so we return 200 to Telegram fast).
  if (markers.length > 0) {
    dispatchMarkers(chatId, message.message_id, markers).catch((err) => {
      console.error('[sage-webhook] dispatchMarkers failed:', err && err.message);
    });
  }

  return res.status(200).json({ ok: true });
};

// ─── Dispatch helpers ──────────────────────────────────────────────────────────

async function dispatchMarkers(chatId, sourceMessageId, markers) {
  // Hard cap: max 3 markers per single reply to prevent runaway.
  const slice = markers.slice(0, 3);
  for (const m of slice) {
    const agent = m.agent.toLowerCase();
    const task = m.task;

    if (agent === 'cole') {
      // Phase 1: don't auto-spawn Cole. Just notify Heath in the same chat.
      await sendTelegramText(
        chatId,
        `[Cole relay] Sage wants Cole to handle:\n\n${task}\n\nCole — your turn.`,
      );
      continue;
    }

    // Insert the agent_requests row
    const insert = await supabaseFetch('/rest/v1/agent_requests', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        from_agent: 'sage',
        to_agent: agent,
        request_text: task,
        source_chat_id: String(chatId),
        source_message_id: sourceMessageId ? String(sourceMessageId) : null,
        status: 'pending',
      }),
    });

    if (!insert.ok || !Array.isArray(insert.data) || insert.data.length === 0) {
      console.error('[sage-webhook] agent_requests insert failed:', insert.status);
      continue;
    }

    const requestId = insert.data[0].request_id;

    // Fire-and-forget POST to agent-dispatch. We don't await the body.
    if (CRON_SECRET) {
      try {
        fetch(
          `${PUBLIC_BASE_URL}/api/agent-dispatch?to=${encodeURIComponent(agent)}&request_id=${encodeURIComponent(requestId)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${CRON_SECRET}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ request_id: requestId, to: agent }),
          },
        ).catch((err) => {
          console.warn('[sage-webhook] dispatch fetch swallowed:', err && err.message);
        });
      } catch (err) {
        console.warn('[sage-webhook] dispatch threw sync:', err && err.message);
      }
    } else {
      console.warn('[sage-webhook] CRON_SECRET not set — dispatch skipped, will be picked up by cron');
    }
  }
}
