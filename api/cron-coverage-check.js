// Vercel Serverless Function: /api/cron-coverage-check
// Daily safety net: ensures at least 1 post is published (or queued to publish)
// per active platform by 8PM CST. Runs at 01:00 UTC (8PM CST).
//
// For each active platform (facebook, twitter, linkedin, instagram):
//   - Counts posts with status='posted' for today (UTC date).
//   - If 0 posted, generates a simple fallback post via Claude and inserts it
//     as status='approved' so cron-publish-approved picks it up next run.
//   - Instagram exception: fallback inserted as status='pending_card' (Zernio
//     rejects Instagram text-only posts; a card image is required).
//
// NOTE: The daily social digest (platform tally to Telegram) was previously
// duplicated here as sendDailyDigest(). That logic was consolidated into
// cron-social-digest.js (runs 12:05 UTC / 7AM CDT) and removed from this
// file on 2026-05-27 to eliminate the duplicate.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 1 * * * (01:00 UTC = 8PM CST)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

// Active platforms for coverage check. TikTok excluded — text-only posts are
// rejected by Zernio and the video pipeline handles TikTok separately.
const ACTIVE_PLATFORMS = ['facebook', 'twitter', 'linkedin', 'instagram'];

// Default persona for fallback posts.
const FALLBACK_PERSONA = 'brenda';

// Platform-specific algorithm rules — concise version for fallback generation.
const PLATFORM_RULES = {
  facebook: {
    length: '200-400 words. Story-shaped. Short paragraphs.',
    hook: 'Start with a relatable agent pain point or question.',
    hashtags: 'NONE. No hashtags on Facebook.',
    cta: 'End with a question to drive comments.',
  },
  twitter: {
    length: 'Under 280 characters total OR a thread of 3-5 tweets.',
    hook: 'Punchy opener under 8 words. Opinionated or contrarian.',
    hashtags: '2-3 hashtags at end: #txrealestate #realtorlife #trec',
    cta: 'End with a question or "RT if this helped."',
  },
  linkedin: {
    length: '600-1200 characters. Short paragraphs, heavy line breaks.',
    hook: 'First two lines visible before fold. Operational insight or specific number.',
    hashtags: '3-5 hashtags: #realestate #transactioncoordinator #texasrealestate #proptech #realtors',
    cta: 'End with a specific question inviting operators to share their own number or workflow.',
  },
  instagram: {
    length: '150-250 words.',
    hook: 'First line makes someone stop scrolling. Bold claim or question.',
    hashtags: '8-10 hashtags: #realestate #realtor #realtorlife #texasrealestate #texasrealtor #trec #transactioncoordinator #realtortools #closingday #sanantoniorealestate',
    cta: "Ask for a SAVE or SHARE.",
  },
};

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

// Returns the count of 'posted' rows for a given platform on today's UTC date.
async function countPostedToday(platform, todayDate) {
  // todayDate is a string like "2026-05-25"
  const encoded = encodeURIComponent(platform);
  const r = await supabaseFetch(
    `/rest/v1/social_posts?select=id&platform=eq.${encoded}&status=eq.posted&generated_at=gte.${encodeURIComponent(todayDate + 'T00:00:00.000Z')}&generated_at=lt.${encodeURIComponent(todayDate + 'T23:59:59.999Z')}`,
  );
  if (r.ok && Array.isArray(r.data)) return r.data.length;
  return 0; // fail safe: assume 0 so we attempt coverage
}

// Also check for posts that are already approved or publishing for today —
// they haven't been "posted" yet but will be soon. We don't want to
// double-generate in that case.
async function countInFlight(platform, todayDate) {
  const encoded = encodeURIComponent(platform);
  // Count rows that are approved, publishing, or queued for today
  const r = await supabaseFetch(
    `/rest/v1/social_posts?select=id&platform=eq.${encoded}&status=in.(approved,publishing,draft)&generated_at=gte.${encodeURIComponent(todayDate + 'T00:00:00.000Z')}&generated_at=lt.${encodeURIComponent(todayDate + 'T23:59:59.999Z')}`,
  );
  if (r.ok && Array.isArray(r.data)) return r.data.length;
  return 0;
}

function buildFallbackPrompt(platform) {
  const rules = PLATFORM_RULES[platform];
  return `Generate one fallback social media post for Dossie, an AI transaction coordinator for Texas real estate agents.

Platform: ${platform.toUpperCase()}
Persona: Brenda — burned-out solo agent, 6 years in, pays $8,000/year for TC work. Voice: tired, witty, blunt about industry pain. Wry, not whiny.

BRAND CONTEXT
- Founding-member pricing: $29/month, 50 spots (most taken).
- Sign-up URL: meetdossie.com/founding
- Voice: warm but blunt. Peer-to-peer, not marketer-to-prospect.
- No emoji spam. No "Game changer!" hooks. No "Stop scrolling!"

PLATFORM RULES (apply strictly):
- Length: ${rules.length}
- Hook: ${rules.hook}
- Hashtags: ${rules.hashtags}
- CTA: ${rules.cta}

PERSONA VOICE RULES (non-negotiable):
- Write in THIRD PERSON. NEVER first person "I".
- Write ABOUT Brenda, not AS Brenda.
- WRONG: "I closed 6 deals this month." RIGHT: "She closed 6 deals this month."
- Brenda = she/her.

CONTENT RULES:
- Pick ONE of these real Dossie capabilities: TREC deadline tracking, contract PDF scanning, Morning Brief (daily audio deal summary), pipeline dashboard with deal cards, or email draft queue.
- Frame numbers as hypothetical ("around $400 a file", "agents doing 50+ deals").
- Timeframes: Dossie launched recently. Never imply months or years of use.
- No em-dashes (--), curly quotes, or special Unicode. Plain hyphens and straight quotes only.

Return STRICT JSON only. No markdown fences. No commentary before or after.

{
  "caption": "<full post text including CTA and hashtags at end>",
  "hook": "<punchy opener, 5-8 words max>",
  "cta": "<the CTA line>",
  "stat": "<single bold anchor value, max 10 chars, e.g. '$29/mo' or '$8,000'>",
  "stat_label": "<plain descriptive phrase, max 50 chars>"
}`;
}

async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error('Anthropic returned non-JSON: ' + text.slice(0, 200));
  }
  const content = data?.content?.[0]?.text;
  if (!content) throw new Error('Anthropic returned no content block');
  return content;
}

function extractJson(raw) {
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

async function lookupZernioAccountId(platform) {
  const encoded = encodeURIComponent(platform);
  const { data } = await supabaseFetch(
    `/rest/v1/zernio_accounts?platform=eq.${encoded}&is_active=eq.true&select=zernio_account_id&limit=1`,
  );
  if (Array.isArray(data) && data.length > 0) return data[0].zernio_account_id || null;
  return null;
}

module.exports = async function handler(req, res) {
  // Auth: accept Vercel's built-in cron header OR manual Bearer token.
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
  // UTC date string "YYYY-MM-DD" used for all Supabase date comparisons.
  const todayDate = now.toISOString().slice(0, 10);

  console.log('[cron-coverage-check] starting — date:', todayDate);

  const results = [];

  for (const platform of ACTIVE_PLATFORMS) {
    const posted = await countPostedToday(platform, todayDate);

    if (posted > 0) {
      console.log(`[cron-coverage-check] ${platform}: ${posted} posted today — covered`);
      results.push({ platform, covered: true, posted, action: 'none' });
      continue;
    }

    // Check if something is already in flight (approved, publishing, draft)
    // that will cover this platform — no need to generate another fallback.
    const inFlight = await countInFlight(platform, todayDate);
    if (inFlight > 0) {
      console.log(`[cron-coverage-check] ${platform}: 0 posted but ${inFlight} in-flight — skipping fallback`);
      results.push({ platform, covered: false, posted: 0, in_flight: inFlight, action: 'skipped_in_flight' });
      continue;
    }

    console.log(`[cron-coverage-check] ${platform}: 0 posted, 0 in-flight — generating fallback`);

    let raw;
    try {
      raw = await callAnthropic(buildFallbackPrompt(platform));
    } catch (err) {
      console.error(`[cron-coverage-check] ${platform}: Anthropic call failed:`, err && err.message);
      results.push({ platform, covered: false, posted: 0, action: 'generation_failed', error: String(err && err.message || err).slice(0, 200) });
      continue;
    }

    let parsed;
    try {
      parsed = extractJson(raw);
    } catch (err) {
      console.error(`[cron-coverage-check] ${platform}: JSON parse failed. Raw head:`, String(raw).slice(0, 200));
      results.push({ platform, covered: false, posted: 0, action: 'parse_failed', error: String(err && err.message || err).slice(0, 200) });
      continue;
    }

    const caption = String(parsed?.caption || '').trim();
    const hook = String(parsed?.hook || '').trim();
    const cta = String(parsed?.cta || '').trim();
    const stat = String(parsed?.stat || '').trim();
    const stat_label = String(parsed?.stat_label || '').trim();

    if (!caption) {
      console.error(`[cron-coverage-check] ${platform}: generated post has no caption`);
      results.push({ platform, covered: false, posted: 0, action: 'empty_caption' });
      continue;
    }

    let zernioAccountId = null;
    try { zernioAccountId = await lookupZernioAccountId(platform); } catch (_e) { zernioAccountId = null; }

    // Instagram requires a card image — Zernio rejects text-only Instagram posts.
    // Insert as pending_card so it doesn't silently fail at publish time.
    // All other platforms go straight to approved for immediate pickup.
    const isInstagram = platform === 'instagram';
    const rowStatus = isInstagram ? 'pending_card' : 'approved';

    // Unique post_id — use a coverage suffix to distinguish from regular generated posts.
    const postId = `${todayDate}-${FALLBACK_PERSONA}-${platform}-coverage`;

    const row = {
      post_id: postId,
      platform,
      content: caption,
      hook: hook || caption.slice(0, 120),
      cta,
      stat,
      stat_label,
      hashtags: [],
      status: rowStatus,
      telegram_sent_at: null,
      zernio_account_id: zernioAccountId,
      persona: FALLBACK_PERSONA,
      topic: 'coverage_fallback',
      media_url: null,
      generated_at: now.toISOString(),
      created_at: now.toISOString(),
      error_message: isInstagram
        ? 'Coverage fallback: Instagram requires a card image. Row held as pending_card — render a card and flip to approved to publish.'
        : null,
    };

    // Upsert with on_conflict=post_id — safe to re-run if the cron fires twice.
    const ins = await supabaseFetch('/rest/v1/social_posts?on_conflict=post_id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(row),
    });

    if (ins.ok) {
      console.log(`[cron-coverage-check] ${platform}: fallback inserted as status='${rowStatus}' (post_id=${postId})`);
      results.push({ platform, covered: false, posted: 0, action: isInstagram ? 'fallback_pending_card' : 'fallback_approved', post_id: postId, status: rowStatus });
    } else {
      const errBody = typeof ins.data === 'string' ? ins.data.slice(0, 200) : JSON.stringify(ins.data).slice(0, 200);
      console.error(`[cron-coverage-check] ${platform}: insert failed status=${ins.status} body=${errBody}`);
      results.push({ platform, covered: false, posted: 0, action: 'insert_failed', http_status: ins.status, error: errBody });
    }
  }

  const covered = results.filter((r) => r.covered || r.action === 'fallback_approved' || r.action === 'skipped_in_flight').length;
  const fallbacksGenerated = results.filter((r) => r.action === 'fallback_approved' || r.action === 'fallback_pending_card').length;

  console.log(`[cron-coverage-check] done — ${covered}/${ACTIVE_PLATFORMS.length} platforms covered, ${fallbacksGenerated} fallback(s) generated`);

  return res.status(200).json({
    ok: true,
    date: todayDate,
    platforms_checked: ACTIVE_PLATFORMS.length,
    covered,
    fallbacks_generated: fallbacksGenerated,
    results,
  });
};
