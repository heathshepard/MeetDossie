// Vercel Serverless Function: /api/cron-generate-heath-content
// Generates video-first social content in Heath's authentic first-person voice
// for all active platforms (facebook, instagram, twitter, tiktok).
//
// All posts: video_required=true, persona='heath', silent text-overlay format.
// Bypasses Sage pipeline (sets telegram_sent_at immediately).
// Existing cron-render-videos.js renders the silent video next cycle.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 11 * * * (11:00 UTC daily, before render at 11:10)

require('./_lib/telegram-gate').install('cron-generate-heath-content');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const VERIFIER_MODEL = 'claude-haiku-4-5-20251001';

// ─── Platform configs ────────────────────────────────────────────────────────
const PLATFORMS = [
  {
    platform: 'facebook',
    style: 'Storytelling. 150-250 words. Short paragraphs (1-2 sentences). End with a question or observation that invites comments.',
  },
  {
    platform: 'instagram',
    style: 'Visual-first caption. 100-150 words. Hook in first line (the preview text). Short punchy paragraphs.',
  },
  {
    platform: 'twitter',
    style: 'Single punchy insight. Under 250 characters total. One tight thought.',
  },
  {
    platform: 'tiktok',
    style: 'Hook-first. 50-80 words. Pattern interrupt opening ("The real reason...", "Nobody talks about this...").',
  },
];

// ─── Topic rotation ──────────────────────────────────────────────────────────
const TOPICS = [
  {
    key: 'tc_cost',
    prompt: 'Write about the real cost of TC services ($350-$400/file) and how the math breaks down for busy agents. Use your experience as a TX REALTOR.',
  },
  {
    key: 'deadline_pain',
    prompt: 'Write about a TREC deadline horror story or near-miss. Option periods, earnest money, title objections — the moments that keep agents up at night.',
  },
  {
    key: 'founder_story',
    prompt: 'Write about why you built Dossie — your TC quit while you were in Italy, $400/file adds up, waking at 4:30am wondering about repair amendments.',
  },
  {
    key: 'trec_tip',
    prompt: 'Share a quick, useful TREC tip that most agents get wrong or forget — option period calculation, amendment deadlines, third-party financing contingency.',
  },
  {
    key: 'peer_insight',
    prompt: 'Share an observation about how agents actually manage their transactions vs how they think they do. The gap between "I have systems" and reality.',
  },
  {
    key: 'day_in_life',
    prompt: 'Write about the daily grind of managing multiple transactions — the context switching, the missed details, the 4:30am worry.',
  },
  {
    key: 'build_in_public',
    prompt: 'Share something real about building Dossie — a win, a setback, or a lesson from building tech for your own industry.',
  },
];

function pickTopic() {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const today = new Date();
  const dayOfYear = Math.floor((today - start) / 86400000);
  return TOPICS[dayOfYear % TOPICS.length];
}

// ─── System prompt ───────────────────────────────────────────────────────────
const HEATH_SYSTEM_PROMPT = `You are Heath Shepard, a licensed Texas REALTOR at Keller Williams in San Antonio who built Dossie — an AI transaction coordinator for TX agents. You write social media posts in your own voice.

VOICE RULES:
- First person always (I, me, my, we)
- Casual but professional — like texting a colleague who respects your opinion
- Short paragraphs (1-2 sentences each)
- No hashtags
- No emojis
- No corporate marketing language ("revolutionize", "game-changer", "innovative")
- Tell stories, not pitches
- End with a question or soft observation, not a hard CTA
- Never mention founding spots, specific pricing, or member counts
- You can mention meetdossie.com once, naturally, not as a hard sell

VERIFIED FACTS YOU CAN USE:
- You're a TX REALTOR at Keller Williams (City View / Boerne), San Antonio
- You've been through 3 transaction coordinators
- Your last TC quit while you were on vacation in Italy with active deals
- TC services cost $350-$400 per file
- You built Dossie to handle TREC deadlines, contract scanning, email drafting
- Dossie has real paying customers (don't say how many)
- You run Plane & Ember (cigar woodwork) on the side

NEVER FABRICATE:
- Specific dollar amounts not in the facts above
- Specific timestamps ("Tuesday at 9:43pm")
- Named customers or their quotes
- Features that don't exist yet`;

// ─── Verifier ────────────────────────────────────────────────────────────────
const VERIFIER_SYSTEM_PROMPT = `You are the Heath Content Verifier. Check a social media post against verified facts and flag fabrications.

VERIFIED FACTS:
- Licensed TX REALTOR at Keller Williams (City View / Boerne), San Antonio
- Been through 3 transaction coordinators
- Last TC quit while he was on vacation in Italy with active deals
- TC services cost $350-$400 per file
- Built Dossie — AI transaction coordinator for TX agents
- Dossie has real paying customers (no specific count)
- Runs Plane & Ember (cigar woodwork) on the side
- Shipped features: TREC deadline auto-calc, contract PDF scanning, email draft queue, morning brief, closing milestone cards, pipeline view, Talk-to-Dossie chat

FLAG AS RED: specific dollar amounts not verified, invented timestamps, named customers, unshipped features, member counts.
FLAG AS YELLOW: claims that could be true but unverified.

Output ONLY JSON (no fences):
{"verdict":"approve"|"needs_revision","flags":[{"severity":"red"|"yellow","claim":"...","issue":"...","fix":"..."}],"summary":"one sentence"}

verdict "approve" only when zero red flags and at most one yellow.`;

// ─── Helpers ─────────────────────────────────────────────────────────────────
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

async function callAnthropic(model, systemPrompt, userMessage, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Anthropic non-JSON: ' + text.slice(0, 200)); }
  const content = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  if (!content) throw new Error('Anthropic returned no content');
  return content;
}

function extractJson(raw) {
  let s = String(raw || '').trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) s = s.slice(firstBrace, lastBrace + 1);
  return JSON.parse(s);
}

async function sendToTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.warn('[cron-generate-heath-content] telegram failed:', err.message);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = withTelemetry('cron-generate-heath-content', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const topic = pickTopic();
  console.log(`[cron-generate-heath-content] ${dateStr} topic: ${topic.key}`);

  let generated = 0;
  let rejected = 0;
  let skipped = 0;
  const results = [];

  for (const { platform, style } of PLATFORMS) {
    const postId = `heath-${platform}-${dateStr}`;

    // Idempotency
    const existing = await supabaseFetch(
      `/rest/v1/social_posts?post_id=eq.${encodeURIComponent(postId)}&select=id&limit=1`,
    );
    if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
      console.log(`[cron-generate-heath-content] ${postId} exists, skipping`);
      skipped++;
      continue;
    }

    // Generate platform-specific content
    const userMessage = `${topic.prompt}

Platform: ${platform}
Style: ${style}

Return ONLY the post text. No JSON, no markdown fences, no commentary.`;

    let postContent;
    try {
      postContent = await callAnthropic(ANTHROPIC_MODEL, HEATH_SYSTEM_PROMPT, userMessage, 1024);
    } catch (err) {
      console.error(`[cron-generate-heath-content] generation failed for ${platform}:`, err.message);
      results.push({ platform, ok: false, error: 'generation failed' });
      continue;
    }

    if (!postContent || postContent.length < 20) {
      console.error(`[cron-generate-heath-content] content too short for ${platform}:`, postContent?.length);
      results.push({ platform, ok: false, error: 'too short' });
      continue;
    }

    // Verify against facts
    let verifierResult;
    try {
      const raw = await callAnthropic(
        VERIFIER_MODEL,
        VERIFIER_SYSTEM_PROMPT,
        `Verify this ${platform} post:\n\n${postContent}`,
        400,
      );
      verifierResult = extractJson(raw);
    } catch {
      verifierResult = {
        verdict: 'needs_revision',
        flags: [{ severity: 'red', claim: '(verifier error)', issue: 'call failed', fix: 'review manually' }],
        summary: 'Verifier call failed.',
      };
    }

    const hasRed = Array.isArray(verifierResult.flags) &&
      verifierResult.flags.some((f) => String(f?.severity || '').toLowerCase() === 'red');
    const verdict = hasRed ? 'needs_revision' : (verifierResult.verdict === 'approve' ? 'approve' : 'needs_revision');
    const rowStatus = verdict === 'needs_revision' ? 'rejected' : 'draft';

    const rejectionReason = rowStatus === 'rejected'
      ? `VERIFIER: ${verifierResult.summary || 'needs_revision'}`.slice(0, 500)
      : null;

    console.log(`[cron-generate-heath-content] ${platform}: verifier=${verdict} status=${rowStatus}`);

    // Insert into social_posts
    const row = {
      post_id: postId,
      platform,
      persona: 'heath',
      content: postContent,
      content_hash: require('crypto').createHash('md5').update(postContent).digest('hex'),
      hook: postContent.split('\n')[0].slice(0, 120),
      status: rowStatus,
      topic: topic.key,
      video_required: true,
      generated_at: now.toISOString(),
      created_at: now.toISOString(),
      verifier_result: verifierResult,
      error_message: rejectionReason,
    };

    const ins = await supabaseFetch('/rest/v1/social_posts?on_conflict=post_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(row),
    });

    if (!ins.ok) {
      console.error(`[cron-generate-heath-content] insert failed for ${platform}:`, ins.status);
      results.push({ platform, ok: false, error: 'insert failed' });
      continue;
    }

    const dbId = Array.isArray(ins.data) && ins.data[0] ? ins.data[0].id : null;

    // Set telegram_sent_at to bypass Sage pipeline + start veto window
    if (rowStatus === 'draft' && dbId) {
      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(dbId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ telegram_sent_at: now.toISOString() }),
      });
      generated++;
    } else {
      rejected++;
    }

    results.push({ platform, ok: true, status: rowStatus, post_id: postId });
  }

  // Telegram batch summary
  if (generated > 0 || rejected > 0) {
    const lines = [
      `<b>Heath Content Generated</b>`,
      `Topic: ${topic.key}`,
      `Draft: ${generated} | Rejected: ${rejected} | Skipped: ${skipped}`,
      generated > 0 ? 'Videos render at 11:10 UTC. Auto-approves in 10 min.' : null,
    ].filter(Boolean);
    await sendToTelegram(lines.join('\n'));
  }

  console.log(`[cron-generate-heath-content] done — generated=${generated} rejected=${rejected} skipped=${skipped}`);

  return res.status(200).json({
    ok: true,
    generated,
    rejected,
    skipped,
    topic: topic.key,
    results,
  });
});
