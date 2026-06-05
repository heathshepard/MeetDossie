// Vercel Serverless Function: /api/cron-send-for-approval
// Sends draft social posts to Heath via Telegram with approve/reject/edit
// inline-keyboard buttons. Updates each row with telegram_sent_at and
// telegram_message_id once the message has been delivered.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 30 11 * * * (11:30 UTC, ~30 min after generation).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Marketing approval flow uses a dedicated bot (DossieMarketingBot) so it
// can hold a webhook without fighting Claudy's getUpdates loop. Falls back
// to TELEGRAM_BOT_TOKEN only if the marketing-specific token isn't set.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Quality scorer model — Haiku is sufficient for structured JSON scoring.
const SCORER_MODEL = 'claude-haiku-4-5-20251001';

const MAX_PER_RUN = 12;

// Platforms that attach a card image in the approval message.
const CARD_PLATFORMS_FOR_APPROVAL = new Set(['instagram', 'facebook']);

// Platform rules summary for the approval message — compact one-liners so
// Heath can sanity-check that the post was generated against the right
// distribution playbook. Mirrors PLATFORM_RULES in cron-generate-posts.js
// (kept brief here; the generator has the full text).
const PLATFORM_RULES_SUMMARY = {
  tiktok:    'Hook<8 words/no "I", <150 words, line breaks, "Link in bio" CTA, 3-5 hashtags',
  instagram: 'Stop-scroll hook (front-load <125 chars), 150-300 words, SAVE/SHARE CTA, 5-10 hashtags',
  facebook:  'Pain-point/question hook, 200-500 words, short paragraphs, comment-driving CTA, 2-3 hashtags',
  twitter:   'Punchy/contrarian hook <280 chars, single tweet OR 5-8 thread, RT/quote CTA, 1-2 hashtags',
};

// ─── Quality Scorer ───────────────────────────────────────────────────────
// Calls Claude Haiku to score a post on Hook, Platform Fit, and CTA (1-10 each).
// Returns { hook, platform_fit, cta, composite } or null on any failure.
// Failure is non-fatal — caller falls back to null and skips score display.
async function scorePost(caption, platform) {
  if (!ANTHROPIC_API_KEY) return null;
  const prompt = `Score this social media post for a Texas real estate software product called Dossie on three dimensions (1-10 each):
- Hook: Does the opening grab attention in the first line?
- Platform fit: Is the tone, length, and format right for ${platform}?
- CTA: Is the call to action clear and compelling?

Post:
${caption}

Return JSON only: {"hook": N, "platform_fit": N, "cta": N}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SCORER_MODEL,
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    // Extract JSON — handle fences or extra whitespace
    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const hook = Math.min(10, Math.max(1, parseInt(parsed.hook, 10) || 0));
    const platform_fit = Math.min(10, Math.max(1, parseInt(parsed.platform_fit, 10) || 0));
    const cta = Math.min(10, Math.max(1, parseInt(parsed.cta, 10) || 0));
    if (!hook || !platform_fit || !cta) return null;
    const composite = Math.round(((hook + platform_fit + cta) / 3) * 10) / 10;
    return { hook, platform_fit, cta, composite };
  } catch (err) {
    console.warn('[cron-send-for-approval] scorePost failed:', err && err.message);
    return null;
  }
}

function formatScoreLine(score) {
  if (!score) return '';
  return `Score: ${score.composite}/10 (Hook: ${score.hook} | Fit: ${score.platform_fit} | CTA: ${score.cta})\n\n`;
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function formatShortCaption(post) {
  // Short caption for the media preview: hook + platform/persona, under 1024 chars
  const platform = post.platform || 'unknown';
  const persona = post.persona || 'unknown';
  const hook = String(post.hook || '').trim();
  const hasVideo = !!post.media_url;
  const mediaType = hasVideo && isVideoUrl(post.media_url) ? 'video' : hasVideo ? 'image' : 'no media yet';

  let caption = `${platform} (${persona}) - ${mediaType}\n`;
  if (hook) caption += `\n${hook}`;

  return caption.slice(0, 1020);
}

function formatVerifierSection(post) {
  // Surface the content-verifier's verdict + flags at the TOP of the
  // approval message so Heath knows what to scrutinize before tapping
  // Approve. Empty string if the post has no verifier_result (e.g. a
  // legacy post inserted before the verifier pass was wired up).
  const result = post.verifier_result;
  if (!result || typeof result !== 'object') return '';

  const verdict = String(result.verdict || '').toLowerCase();
  const flags = Array.isArray(result.flags) ? result.flags : [];
  const interesting = flags.filter((f) => ['red', 'yellow'].includes(String(f?.severity || '').toLowerCase()));

  if (verdict === 'approve' && interesting.length === 0) {
    return '🤖 VERIFIER: ✅ Clean — no flags\n\n';
  }

  const lines = [`🤖 VERIFIER: ⚠️ ${interesting.length} flag${interesting.length === 1 ? '' : 's'} (${verdict})`];
  for (const f of interesting.slice(0, 6)) {
    const sev = String(f.severity || '').toLowerCase();
    const claim = String(f.claim || '').slice(0, 80);
    const issue = String(f.issue || '').slice(0, 140);
    const fix = String(f.fix || '').slice(0, 120);
    lines.push(`   - [${sev}] "${claim}" — ${issue}${fix ? ' → ' + fix : ''}`);
  }
  if (result.summary) lines.push(`   summary: ${String(result.summary).slice(0, 200)}`);
  return lines.join('\n') + '\n\n';
}

function formatFullContent(post) {
  // Full post content + hashtags for the second text message
  const platform = post.platform || 'unknown';
  const persona = post.persona || 'unknown';
  const topic = post.topic || 'unknown';
  const content = String(post.content || '');
  const hashtags = Array.isArray(post.hashtags) && post.hashtags.length
    ? post.hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';
  const algo = PLATFORM_RULES_SUMMARY[platform] || '';
  const algoLine = algo ? `\n\n📐 Algorithm: ${algo}` : '';
  const verifierSection = formatVerifierSection(post);

  return `${verifierSection}📝 Full caption for ${platform} (${persona}, topic: ${topic})\n\n${content}\n\nHashtags: ${hashtags}${algoLine}`;
}

function inlineKeyboard(postId) {
  return {
    inline_keyboard: [[
      { text: '❌ Reject', callback_data: `reject_${postId}` },
      { text: '✏️ Edit', callback_data: `edit_${postId}` },
    ]],
  };
}

// Detect if a media URL is a video (MP4) or image (PNG/JPG).
// Used to route to sendVideo vs sendPhoto in Telegram.
function isVideoUrl(url) {
  return /\.(mp4|mov|webm)(\?|$)/i.test(String(url || ''));
}

async function telegramSend(chatId, text, replyMarkup, mediaUrl) {
  // If mediaUrl is provided: route to sendVideo (MP4) or sendPhoto (image).
  // Otherwise use sendMessage.
  let method = 'sendMessage';
  if (mediaUrl) {
    method = isVideoUrl(mediaUrl) ? 'sendVideo' : 'sendPhoto';
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

  const body = { chat_id: chatId };

  if (mediaUrl && method === 'sendVideo') {
    body.video = mediaUrl;
    // Telegram caption limit is 1024 characters
    body.caption = text.length > 1020 ? text.slice(0, 1020) + '...' : text;
  } else if (mediaUrl && method === 'sendPhoto') {
    body.photo = mediaUrl;
    body.caption = text.length > 1020 ? text.slice(0, 1020) + '...' : text;
  } else {
    body.text = text;
    body.disable_web_page_preview = true;
  }

  if (replyMarkup) body.reply_markup = replyMarkup;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const respText = await res.text();
  let data = null;
  try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw: respText };
}

module.exports = async function handler(req, res) {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[cron-send-for-approval] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  // Find posts that haven't been pushed to Telegram yet (both draft and approved).
  // Draft posts get approval buttons, approved posts get preview notifications only.
  const { data: posts, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?telegram_sent_at=is.null&status=in.(draft,approved)&order=created_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load posts' });
  }
  const items = Array.isArray(posts) ? posts : [];
  console.log('[cron-send-for-approval] posts to send:', items.length, '— draft:', items.filter(p => p.status === 'draft').length, 'approved:', items.filter(p => p.status === 'approved').length);

  let sent = 0;
  const sendErrors = [];
  for (const post of items) {
    if (!post || !post.id) continue;

    // ─── Quality score (Improvement 1) ───────────────────────────────────
    // Score the post before sending for approval. Non-fatal: if scoring fails
    // we still send — just without the score line. Store scores back to DB.
    const caption = String(post.content || '');
    const platform = String(post.platform || '');
    let scoreData = null;
    // Only score if not already scored (idempotent on re-runs)
    if (post.score_hook == null) {
      scoreData = await scorePost(caption, platform);
      if (scoreData) {
        // Persist scores to DB — fire-and-forget, non-fatal
        supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            score_hook: scoreData.hook,
            score_platform_fit: scoreData.platform_fit,
            score_cta: scoreData.cta,
          }),
        }).catch((err) => console.warn('[cron-send-for-approval] score patch failed:', err && err.message));
        console.log(`[cron-send-for-approval] scored ${post.id}: ${scoreData.composite}/10`);
      }
    } else {
      // Already scored — reconstruct for display
      const h = post.score_hook || 0;
      const f = post.score_platform_fit || 0;
      const c = post.score_cta || 0;
      if (h && f && c) {
        scoreData = {
          hook: h,
          platform_fit: f,
          cta: c,
          composite: Math.round(((h + f + c) / 3) * 10) / 10,
        };
      }
    }
    const scoreLine = formatScoreLine(scoreData);

    // Message 1: Card image (if available) + short caption preview
    const shortCaption = formatShortCaption(post);
    const photoResult = await telegramSend(TELEGRAM_CHAT_ID, shortCaption, null, post.media_url || null);
    if (!photoResult.ok) {
      console.error('[cron-send-for-approval] photo send failed for', post.id, 'status', photoResult.status, 'body', photoResult.raw?.slice(0, 200));
      sendErrors.push({ id: post.id, step: 'photo', status: photoResult.status, body: photoResult.raw?.slice(0, 200) });
      continue;
    }

    // Auto-reject low-quality drafts before sending to Telegram.
    // Threshold: composite < 5.5/10 (below 55%) gets silently rejected.
    // Composite 5.5-7.3 gets a warning prepended; 7.4+ goes through normally.
    if (post.status === 'draft' && scoreData && scoreData.composite < 5.5) {
      const rejectReason = `Auto-rejected by quality scorer: composite ${scoreData.composite}/10 (Hook:${scoreData.hook} Fit:${scoreData.platform_fit} CTA:${scoreData.cta}) — below 5.5 threshold`;
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'rejected', rejection_reason: rejectReason }),
      }).catch((err) => console.warn('[cron-send-for-approval] auto-reject patch failed:', err && err.message));
      console.log(`[cron-send-for-approval] auto-rejected ${post.id}: composite ${scoreData.composite}/10`);
      continue;
    }

    // Message 2: Full content + hashtags + approve/reject buttons.
    // Score line is prepended so Heath sees it before tapping Approve.
    const fullContent = formatFullContent(post);
    const isDraft = post.status === 'draft';
    const buttons = isDraft ? inlineKeyboard(post.id) : null;
    const warningPrefix = (scoreData && scoreData.composite >= 5.5 && scoreData.composite < 7.4) ? '⚠️ LOW SCORE — review carefully before approving\n\n' : '';
    const autoPostHeader = isDraft ? '⏱ Auto-posting in 30 min — tap Reject to cancel\n\n' : '';
    const prefix = isDraft ? `${autoPostHeader}${warningPrefix}${scoreLine}` : `✅ AUTO-APPROVED\n\n${scoreLine}`;
    const textResult = await telegramSend(TELEGRAM_CHAT_ID, prefix + fullContent, buttons, null);
    if (!textResult.ok) {
      console.error('[cron-send-for-approval] full content send failed for', post.id, 'status', textResult.status, 'body', textResult.raw?.slice(0, 200));
      sendErrors.push({ id: post.id, step: 'text', status: textResult.status, body: textResult.raw?.slice(0, 200) });
      continue;
    }

    const messageId = textResult.data?.result?.message_id || null;
    const now = new Date().toISOString();
    const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_sent_at: now, telegram_message_id: messageId }),
    });
    if (patch.ok) sent++;
    else sendErrors.push({ id: post.id, error: 'patch failed', status: patch.status });
  }

  console.log('[cron-send-for-approval] done — sent', sent, 'errors:', sendErrors.length);
  return res.status(200).json({ ok: true, sent, total: items.length, errors: sendErrors });
};
