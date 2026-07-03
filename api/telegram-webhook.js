// Vercel Serverless Function: /api/telegram-webhook
// Public webhook target Telegram POSTs to whenever an inline-keyboard button
// is pressed (callback_query) or a text message is sent to the bot. Handles
// the approve / reject / edit lifecycle for marketing posts.
//
// Auth: this endpoint is publicly callable (Telegram doesn't sign requests),
// so we (a) require a chat_id match to TELEGRAM_CHAT_ID for any state change,
// and (b) optionally validate the X-Telegram-Bot-Api-Secret-Token header if
// TELEGRAM_WEBHOOK_SECRET is configured (recommended — set it when calling
// setWebhook).
//
// Register: curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
//   -d "url=https://meetdossie.com/api/telegram-webhook" \
//   -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"

const {
  approveFoundingApplication,
  rejectFoundingApplication,
} = require('./_lib/founding-approval');

const { handleGroupPostCallback } = require('./group-post-callback');
const { assignNextScheduledFor } = require('./_lib/scheduling.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Marketing approval flow uses a dedicated bot (DossieMarketingBot) so it
// can hold a webhook without fighting Claudy's getUpdates loop. Falls back
// to TELEGRAM_BOT_TOKEN only if the marketing-specific token isn't set.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

const ANTHROPIC_MODEL = 'claude-sonnet-5';
// Haiku is sufficient for structured scoring and fact-checking — cheaper and fast.
const SCORER_MODEL = 'claude-haiku-4-5-20251001';
const VERIFIER_MODEL = 'claude-haiku-4-5-20251001';

// ─── Platform-aware composite (mirrors cron-send-for-approval.js) ────────
// Twitter reduces CTA weight to 0.5 — punchy statements don't need explicit CTAs.
function computeComposite(hook, platform_fit, cta, platform) {
  if (platform === 'twitter') {
    return Math.round(((hook + platform_fit + cta * 0.5) / 2.5) * 10) / 10;
  }
  return Math.round(((hook + platform_fit + cta) / 3) * 10) / 10;
}

// ─── Quality Scorer (mirrors cron-send-for-approval.js scorePost) ──────────
// Scores a replacement post on Hook, Platform Fit, and CTA (1-10 each).
// Returns { hook, platform_fit, cta, composite } or null on any failure.
// Failure is non-fatal — caller falls back gracefully.
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
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const hook = Math.min(10, Math.max(1, parseInt(parsed.hook, 10) || 0));
    const platform_fit = Math.min(10, Math.max(1, parseInt(parsed.platform_fit, 10) || 0));
    const cta = Math.min(10, Math.max(1, parseInt(parsed.cta, 10) || 0));
    if (!hook || !platform_fit || !cta) return null;
    const composite = computeComposite(hook, platform_fit, cta, platform);
    return { hook, platform_fit, cta, composite };
  } catch (err) {
    console.warn('[telegram-webhook] scorePost failed:', err && err.message);
    return null;
  }
}

function formatScoreLine(score) {
  if (!score) return '';
  return `Score: ${score.composite}/10 (Hook: ${score.hook} | Fit: ${score.platform_fit} | CTA: ${score.cta})\n\n`;
}

// ─── Content Verifier (mirrors cron-generate-posts.js verifyPost) ──────────
// Minimal facts snapshot inlined so the verifier can run without loading
// external files. Checks for fabricated specifics, unshipped features, and
// over-claims. Fails safe: any error -> needs_revision verdict.
//
// NOTE: __FOUNDING_COUNT__ is substituted at call time from a live DB query;
// we hard-code a conservative fallback (9) if that query fails.
const REGEN_VERIFIER_SYSTEM_PROMPT = `You are the Dossie Content Verifier. Your only job is to find fabrications, false specifics, and over-claims in marketing copy before it ships. You are skeptical, terse, and accurate.

## PERSONA CONTENT — NEVER flag fictional personas
Brenda, Patricia, and Victor are FICTIONAL marketing personas — NOT real customers. Do not flag persona names or their usage of Dossie.

ALWAYS APPROVE content that is:
- A persona pain story or fictional Dossie usage (e.g. "She got a morning brief", "Victor uses Dossie now")
- Hypothetical scenarios ("imagine losing a deal because...")
- CAPABILITY_ONELINER, TREC_EDUCATION, or FOUNDER_STORY brand-voice posts where facts are accurate

ONLY FLAG content that:
- Claims a REAL named founding member SIGNED UP with a specific date or member number past __FOUNDING_COUNT__
- Quotes a real customer with invented specifics
- Claims a feature NOT in the shipped list as live
- Uses invented timestamps with false air of specificity

## SHIPPED FEATURES (safe to claim)
TREC deadline auto-calc with paragraph cites, contract PDF scanning, email draft queue (agent sends), morning brief with Luna voice, closing milestone cards, dossier pipeline view with deadline badges, Talk-to-Dossie chat, natural-language deadlines.

## NOT BUILT — flag if claimed as live
Reply Monitoring, AI Autopilot, Compliance Vault, White Label, amendment drafting, bulk email drafts, SMS sending, mobile native app, brokerage compliance document sending.

## VERIFIED FOUNDER PAIN STORIES (specifics OK)
- TC quit while Heath was in Italy with active transactions; 7-8hr time difference destroyed vacation
- $400/file, still waking at 4:30am wondering if option fee receipt was sent
- "Vacation is the stress test your systems fail"

FLAG anything else presented as a real Heath-specific story detail.

## Output format — STRICT JSON ONLY
{"verdict": "approve" | "needs_revision", "flags": [{"severity": "red"|"yellow"|"green", "claim": "...", "issue": "...", "fix": "..."}], "summary": "..."}
Rules: verdict "approve" only when zero red flags AND at most one yellow flag. Always include flags array even if empty.`;

async function verifyRegenPost({ platform, persona, caption }) {
  const founding = await getRegenFoundingCount();
  const systemPrompt = REGEN_VERIFIER_SYSTEM_PROMPT.replace(/__FOUNDING_COUNT__/g, String(founding));
  const userMessage = `Verify this replacement post draft. Return only the JSON verdict.\n\nPlatform: ${platform}\nPersona: ${persona}\n\nDRAFT:\n${caption}`;

  let res, text;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: VERIFIER_MODEL,
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    text = await res.text();
  } catch (err) {
    return {
      verdict: 'needs_revision',
      flags: [{ severity: 'red', claim: '(verifier API error)', issue: String(err && err.message || err).slice(0, 200), fix: 'retry or review manually' }],
      summary: 'Verifier call failed — defaulting to needs_revision (fail-safe).',
    };
  }

  if (!res.ok) {
    return {
      verdict: 'needs_revision',
      flags: [{ severity: 'red', claim: '(verifier HTTP error)', issue: `HTTP ${res.status}`, fix: 'retry or review manually' }],
      summary: `Verifier HTTP ${res.status} — defaulting to needs_revision (fail-safe).`,
    };
  }

  let raw;
  try {
    const data = JSON.parse(text);
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    raw = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim()) || null;
  } catch { raw = null; }

  if (!raw) {
    return {
      verdict: 'needs_revision',
      flags: [{ severity: 'red', claim: '(verifier empty response)', issue: 'no content block returned', fix: 'review manually' }],
      summary: 'Verifier returned empty response — defaulting to needs_revision.',
    };
  }

  let parsed;
  try {
    // Strip markdown fences if present
    let s = String(raw).trim();
    if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
    const fb = s.indexOf('{'); const lb = s.lastIndexOf('}');
    if (fb >= 0 && lb > fb) s = s.slice(fb, lb + 1);
    parsed = JSON.parse(s);
  } catch {
    return {
      verdict: 'needs_revision',
      flags: [{ severity: 'red', claim: '(verifier malformed JSON)', issue: 'could not parse verifier response', fix: 'review manually' }],
      summary: 'Verifier returned malformed JSON — defaulting to needs_revision.',
    };
  }

  const verdict = parsed?.verdict === 'approve' ? 'approve' : 'needs_revision';
  const flags = Array.isArray(parsed?.flags) ? parsed.flags : [];
  const summary = typeof parsed?.summary === 'string' ? parsed.summary : '';
  const hasRedFlag = flags.some((f) => String(f?.severity || '').toLowerCase() === 'red');
  return { verdict: hasRedFlag ? 'needs_revision' : verdict, flags, summary };
}

function formatVerifierLine(verifierResult) {
  if (!verifierResult) return '';
  const verdict = String(verifierResult.verdict || '').toLowerCase();
  const flags = Array.isArray(verifierResult.flags) ? verifierResult.flags : [];
  const interesting = flags.filter((f) => ['red', 'yellow'].includes(String(f?.severity || '').toLowerCase()));

  if (verdict === 'approve' && interesting.length === 0) {
    return '🤖 VERIFIER: ✅ Clean — no flags\n\n';
  }

  const lines = [`🤖 VERIFIER: ⚠️ ${interesting.length} flag${interesting.length === 1 ? '' : 's'} (${verdict})`];
  for (const f of interesting.slice(0, 4)) {
    const sev = String(f.severity || '').toLowerCase();
    const claim = String(f.claim || '').slice(0, 60);
    const issue = String(f.issue || '').slice(0, 120);
    lines.push(`   - [${sev}] "${claim}" — ${issue}`);
  }
  if (verifierResult.summary) lines.push(`   ${String(verifierResult.summary).slice(0, 160)}`);
  return lines.join('\n') + '\n\n';
}

// Live founding member count for the verifier prompt — same pattern as
// cron-generate-posts.js getFoundingMemberCount(). Hard-coded fallback
// if the query fails so the verifier still runs.
async function getRegenFoundingCount() {
  try {
    const r = await supabaseFetch(
      `/rest/v1/subscriptions?select=id&status=in.(active,trialing)&plan=eq.founding`,
    );
    if (r.ok && Array.isArray(r.data)) return r.data.length;
  } catch (err) {
    console.warn('[telegram-webhook] getRegenFoundingCount failed:', err && err.message);
  }
  return 9; // conservative fallback
}

// ─── Regeneration helpers (used when a post is rejected) ──────────────────

const REGEN_PERSONAS = {
  brenda: 'Burned-out solo agent, 6 years in, pays her transaction coordinator $8,000/year. Voice: tired, witty, blunt about industry pain. Not whiny - wry. Talks like she\'s telling a friend over coffee at 9pm after the kids are in bed.',
  patricia: 'Part-time agent, 8-12 deals/year, also has a day job. Voice: practical, budget-conscious, no fluff. Skeptical of anything that sounds like a sales pitch. Cares about whether something pays for itself in 2 deals or fewer.',
  victor: 'Top producer, 50+ deals/year, runs a small team. Voice: confident, math-driven, ambitious. Talks in margins and capacity. Not cocky - operational. Sees TC cost as a fixed leak and is always looking for the unlock.',
};

const REGEN_PLATFORM_RULES = {
  tiktok:    'Hook under 8 words, never start with "I". Under 150 words. Line breaks after every 1-2 sentences. End with "Link in bio". 2-3 hashtags: #txrealestate #realtorlife #trec',
  instagram: 'Stop-scroll first line (front-load <125 chars). 150-300 words. SAVE/SHARE CTA. 8-10 hashtags at end.',
  facebook:  'Pain-point or question hook. 200-500 words. Short paragraphs (2-3 sentences). Comment-driving question CTA. NO hashtags.',
  twitter:   'Punchy/contrarian opener under 280 chars. Thread of 5-8 tweets OR single tweet - nothing in between. End with question or "RT if this helped". 2-3 hashtags at end.',
  linkedin:  'First two lines visible before fold - specific insight or number. 1300-2000 chars. Short paragraphs. End with a question inviting replies. 3-5 hashtags at end.',
};

function buildRegenPrompt(platform, persona, topic) {
  const personaSummary = REGEN_PERSONAS[persona] || persona;
  const platformRules = REGEN_PLATFORM_RULES[platform] || 'Follow standard social media best practices.';
  const topicLabel = topic || 'Dossie AI transaction coordinator for Texas real estate agents';

  return `Generate ONE replacement social media post for Dossie. The previous post for this slot was rejected by the editor.

PERSONA: ${persona} - ${personaSummary}
PLATFORM: ${platform}
TOPIC ANGLE: ${topicLabel}

PLATFORM RULES (apply strictly):
${platformRules}

BRAND CONTEXT:
- Dossie is an AI transaction coordinator for Texas real estate agents.
- Founding-member pricing is $29/month, locked while subscription stays active.
- Sign up: meetdossie.com/founding
- Voice: warm but blunt. Peer-to-peer, not marketer-to-prospect.

PERSONA VOICE - CRITICAL:
- Write in THIRD PERSON, never first person.
- NEVER write "I" as if the persona is the poster.
- Brenda = she/her, Patricia = she/her, Victor = he/him.

FACTUAL ACCURACY - NON-NEGOTIABLE:
- Only reference real shipped features: TREC deadline auto-calc, contract PDF scanning, email draft queue (agent sends), morning brief with voice, closing milestone cards, dossier pipeline view, Talk-to-Dossie chat.
- No invented stats, no made-up testimonials, no fabricated timestamps.
- Frame numbers as hypotheticals: "agents doing 50+ deals a year", "if you're paying around $400 a file".
- Use "recently" or "over the last few weeks" for Dossie usage timeframes - never imply months/years.

TEXT ENCODING:
- No em-dashes (use plain hyphens -), no curly quotes, no special Unicode.
- Plain ASCII only.

Return STRICT JSON only. No markdown fences. No commentary.

{
  "persona": "${persona}",
  "platform": "${platform}",
  "card_body": "<MAX 50 WORDS. Punchy standalone text for image card. 2-3 short sentences.>",
  "caption": "<full post text for social media, include CTA and hashtags at end>",
  "hook": "<5-8 words max, pattern-interrupting opener>",
  "cta": "<CTA line referencing meetdossie.com/founding>",
  "hashtags": ["hashtag1", "hashtag2"],
  "stat": "<bold anchor, max 10 chars, e.g. '$29/mo' or '80+'>",
  "stat_label": "<descriptive phrase, max 50 chars>"
}`;
}

async function callAnthropicForRegen(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Anthropic returned non-JSON: ' + text.slice(0, 200));
  }
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const content = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  if (!content) throw new Error('Anthropic returned no content block');
  return content;
}

function extractRegenJson(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  }
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(s);
}

// Send the replacement post to Telegram for approval (same 2-message pattern
// as cron-send-for-approval: image card first, full content + buttons second).
async function sendReplacementToTelegram(chatId, post) {
  const platform = post.platform || 'unknown';
  const persona = post.persona || 'unknown';
  const hook = String(post.hook || '').trim();
  const stat = String(post.stat || '').trim();
  const statLabel = String(post.stat_label || '').trim();

  // Message 1: short preview (no buttons), with card image if available
  let shortCaption = `Replacement post\n\n${platform} (${persona})\n`;
  if (hook) shortCaption += `\n${hook}\n`;
  if (stat) shortCaption += `\n${stat}`;
  if (statLabel) shortCaption += ` - ${statLabel}`;
  shortCaption = shortCaption.slice(0, 1020);

  const photoMethod = post.media_url ? 'sendPhoto' : 'sendMessage';
  const photoBody = post.media_url
    ? { chat_id: chatId, photo: post.media_url, caption: shortCaption }
    : { chat_id: chatId, text: shortCaption, disable_web_page_preview: true };

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${photoMethod}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(photoBody),
  });

  // Message 2: full content + score + verifier + approve/reject/edit buttons
  const content = String(post.content || '');
  const hashtags = Array.isArray(post.hashtags) && post.hashtags.length
    ? post.hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';

  const scoreLine = post.score ? formatScoreLine(post.score) : '';
  const verifierLine = post.verifierResult ? formatVerifierLine(post.verifierResult) : '';

  const fullText = `${verifierLine}${scoreLine}Replacement post for ${platform} (${persona})\n\n${content}\n\nHashtags: ${hashtags}`;

  const buttons = {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `approve_${post.id}` },
      { text: 'Reject', callback_data: `reject_${post.id}` },
      { text: 'Edit', callback_data: `edit_${post.id}` },
    ]],
  };

  const textRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: fullText.slice(0, 4096),
      reply_markup: buttons,
      disable_web_page_preview: true,
    }),
  });
  const textData = await textRes.json().catch(() => null);
  const messageId = textData?.result?.message_id || null;

  // Mark the post as sent so cron-send-for-approval doesn't re-queue it
  if (messageId && post.id) {
    await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        telegram_sent_at: new Date().toISOString(),
        telegram_message_id: messageId,
      }),
    });
  }
}

async function regeneratePost(rejectedPost) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[telegram-webhook] regeneratePost: ANTHROPIC_API_KEY not set, skipping regen');
    return;
  }
  const platform = String(rejectedPost.platform || '').toLowerCase();
  const persona = String(rejectedPost.persona || '').toLowerCase();
  const topic = String(rejectedPost.topic || '');
  if (!platform || !persona) {
    console.warn('[telegram-webhook] regeneratePost: missing platform or persona on rejected post', rejectedPost.id);
    return;
  }

  console.log(`[telegram-webhook] regenerating replacement for ${platform}/${persona} topic="${topic}"`);

  let raw;
  try {
    raw = await callAnthropicForRegen(buildRegenPrompt(platform, persona, topic));
  } catch (err) {
    console.error('[telegram-webhook] regen Anthropic call failed:', err && err.message);
    return;
  }

  let parsed;
  try {
    parsed = extractRegenJson(raw);
  } catch (err) {
    console.error('[telegram-webhook] regen JSON parse failed:', err && err.message, 'raw:', String(raw).slice(0, 200));
    return;
  }

  const caption = String(parsed.caption || '').trim();
  if (!caption) {
    console.error('[telegram-webhook] regen: no caption in parsed response');
    return;
  }

  // ─── Score + verify in parallel (non-blocking) ─────────────────────────
  // Run both quality scoring and content verification concurrently to keep
  // the replacement flow fast. Both fail safe: null score = skip display,
  // verifier error = needs_revision (still sends to Telegram for Heath review).
  const [score, verifierResult] = await Promise.all([
    scorePost(caption, platform),
    verifyRegenPost({ platform, persona, caption }),
  ]);

  console.log(`[telegram-webhook] regen score=${score ? score.composite + '/10' : 'null'} verifier=${verifierResult.verdict} flags=${Array.isArray(verifierResult.flags) ? verifierResult.flags.length : 0}`);

  // Build a unique post_id for the replacement
  const today = new Date().toISOString().slice(0, 10);
  const suffix = Math.floor(Date.now() / 1000) % 100000;
  const postId = `${today}-${persona}-${platform}-regen-${suffix}`;

  // Look up zernio_account_id from existing post (best-effort)
  const zernioAccountId = rejectedPost.zernio_account_id || null;

  // Replacements always land as 'draft' regardless of verifier verdict —
  // Heath sees both the score and verifier flags in Telegram and decides.
  // A needs_revision verdict is surfaced prominently in the message so Heath
  // knows to scrutinize it before tapping Approve.
  const row = {
    post_id: postId,
    platform,
    content: caption,
    content_hash: require('crypto').createHash('md5').update(caption).digest('hex'),
    hook: String(parsed.hook || '').trim() || caption.slice(0, 120),
    cta: String(parsed.cta || '').trim(),
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean)
      : [],
    status: 'draft',
    telegram_sent_at: null,
    telegram_message_id: null,
    zernio_account_id: zernioAccountId,
    persona,
    topic,
    media_url: null, // No card render on regen (keep it fast; Heath reviews in Telegram)
    generated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    verifier_result: verifierResult || null,
    error_message: null,
  };

  const ins = await supabaseFetch('/rest/v1/social_posts?on_conflict=post_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(row),
  });

  if (!ins.ok) {
    console.error('[telegram-webhook] regen insert failed:', ins.status, JSON.stringify(ins.data).slice(0, 200));
    return;
  }

  // Grab the inserted row's id (UUID) for Telegram buttons
  const insertedRow = Array.isArray(ins.data) && ins.data.length > 0 ? ins.data[0] : null;
  if (!insertedRow || !insertedRow.id) {
    console.error('[telegram-webhook] regen: could not get inserted row id');
    return;
  }

  console.log(`[telegram-webhook] regen inserted as id=${insertedRow.id} post_id=${postId}`);

  // Send to Telegram for approval — include score and verifier results
  const chatId = TELEGRAM_CHAT_ID;
  if (chatId) {
    const postForTg = { ...row, ...parsed, id: insertedRow.id, score, verifierResult };
    try {
      await sendReplacementToTelegram(chatId, postForTg);
      console.log(`[telegram-webhook] regen sent to Telegram for approval`);
    } catch (err) {
      console.error('[telegram-webhook] regen Telegram send failed:', err && err.message);
    }
  }
}

const EDIT_PROMPT_PREFIX = '✏️ Editing post ';
const EDIT_PROMPT_SUFFIX = '. Reply to this message with the new content.';

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

async function tgCall(method, body) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || data?.ok !== true) {
    console.error('[telegram-webhook] tg', method, 'failed:', res.status, text.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true, data };
}

async function answerCallback(callbackQueryId, text) {
  return tgCall('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text || '', show_alert: false });
}

async function editMessage(chatId, messageId, text) {
  return tgCall('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    disable_web_page_preview: true,
  });
}

async function sendMessage(chatId, text, replyToMessageId, forceReply, logStep) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyToMessageId) body.reply_to_message_id = replyToMessageId;
  if (forceReply) body.reply_markup = { force_reply: true, selective: true };
  const result = await tgCall('sendMessage', body);
  if (logStep) logStep({
    step: 'sendMessage_called',
    chatId,
    textPreview: text.substring(0, 50),
    success: result.ok,
    error: result.ok ? null : result.data?.description
  });
  return result;
}

async function loadPost(postId) {
  try {
    const enc = encodeURIComponent(postId);
    const { data } = await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}&limit=1`);
    if (Array.isArray(data) && data.length > 0) return data[0];
    return null;
  } catch (err) {
    console.error('[telegram-webhook] loadPost failed:', err?.message);
    return null;
  }
}

async function patchPost(postId, patch) {
  try {
    const enc = encodeURIComponent(postId);
    return await supabaseFetch(`/rest/v1/social_posts?id=eq.${enc}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.error('[telegram-webhook] patchPost failed:', err?.message);
    return { ok: false, error: err?.message };
  }
}

async function bumpBatchCounter(postId, field) {
  try {
    // Best-effort: no batch_id link on social_posts, so we look up the latest
    // batch and bump its counter. This is informational only.
    const { data } = await supabaseFetch(
      `/rest/v1/content_batches?order=generated_at.desc&limit=1`,
    );
    const batch = Array.isArray(data) && data.length > 0 ? data[0] : null;
    if (!batch || !batch.id) return;
    const next = (batch[field] || 0) + 1;
    await supabaseFetch(`/rest/v1/content_batches?id=eq.${encodeURIComponent(batch.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ [field]: next }),
    });
  } catch (err) {
    console.error('[telegram-webhook] bumpBatchCounter failed:', err?.message);
    // Non-fatal: this is informational only
  }
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') {
      resolve(req.body);
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8'); });
    req.on('end', () => {
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleFoundingCallback(action, applicationId, cb, chatId, messageId, callbackId) {
  const message = cb?.message;
  const originalBody = String(message?.text || '');

  if (action === 'approve') {
    let result;
    try {
      result = await approveFoundingApplication({ applicationId, env: process.env });
    } catch (err) {
      console.error('[telegram-webhook] founding approve threw:', err && err.message);
      result = { ok: false, error: (err && err.message) || String(err) };
    }
    if (!result.ok) {
      const errText = `❌ Approval failed: ${result.error || 'unknown error'}`;
      if (chatId && messageId) {
        await editMessage(chatId, messageId, `${originalBody}\n\n${errText}`);
      }
      if (callbackId) await answerCallback(callbackId, 'Approval failed');
      return;
    }
    const tail = [
      '',
      `✅ APPROVED — checkout sent to ${result.application.email}`,
      `Email id: ${result.emailId || (result.emailError ? 'failed — ' + result.emailError : '—')}`,
      result.checkoutUrl ? `URL: ${result.checkoutUrl}` : '',
    ].filter(Boolean).join('\n');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}${tail}`);
    }
    if (callbackId) await answerCallback(callbackId, 'Approved');
    return;
  }

  if (action === 'reject') {
    try {
      await rejectFoundingApplication({ applicationId });
    } catch (err) {
      console.error('[telegram-webhook] founding reject threw:', err && err.message);
    }
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n❌ REJECTED`);
    }
    if (callbackId) await answerCallback(callbackId, 'Rejected');
    return;
  }
}


async function handleCallbackQuery(cb) {
  const data = String(cb?.data || '');
  const callbackId = cb?.id;
  const message = cb?.message;
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;

  // Only honor callbacks from the configured chat. Drop everything else.
  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    if (callbackId) await answerCallback(callbackId, 'Not authorized');
    return;
  }

  // Founding application flow: approve_founding:<id> / reject_founding:<id>
  // Note the colon delimiter, distinguishing it from the social-post flow's
  // underscore (approve_<post_id>).
  const founding = data.match(/^(approve|reject)_founding:(.+)$/);
  if (founding) {
    return handleFoundingCallback(founding[1], founding[2], cb, chatId, messageId, callbackId);
  }

  // Group post approval flow: group_approve_<id> / group_reject_<id> / group_skip_<id>
  const groupPost = data.match(/^(group_approve|group_reject|group_skip)_(.+)$/);
  if (groupPost) {
    const originalBody = String(message?.text || '');
    return handleGroupPostCallback(groupPost[1], groupPost[2], callbackId, chatId, messageId, originalBody);
  }

  // Check for retry button
  const retry = data.match(/^retry_(.+)$/);
  if (retry) {
    const postId = retry[1];
    const post = await loadPost(postId);
    if (!post) {
      if (callbackId) await answerCallback(callbackId, 'Post not found');
      return;
    }

    // Reset to approved so next cron run will retry.
    // If the original scheduled_for is null or in the past, reassign so the
    // publish cron doesn't fire it immediately and bypass platform daily caps.
    const retryPatch = {
      status: 'approved',
      error_message: null,
      publishing_started_at: null,
    };
    const hasFutureSlot = post.scheduled_for && new Date(post.scheduled_for) > new Date();
    if (!hasFutureSlot) {
      try {
        const slotIso = await assignNextScheduledFor(post);
        if (slotIso) retryPatch.scheduled_for = slotIso;
        console.log(`[telegram-webhook] retry: reassigned scheduled_for=${slotIso || '(immediate fallback)'} for ${postId}`);
      } catch (err) {
        console.warn('[telegram-webhook] retry scheduling helper failed for', postId, err && err.message);
      }
    }
    await patchPost(postId, retryPatch);

    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${String(message?.text || '')}\n\n🔄 Reset to approved — will retry at next cron run.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Queued for retry');
    return;
  }

  // Video approval flow: video_approve_{id} / video_reject_{id}
  // Approve sets status='heath_approved' — cron-post-videos picks up only heath_approved rows.
  if (data.startsWith('video_approve_')) {
    const videoId = data.replace('video_approve_', '');
    await supabaseFetch(`/rest/v1/video_library?id=eq.${encodeURIComponent(videoId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'heath_approved' }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nApproved - will post at next cron run.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Video approved');
    return;
  }

  if (data.startsWith('video_reject_')) {
    const videoId = data.replace('video_reject_', '');
    await supabaseFetch(`/rest/v1/video_library?id=eq.${encodeURIComponent(videoId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nRejected.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Video rejected');
    return;
  }

  // Skit approval flow: skit_approve_{id} / skit_reject_{id}
  if (data.startsWith('skit_approve_')) {
    const skitId = data.replace('skit_approve_', '');

    // Fetch skit from skit_queue
    const { data: skitRows } = await supabaseFetch(
      `/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}&limit=1`,
    );
    const skit = Array.isArray(skitRows) && skitRows.length > 0 ? skitRows[0] : null;

    if (!skit) {
      if (callbackId) await answerCallback(callbackId, 'Skit not found');
      return;
    }

    // Update status to script_approved
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'script_approved',
        approved_at: new Date().toISOString(),
      }),
    });

    // Edit the approval message
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nScript approved - rendering queued.`);
    }

    // Notify Heath via personal Claudy bot
    const PERSONAL_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const topic = skit.topic || skitId;
    if (PERSONAL_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      const notifyText = `Skit '${topic}' approved! Cole will render it - run: python scripts/produce-skits.py --from-queue ${skitId}`;
      await fetch(`https://api.telegram.org/bot${PERSONAL_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: notifyText,
          disable_web_page_preview: true,
        }),
      }).catch((err) => {
        console.warn('[telegram-webhook] skit approval notify failed:', err && err.message);
      });
    }

    if (callbackId) await answerCallback(callbackId, 'Script approved - rendering queued');
    return;
  }

  if (data.startsWith('skit_reject_')) {
    const skitId = data.replace('skit_reject_', '');

    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rejected' }),
    });

    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nSkit rejected.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Skit rejected');
    return;
  }

  // Rendered reel final approval: skit_video_approve_{id} / skit_video_reject_{id}
  if (data.startsWith('skit_video_approve_')) {
    const skitId = data.replace('skit_video_approve_', '');
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'video_approved' }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nReel approved - will post to Instagram + TikTok at next cron run.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Reel approved');
    return;
  }

  if (data.startsWith('skit_video_reject_')) {
    const skitId = data.replace('skit_video_reject_', '');
    await supabaseFetch(`/rest/v1/skit_queue?id=eq.${encodeURIComponent(skitId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'video_rejected' }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nReel rejected.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Reel rejected');
    return;
  }

  // Veto mode: STOP cancels auto-post, PREVIEW sends full caption as follow-up
  if (data.startsWith('stop_')) {
    const postId = data.replace('stop_', '');
    await patchPost(postId, { status: 'rejected' });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nStopped. Post cancelled.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Post cancelled');
    return;
  }

  if (data.startsWith('preview_')) {
    const postId = data.replace('preview_', '');
    const post = await loadPost(postId);
    if (!post) {
      if (callbackId) await answerCallback(callbackId, 'Post not found');
      await tgCall('sendMessage', { chat_id: chatId, text: `Post not found (id: ${postId}). It may have already been posted or deleted.`, disable_web_page_preview: true });
      return;
    }
    const platform = String(post.platform || 'unknown').toUpperCase();
    const persona = String(post.persona || '');
    const content = String(post.content || '');
    const hashtags = Array.isArray(post.hashtags) && post.hashtags.length
      ? post.hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
      : '';
    const scheduledLine = post.scheduled_for ? `Scheduled: ${post.scheduled_for}` : '';
    const statusLine = `Status: ${post.status || 'unknown'}`;
    const headerLines = [
      `Platform: ${platform}${persona ? ' (' + persona + ')' : ''}`,
      `Post ID: ${post.post_id || postId}`,
      statusLine,
      scheduledLine,
    ].filter(Boolean).join('\n');
    const previewText = `${headerLines}\n\n${content}${hashtags ? '\n\n' + hashtags : ''}`.slice(0, 4096);
    await tgCall('sendMessage', { chat_id: chatId, text: previewText, disable_web_page_preview: true });
    if (callbackId) await answerCallback(callbackId, 'Full caption sent');
    return;
  }

  // Veto mode: STOP for fb_comment_replies
  if (data.startsWith('reply_stop_')) {
    const replyId = data.replace('reply_stop_', '');
    await supabaseFetch(`/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nReply cancelled.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Reply cancelled');
    return;
  }

  // Veto mode: PREVIEW for fb_comment_replies
  if (data.startsWith('reply_preview_')) {
    const replyId = data.replace('reply_preview_', '');
    const { data: replyRows } = await supabaseFetch(
      `/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}&limit=1`,
    );
    const reply = Array.isArray(replyRows) && replyRows.length > 0 ? replyRows[0] : null;
    if (!reply) {
      if (callbackId) await answerCallback(callbackId, 'Reply not found');
      return;
    }
    const previewText = `Group: ${reply.group_post_id || 'unknown'}\nIn response to: ${reply.reply_author}: "${reply.reply_text}"\n\nDraft: ${reply.our_response_draft}`;
    await tgCall('sendMessage', { chat_id: chatId, text: previewText.slice(0, 4096), disable_web_page_preview: true });
    if (callbackId) await answerCallback(callbackId, 'Preview sent');
    return;
  }

  // Veto mode: STOP for twitter_engagements
  if (data.startsWith('tw_stop_')) {
    const engId = data.replace('tw_stop_', '');
    await supabaseFetch(`/rest/v1/twitter_engagements?id=eq.${encodeURIComponent(engId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'rejected' }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nReply cancelled.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Reply cancelled');
    return;
  }

  // Veto mode: PREVIEW for twitter_engagements
  if (data.startsWith('tw_preview_')) {
    const engId = data.replace('tw_preview_', '');
    const { data: engRows } = await supabaseFetch(
      `/rest/v1/twitter_engagements?id=eq.${encodeURIComponent(engId)}&limit=1`,
    );
    const eng = Array.isArray(engRows) && engRows.length > 0 ? engRows[0] : null;
    if (!eng) {
      if (callbackId) await answerCallback(callbackId, 'Engagement not found');
      return;
    }
    const previewText = `Tweet by @${eng.tweet_author}:\n"${eng.tweet_text}"\n\nURL: ${eng.tweet_url}\n\nDraft reply:\n${eng.our_response_draft}`;
    await tgCall('sendMessage', { chat_id: chatId, text: previewText.slice(0, 4096), disable_web_page_preview: true });
    if (callbackId) await answerCallback(callbackId, 'Preview sent');
    return;
  }

  // Comment approval flow: comment_approve:<platform>:<id> / comment_reject:<platform>:<id>
  // Routes to facebook_comment_drafts / instagram_comment_drafts / linkedin_comment_drafts.
  // Reddit comments still use the reddit_stop_ veto pattern below.
  const commentMatch = data.match(/^comment_(approve|reject):([a-z]+):([\w-]+)$/);
  if (commentMatch) {
    const action = commentMatch[1];
    const platform = commentMatch[2];
    const draftId = commentMatch[3];
    const COMMENT_TABLES = {
      facebook:  'facebook_comment_drafts',
      instagram: 'instagram_comment_drafts',
      linkedin:  'linkedin_comment_drafts',
    };
    const table = COMMENT_TABLES[platform];
    if (!table) {
      if (callbackId) await answerCallback(callbackId, 'Unknown comment platform');
      return;
    }
    const nowIso = new Date().toISOString();
    const patch = action === 'approve'
      ? { status: 'approved', approved_at: nowIso, approved_by: 'telegram' }
      : { status: 'rejected', rejection_reason: 'manual veto' };
    await supabaseFetch(`/rest/v1/${table}?id=eq.${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    const originalBody = String(message?.text || '');
    const tail = action === 'approve' ? 'Approved.' : 'Rejected.';
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n${tail}`);
    }
    if (callbackId) await answerCallback(callbackId, tail);
    return;
  }

  // Unified engagement_candidates approval flow.
  // callback_data: eng_approve:<id> / eng_reject:<id>
  // The numeric id is the bigserial primary key on engagement_candidates.
  // Approve flips status to 'approved' -- the PyAutoGUI poster
  // (scripts/unified-scanner/post_via_chrome.py) picks it up on its next run.
  const engMatch = data.match(/^eng_(approve|reject):(\d+)$/);
  if (engMatch) {
    const engAction = engMatch[1];
    const engId = engMatch[2];
    const nowIso = new Date().toISOString();
    const patch = engAction === 'approve'
      ? { status: 'approved', approved_at: nowIso, approved_by: 'telegram' }
      : { status: 'rejected', rejection_reason: 'manual_veto' };
    await supabaseFetch(`/rest/v1/engagement_candidates?id=eq.${encodeURIComponent(engId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    const originalBody = String(message?.text || '');
    const tail = engAction === 'approve'
      ? 'Approved -- will post via real Chrome on next poster run.'
      : 'Rejected.';
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n${tail}`);
    }
    if (callbackId) await answerCallback(callbackId, tail);
    return;
  }

  // Veto mode for engagement_candidates (Atlas SV-FB-VETO-001, 2026-06-11).
  // callback_data: eng_stop:<id>  -> mark vetoed, kill the auto-post path.
  // callback_data: eng_edit:<id>  -> ack + prompt Heath to reply with new
  //                                  draft text (handled in message handler).
  // Numeric id is the bigserial primary key on engagement_candidates.
  const engStopMatch = data.match(/^eng_stop:(\d+)$/);
  if (engStopMatch) {
    const engId = engStopMatch[1];
    const nowIso = new Date().toISOString();
    await supabaseFetch(`/rest/v1/engagement_candidates?id=eq.${encodeURIComponent(engId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'vetoed',
        vetoed_at: nowIso,
        veto_reason: 'user_stop',
      }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n🛑 STOPPED -- comment killed, will not post.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Stopped');
    return;
  }

  const engEditMatch = data.match(/^eng_edit:(\d+)$/);
  if (engEditMatch) {
    const engId = engEditMatch[1];
    // Park the row as vetoed for now -- Heath sending edit text is a future
    // hook (would need message-handler thread state). The veto-mode cron will
    // not auto-post a vetoed row, so this is safe-by-default.
    const nowIso = new Date().toISOString();
    await supabaseFetch(`/rest/v1/engagement_candidates?id=eq.${encodeURIComponent(engId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'vetoed',
        vetoed_at: nowIso,
        veto_reason: 'user_edit_requested',
      }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n✏️ EDIT requested -- comment held. Reply with the new draft to ship manually, or leave as-is to drop it.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Edit -- held');
    return;
  }

  // Veto mode: STOP for reddit_engagements
  // callback_data format: reddit_stop_<post_id>
  // where post_id is the composite key "subreddit_redditid" stored in reddit_engagements.post_id
  if (data.startsWith('reddit_stop_')) {
    const postId = data.replace('reddit_stop_', '');
    await supabaseFetch(`/rest/v1/reddit_engagements?post_id=eq.${encodeURIComponent(postId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'stopped', stopped_at: new Date().toISOString() }),
    });
    const originalBody = String(message?.text || '');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\nStopped. Reddit reply cancelled.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Reddit reply cancelled');
    return;
  }

  const m = data.match(/^(approve|reject|edit)_(.+)$/);
  if (!m) {
    if (callbackId) await answerCallback(callbackId, 'Unknown action');
    return;
  }
  const action = m[1];
  const postId = m[2];

  const post = await loadPost(postId);
  if (!post) {
    if (callbackId) await answerCallback(callbackId, 'Post not found');
    return;
  }

  const now = new Date().toISOString();
  const originalBody = String(message?.text || '');

  if (action === 'approve') {
    console.log(`[telegram-webhook] APPROVE action for postId="${postId}"`);

    // Single-gate approval — card already rendered at generation time.
    // Approve goes straight to status='approved'.
    console.log(`[telegram-webhook] Post object:`, JSON.stringify(post));
    const patchBody = { status: 'approved', approved_at: now, approved_by: 'telegram' };
    // Assign next available slot so the publish cron respects platform daily caps.
    // (Without this, scheduled_for=NULL caused the publish cron to fire all
    // approved rows immediately, bypassing caps. Ridge caught it twice 6/26-6/27.)
    if (!post.scheduled_for) {
      try {
        const slotIso = await assignNextScheduledFor(post);
        if (slotIso) patchBody.scheduled_for = slotIso;
        console.log(`[telegram-webhook] assigned scheduled_for=${slotIso || '(immediate fallback)'} to ${postId}`);
      } catch (err) {
        console.warn('[telegram-webhook] scheduling helper failed for', postId, err && err.message);
      }
    }
    console.log(`[telegram-webhook] Patch body:`, JSON.stringify(patchBody));
    const patchResult = await patchPost(postId, patchBody);
    console.log(`[telegram-webhook] Patch result:`, JSON.stringify(patchResult));
    await bumpBatchCounter(postId, 'approved_posts');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n✅ Approved — will post at next slot.`);
    }
    if (callbackId) await answerCallback(callbackId, 'Approved');
    return;
  }

  if (action === 'reject') {
    await patchPost(postId, { status: 'rejected' });
    await bumpBatchCounter(postId, 'rejected_posts');
    // Answer the callback immediately so Telegram doesn't show a loading spinner.
    // The message edit and regen happen after — Vercel keeps the function alive
    // until the module.exports handler returns (we await this whole chain).
    if (callbackId) await answerCallback(callbackId, 'Rejected');
    if (chatId && messageId) {
      await editMessage(chatId, messageId, `${originalBody}\n\n❌ Rejected. Generating replacement...`);
    }

    // Send a confirmation notification so Heath has a record of what was manually rejected.
    // Uses TELEGRAM_BOT_TOKEN (DossieMarketingBot) — same bot already handling this flow.
    const rejectChatId = TELEGRAM_CHAT_ID || '7874782923';
    if (TELEGRAM_BOT_TOKEN && rejectChatId) {
      const hookPreview = String(post.content || post.hook || '').slice(0, 80);
      const platform = String(post.platform || 'unknown');
      const persona = String(post.persona || 'unknown');
      const notifyText = `Rejected post (${platform} / ${persona})\nHook: ${hookPreview}`;
      fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: rejectChatId, text: notifyText }),
      }).catch((err) => {
        console.warn('[telegram-webhook] reject notification failed:', err && err.message);
      });
    }

    // Await regen so Vercel doesn't kill the function before it finishes.
    // Claude API call takes ~3-8s — well within Vercel's 10s default timeout.
    try {
      await regeneratePost(post);
    } catch (err) {
      console.error('[telegram-webhook] regeneratePost unhandled error:', err && err.message);
    }
    return;
  }

  if (action === 'edit') {
    // Send a force_reply prompt that encodes the post_id in the text. The
    // text message handler will parse it back out when the user replies.
    const promptText = `${EDIT_PROMPT_PREFIX}${postId}${EDIT_PROMPT_SUFFIX}`;
    await sendMessage(chatId, promptText, messageId, true);
    if (callbackId) await answerCallback(callbackId, 'Reply with new content');
    return;
  }
}

async function handleTextMessage(msg, logStep) {
  const chatId = msg?.chat?.id;
  const messageText = String(msg?.text || '');

  if (logStep) logStep({ step: 'text_message_received', chatId, text: messageText.substring(0, 50) });

  if (TELEGRAM_CHAT_ID && String(chatId) !== String(TELEGRAM_CHAT_ID)) {
    if (logStep) logStep({ step: 'text_message_unauthorized', chatId });
    return;
  }

  const replyTo = msg?.reply_to_message;

  // Handle replies to edit prompts
  if (replyTo) {
    const replyText = String(replyTo.text || '');
    if (replyText.startsWith(EDIT_PROMPT_PREFIX)) {
      // Extract post_id between prefix and suffix
      if (logStep) logStep({ step: 'processing_edit_reply' });
      const after = replyText.slice(EDIT_PROMPT_PREFIX.length);
      const cut = after.indexOf(EDIT_PROMPT_SUFFIX);
      const postId = cut > 0 ? after.slice(0, cut).trim() : after.split(/\s/)[0].trim();

      if (postId) {
        const newContent = messageText.trim();
        if (newContent) {
          // Update the post's content and re-queue for re-approval
          await patchPost(postId, {
            content: newContent,
            hook: newContent.slice(0, 120),
            telegram_sent_at: null,
            telegram_message_id: null,
            status: 'draft',
          });
          await sendMessage(chatId, `✏️ Edit saved for ${postId}. It'll come back for re-approval at the next send cycle.`, msg.message_id, null, logStep);
          if (logStep) logStep({ step: 'edit_saved', postId });
          return;
        }
      }
    }
  }

  // Handle commands
  if (logStep) logStep({ step: 'handling_general_message' });

  const command = messageText.trim().toLowerCase();

  // /status - today's social post counts
  if (command === '/status' || command === 'status') {
    try {
      const today = new Date().toISOString().split('T')[0];
      const startTime = `${today}T00:00:00`;
      const endTime = `${today}T23:59:59`;

      const { data: posts } = await supabaseFetch(
        `/rest/v1/social_posts?created_at=gte.${startTime}&created_at=lte.${endTime}&select=id,platform,status`
      );

      if (!posts || posts.length === 0) {
        await sendMessage(chatId, '📊 No posts created today.', null, null, logStep);
        return;
      }

      const statusCounts = posts.reduce((acc, p) => {
        acc[p.status] = (acc[p.status] || 0) + 1;
        return acc;
      }, {});

      const approved = statusCounts.approved || 0;
      const posted = statusCounts.posted || 0;
      const failed = statusCounts.failed || 0;
      const draft = statusCounts.draft || 0;
      const rejected = statusCounts.rejected || 0;

      const response = `📊 Social Posts (${today})

✅ Posted: ${posted}
⏳ Approved: ${approved}
❌ Failed: ${failed}
📝 Draft: ${draft}
🚫 Rejected: ${rejected}

Total: ${posts.length}`;

      await sendMessage(chatId, response, null, null, logStep);
      if (logStep) logStep({ step: 'status_response_sent' });
    } catch (err) {
      console.error('[telegram-webhook] status query failed:', err);
      await sendMessage(chatId, `❌ Error fetching status: ${err.message}`, null, null, logStep);
    }
    return;
  }

  // /members - founding member count
  if (command === '/members' || command === 'members') {
    try {
      const { data: subscriptions } = await supabaseFetch(
        `/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=id`
      );

      const count = subscriptions ? subscriptions.length : 0;
      const remaining = Math.max(0, 50 - count);

      const response = `👥 Founding Members

Active: ${count} / 50
Remaining: ${remaining} spots

Price: $29/mo (locked forever)`;

      await sendMessage(chatId, response, null, null, logStep);
      if (logStep) logStep({ step: 'members_response_sent' });
    } catch (err) {
      console.error('[telegram-webhook] members query failed:', err);
      await sendMessage(chatId, `❌ Error fetching members: ${err.message}`, null, null, logStep);
    }
    return;
  }

  // /health - cron job status
  if (command === '/health' || command === 'health') {
    try {
      // Check most recent posts to infer cron health
      const { data: recentPosts } = await supabaseFetch(
        `/rest/v1/social_posts?order=created_at.desc&limit=1&select=created_at`
      );

      const { data: recentPosted } = await supabaseFetch(
        `/rest/v1/social_posts?status=eq.posted&order=posted_at.desc&limit=1&select=posted_at`
      );

      const lastCreated = recentPosts?.[0]?.created_at;
      const lastPosted = recentPosted?.[0]?.posted_at;

      const now = new Date();
      const createdAgo = lastCreated ? Math.round((now - new Date(lastCreated)) / 1000 / 60) : null;
      const postedAgo = lastPosted ? Math.round((now - new Date(lastPosted)) / 1000 / 60) : null;

      const generateHealth = createdAgo !== null && createdAgo < 1440 ? '✅' : '⚠️'; // < 24h
      const publishHealth = postedAgo !== null && postedAgo < 60 ? '✅' : '⚠️'; // < 1h

      const response = `🏥 System Health

${generateHealth} Generate: ${createdAgo !== null ? `${createdAgo}m ago` : 'Never'}
${publishHealth} Publish: ${postedAgo !== null ? `${postedAgo}m ago` : 'Never'}

Cron schedule:
• Generate: daily 11AM UTC
• Approve: daily 11:30 UTC
• Publish: every 30 min`;

      await sendMessage(chatId, response, null, null, logStep);
      if (logStep) logStep({ step: 'health_response_sent' });
    } catch (err) {
      console.error('[telegram-webhook] health query failed:', err);
      await sendMessage(chatId, `❌ Error checking health: ${err.message}`, null, null, logStep);
    }
    return;
  }

  // /score <1-5> [optional note] — rate this session
  // Examples: /score 4   /score 5 great session today
  if (command.startsWith('/score') || command.startsWith('score')) {
    try {
      // Parse: /score 4 optional note here
      const raw = messageText.trim();
      const parts = raw.replace(/^\/score\s*/i, '').replace(/^score\s*/i, '').trim().split(/\s+/);
      const scoreNum = parseInt(parts[0], 10);
      const note = parts.slice(1).join(' ') || null;

      if (!scoreNum || scoreNum < 1 || scoreNum > 5) {
        await sendMessage(chatId, 'Usage: /score 1-5 [optional note]\nExample: /score 4 good session', null, null, logStep);
        return;
      }

      // Call feedback-score endpoint internally
      const scoreRes = await fetch(
        `${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://meetdossie.com'}/api/feedback-score`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.CRON_SECRET}`,
          },
          body: JSON.stringify({ score: scoreNum, note }),
        }
      );
      const scoreData = await scoreRes.json().catch(() => null);
      const avg = scoreData?.running_average;

      const stars = '★'.repeat(scoreNum) + '☆'.repeat(5 - scoreNum);
      const avgLine = avg !== null && avg !== undefined ? `\nRunning avg: ${avg}/5` : '';
      const noteLine = note ? `\nNote: ${note}` : '';
      const reply = `Session scored: ${stars} (${scoreNum}/5)${noteLine}${avgLine}`;

      await sendMessage(chatId, reply, null, null, logStep);
      if (logStep) logStep({ step: 'score_recorded', score: scoreNum, avg });
    } catch (err) {
      console.error('[telegram-webhook] /score handler failed:', err?.message);
      await sendMessage(chatId, `Error recording score: ${err?.message || 'unknown'}`, null, null, logStep);
    }
    return;
  }

  // Help / default response
  const helpText = `DossieMarketingBot commands:

/status — today's post counts
/members — founding member count
/health — cron job status
/score 1-5 [note] — rate this session

Also:
• Approve/Reject buttons on posts
• Reply to edit prompts to modify content`;

  await sendMessage(chatId, helpText, null, null, logStep);
  if (logStep) logStep({ step: 'help_response_sent' });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Debug mode - collect diagnostic info
  const debugMode = req.query.debug === '1';
  const debugInfo = { steps: [] };
  function logStep(step) {
    if (debugMode) debugInfo.steps.push({ ...step, timestamp: new Date().toISOString() });
    console.log('[telegram-webhook debug]', JSON.stringify(step));
  }

  // Validate the optional Telegram secret-token header. Non-blocking: if we
  // configured one and it doesn't match, log a warning but allow the request
  // through (still fingerprinted via chat_id checks later).
  if (TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers && (req.headers['x-telegram-bot-api-secret-token'] || req.headers['X-Telegram-Bot-Api-Secret-Token']);
    if (got !== TELEGRAM_WEBHOOK_SECRET) {
      console.warn('[telegram-webhook] secret token mismatch - expected:', TELEGRAM_WEBHOOK_SECRET?.slice(0, 8), 'got:', got?.slice(0, 8));
      // Non-blocking: continue processing the request
    }
  }

  // Non-fatal Supabase check: log a warning but allow webhook to process
  // messages even without Supabase (needed for Claudy to respond to general
  // messages; Supabase only required for approve/reject callback queries).
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[telegram-webhook] Supabase not configured - callback queries will fail');
  }
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(500).json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not configured' });
  }

  let update;
  try {
    update = await readRawBody(req);

    // LOG EVERY INCOMING UPDATE
    console.log('[telegram-webhook] === INCOMING UPDATE ===');
    console.log('[telegram-webhook] Update type:', Object.keys(update || {}).join(', '));
    if (update?.callback_query) {
      console.log('[telegram-webhook] Callback query:', update.callback_query.data);
    }
    if (update?.message) {
      console.log('[telegram-webhook] Message:', {
        text: update.message.text,
        chatId: update.message.chat?.id,
        from: update.message.from?.username
      });
    }

    logStep({
      action: 'body_parsed',
      hasCallbackQuery: !!update?.callback_query,
      hasMessage: !!update?.message,
      messageText: update?.message?.text,
      callbackData: update?.callback_query?.data
    });
  } catch (err) {
    console.error('[telegram-webhook] body parse failed:', err && err.message);
    logStep({ action: 'body_parse_failed', error: err.message });
    return res.status(200).json({ ok: true, ignored: 'parse error' });
  }

  try {
    if (update?.callback_query) {
      logStep({ action: 'handling_callback_query', data: update.callback_query.data });
      await handleCallbackQuery(update.callback_query, logStep);
    } else if (update?.message?.text) {
      logStep({ action: 'handling_text_message', text: update.message.text.substring(0, 50) });
      await handleTextMessage(update.message, logStep);
    } else {
      logStep({ action: 'no_handler', updateKeys: Object.keys(update || {}) });
    }
  } catch (err) {
    // Log but always return 200 — Telegram retries non-200s aggressively.
    console.error('[telegram-webhook] handler threw:', err && err.message, err.stack);
    logStep({ action: 'handler_error', error: err.message, stack: err.stack });
  }

  if (debugMode) {
    return res.status(200).json({ ok: true, debug: debugInfo });
  }
  return res.status(200).json({ ok: true });
};
