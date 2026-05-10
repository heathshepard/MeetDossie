// Vercel Serverless Function: /api/cron-generate-posts
// Daily content generator for Dossie's marketing pipeline.
//   - Generates 6 social posts per day via Claude Sonnet:
//     2 per persona (Brenda, Patricia, Victor),
//     mix of long-form + short-form platforms,
//     rotating topic chosen by day-of-year.
//   - Inserts each post into social_posts as status='draft'.
//   - Wraps the run in a content_batches row for tracking.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 11 * * * (11:00 UTC daily, ~6am Central during DST).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

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

const PERSONAS = {
  brenda: {
    name: 'Brenda',
    summary: 'Burned-out solo agent, 6 years in, pays her transaction coordinator $8,000/year. Voice: tired, witty, blunt about industry pain. Not whiny — wry. Talks like she\'s telling a friend over coffee at 9pm after the kids are in bed.',
  },
  patricia: {
    name: 'Patricia',
    summary: 'Part-time agent, 8-12 deals/year, also has a day job. Voice: practical, budget-conscious, no fluff. Skeptical of anything that sounds like a sales pitch. Cares about whether something pays for itself in 2 deals or fewer.',
  },
  victor: {
    name: 'Victor',
    summary: 'Top producer, 50+ deals/year, runs a small team. Voice: confident, math-driven, ambitious. Talks in margins and capacity. Not cocky — operational. Sees TC cost as a fixed leak and is always looking for the unlock.',
  },
};

const TOPICS = [
  {
    key: 'cost_math',
    label: 'The cost math (current TC cost vs Dossie at $29/mo)',
    angle: 'Compare what an agent currently spends on TC services to Dossie\'s $29/mo founding-member price. Use real numbers. Avoid generic "save money!" framing — show the actual delta.',
  },
  {
    key: 'pain_points',
    label: 'Pain points: missed deadlines, ghosted TCs, weekend stress',
    angle: 'Concrete pain stories. Sunday night option period scramble. TC unreachable Friday afternoon. The 9pm contract review. Make it specific to Texas real estate.',
  },
  {
    key: 'day_in_the_life',
    label: 'Day-in-the-life moments where Dossie quietly handles things',
    angle: 'Small wins. Contract scanned in 8 seconds. Morning Brief at 6am. Follow-up email the agent forgot to send. A moment of "oh, that\'s already done."',
  },
  {
    key: 'capability_oneliners',
    label: 'Product capability one-liners',
    angle: 'Punchy single capability statements. "Your contract scanned in 8 seconds." "Every deadline tracked. Every party followed up." "She works nights, weekends, holidays."',
  },
  {
    key: 'control_freak_agent',
    label: 'Control + visibility — for agents who don\'t trust delegating',
    angle: 'Speak directly to the agent who refuses to hire a TC because they can\'t trust someone else to do it right. Reframe Dossie as visibility and control, NOT delegation. Lean into "you don\'t have to trust someone else — Dossie shows you everything", "control freaks make the best Dossie users", "you\'re not giving up control, you\'re finally getting it." Specifics: every deadline visible at a glance, every email drafted but not sent without you tapping send, every TREC paragraph cited so you can verify the math yourself. Avoid "let go" / "trust the process" framing — that\'s exactly what this audience refuses.',
  },
];

// Per-platform algorithm rules. Injected into the generation prompt for every
// post so the model knows the distribution mechanics, not just the surface
// stylistic notes. These reflect how each platform's algorithm actually
// distributes content (hook attention, length sweet spot, format, CTA signal,
// hashtag weight). Treat them as hard constraints during generation.
const PLATFORM_RULES = {
  tiktok: {
    hook_rule: "First sentence must be under 8 words and create immediate curiosity or tension. Never start with 'I' — start with a question, a number, or a provocative statement.",
    length_rule: "Keep total post under 150 words. Shorter = higher completion rate = more reach.",
    format_rule: "Use line breaks after every 1-2 sentences. No paragraphs. Mobile reading pattern.",
    cta_rule: "End with a single clear action: 'Link in bio' or 'Comment YES if this is you'",
    timing: "Best performing: 6-9AM or 7-9PM CST",
    hashtags: "REQUIRED: 2-3 hashtags at end. Use: #txrealestate #realtorlife #trec",
  },
  instagram: {
    hook_rule: "First line must make someone stop scrolling. Ask a question or make a bold claim. Gets cut off at ~125 chars so front-load the value.",
    length_rule: "150-300 words ideal. Long enough to be useful, short enough to read.",
    format_rule: "Line breaks between every thought. Use emojis sparingly — 1-2 max, relevant only.",
    cta_rule: "Ask for a SAVE ('save this for your next transaction') or SHARE ('send this to an agent who needs it'). Saves and shares beat likes for reach.",
    timing: "Best performing: 8-11AM or 6-8PM CST",
    hashtags: "REQUIRED: 8-10 hashtags at end. Mix high-volume (#realestate #realtor #realtorlife), Texas-specific (#texasrealestate #texasrealtor #trec #sanantoniorealestate), and niche (#transactioncoordinator #realtortools #closingday)",
  },
  facebook: {
    hook_rule: "Start with a relatable pain point or a question agents are already thinking. Facebook audience skews older — be direct, not trendy.",
    length_rule: "Facebook rewards long-form. 200-500 words performs better than short posts. Tell a story.",
    format_rule: "Short paragraphs, 2-3 sentences max. White space is your friend. No bullet points — Facebook reads like a conversation.",
    cta_rule: "Ask a direct question at the end to drive comments. Comments are the strongest signal. 'How many of you are still doing this manually?' works.",
    timing: "Best performing: Tuesday-Thursday 9AM-1PM CST",
    hashtags: "NONE. Facebook hashtags add no value. Do not include any hashtags in Facebook posts.",
  },
  twitter: {
    hook_rule: "Under 280 chars for the opener. Punchy, opinionated, or contrarian. Takes get pushed. Safe content dies.",
    length_rule: "Either under 280 chars (single tweet) or a thread of 5-8 tweets. Nothing in between.",
    format_rule: "For threads: each tweet must stand alone AND connect to the next. Number them (1/ 2/ etc).",
    cta_rule: "End threads with 'RT if this helped' or a question. Quote tweets and replies are the strongest signals.",
    timing: "Best performing: 8-10AM or 12-1PM CST weekdays",
    hashtags: "REQUIRED: 2-3 hashtags at end. Use: #txrealestate #realtorlife #trec",
  },
  linkedin: {
    hook_rule: "First two lines are visible before the 'see more' fold — front-load the value with a specific operational insight, a contrarian take, or a number. No clickbait, no 'You won't believe...' Sound like a peer talking shop, not a marketer.",
    length_rule: "1300-2000 chars. LinkedIn rewards story-shaped, single-thread posts in this range with the strongest dwell signal. Shorter posts under 600 chars also work for sharp one-line takes.",
    format_rule: "Short paragraphs, 1-3 sentences each. Heavy line-breaks for white space. Skimmable structure beats prose blocks. Lists OK if they're load-bearing, not ornamental.",
    cta_rule: "End with a specific question that invites operators to reply with their own number or workflow ('What does your TC actually cost per file when you add the chase time?'). Comments dwarf likes for reach. Avoid 'Thoughts?' — too generic.",
    timing: "Best performing: Tuesday-Thursday 7-10AM CST. Friday morning also lands well for ops-minded audiences.",
    hashtags: "REQUIRED: 3-5 hashtags at end. Use: #realestate #transactioncoordinator #texasrealestate #proptech #realtors",
  },
};

// Connected zernio_accounts as of 2026-05-07: facebook, instagram, twitter,
// tiktok (gated locally), linkedin.
//
// Length rules live in PLATFORM_RULES (single source of truth). Per-post
// notes only carry persona-flavor guidance, not length conflicts.
//
// Day-of-week routing: Friday is LinkedIn-day for Victor. The top-producer /
// math-driven voice lands hardest on a B2B audience that's reading Friday
// morning summaries; brenda + patricia still cover Facebook the rest of the
// day. Other days keep Victor on Facebook.
const POST_PLAN_BASE = [
  { persona: 'brenda',   platform: 'facebook',  notes: 'Story-shaped. Emotional honesty.' },
  { persona: 'brenda',   platform: 'twitter',   notes: 'One punchline. Tired-but-witty voice.' },
  { persona: 'patricia', platform: 'facebook',  notes: 'Conversational. Real-numbers focus.' },
  { persona: 'patricia', platform: 'instagram', notes: 'Plainspoken. Skeptical-of-marketers tone.' },
  { persona: 'victor',   platform: 'facebook',  notes: 'Operational/strategic framing.' },
  { persona: 'victor',   platform: 'tiktok',    notes: 'Confident, not cocky. Math-driven.' },
];

function getPostPlan(date = new Date(), opts = {}) {
  // forceDay (0–6, 0=Sun) lets a CRON_SECRET-gated test run pretend it's a
  // different weekday so we can exercise the day-of-week LinkedIn swap on
  // demand. Falls back to the real UTC weekday.
  const dayOfWeek = (typeof opts.forceDay === 'number' && opts.forceDay >= 0 && opts.forceDay <= 6)
    ? opts.forceDay
    : date.getUTCDay();
  const isFriday = dayOfWeek === 5;
  if (!isFriday) return POST_PLAN_BASE;
  return POST_PLAN_BASE.map((p) => (
    p.persona === 'victor' && p.platform === 'facebook'
      ? { persona: 'victor', platform: 'linkedin', notes: 'Operational, peer-to-peer. LinkedIn audience: brokers + top producers. Open with a specific operational insight or number; close with a question that invites them to share their own.' }
      : p
  ));
}

function parseForceDay(req) {
  let raw = null;
  try {
    if (req && req.query && req.query.force_day) raw = String(req.query.force_day);
    else if (req && typeof req.url === 'string') {
      raw = new URL(req.url, 'https://x').searchParams.get('force_day');
    }
  } catch (_e) { raw = null; }
  if (!raw) return null;
  const m = String(raw).toLowerCase();
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  if (m in map) return map[m];
  const n = parseInt(m, 10);
  return (Number.isInteger(n) && n >= 0 && n <= 6) ? n : null;
}

function pickTopic() {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const today = new Date();
  const dayOfYear = Math.floor((today - start) / 86400000);
  return TOPICS[dayOfYear % TOPICS.length];
}

function buildPlatformRulesBlock(platform) {
  const r = PLATFORM_RULES[platform];
  if (!r) return '';
  return [
    `   ALGORITHM RULES FOR ${platform.toUpperCase()} — apply strictly:`,
    `   - Hook: ${r.hook_rule}`,
    `   - Length: ${r.length_rule}`,
    `   - Format: ${r.format_rule}`,
    `   - CTA: ${r.cta_rule}`,
    `   - Hashtags: ${r.hashtags}`,
  ].join('\n');
}

function buildPrompt(topic, plan) {
  const planLines = plan.map((p, i) => {
    const persona = PERSONAS[p.persona];
    return `${i + 1}. Persona: ${persona.name} (${p.persona}) — ${persona.summary}
   Platform: ${p.platform}
   ${p.notes}
${buildPlatformRulesBlock(p.platform)}`;
  }).join('\n\n');

  return `Generate 6 social media posts for Dossie. Topic for today: ${topic.label}.

Topic angle:
${topic.angle}

BRAND CONTEXT
- Dossie is an AI transaction coordinator for Texas real estate agents.
- Founding-member pricing is $29/month, locked while subscription stays active.
- Sign up: meetdossie.com/founding
- Voice: warm but blunt. Peer-to-peer, not marketer-to-prospect. No hashtag-stuffing. No "🔥💯🚀" emoji-spam. No "Game changer!" or "Stop scrolling!" hooks.

NUMBERS & CLAIMS
- Any number used in a post (deals/year, $/file, etc.) is fictional and MUST be framed as a hypothetical or example. Use phrasing like "agents doing 50+ deals a year", "if you're paying around $400 a file", "say you do 10-12 deals a year".
- Do NOT present specific numbers as if they're real stats about the agent or about Dossie's user base. Never write "54 deals" as if reporting fact — write "50+ deals a year" or "an agent doing 50 a year" instead.
- No claims about user counts, subscriber counts, or comparative metrics ("X% faster", "$Y saved last year") — Dossie is brand new and those numbers don't exist yet.
- The $29/month founding price IS real — that one specific number is fine to state directly.

TIMEFRAMES & DOSSIE-USAGE DURATION
- Dossie launched recently. When a persona references how long they've been using Dossie, use "recently" or "over the last few weeks" — NEVER "a few months ago", "for the past year", "since last summer", or any phrasing that implies they've used Dossie for longer than a few weeks.
- Past-tense scenarios about life BEFORE Dossie are fine and can be specific ("Last year I forgot two lender intros"). The constraint is only on phrasing that puts Dossie in the persona's life on a months/years timescale.
- "I built Dossie", "Now Dossie does X" are fine. "Now I get a brief every morning" is fine if it could plausibly have started this week. "Two years ago I was burned out, today Dossie runs my files" is NOT fine — implies a multi-year usage history.

ALGORITHM OPTIMIZATION
You are generating content optimized for each platform's algorithm performance. The rules under each post in the plan below are not suggestions — they describe how that platform actually distributes content. Breaking these rules means the post gets shown to fewer people. Apply them strictly per post. The goal is maximum organic reach.

POST PLAN (6 posts):

${planLines}

OUTPUT FORMAT
Return STRICT JSON only. No markdown fences. No commentary before or after. Format:

{
  "posts": [
    {
      "persona": "brenda" | "patricia" | "victor",
      "platform": "linkedin" | "facebook" | "instagram" | "tiktok" | "twitter",
      "content": "<the full post text for social media — BUT the first 150 characters will be rendered on an image card, so write the opening 2-3 sentences to work standalone. No long-form storytelling. Punchy, tight, card-readable copy first, then expand if needed for the full post.>",
      "hook": "<punchy, pattern-interrupting opening — 5-8 words MAXIMUM. Examples: 'Your TC just quit. Now what?', '80 transactions. Zero TC.', 'She closed 6 deals this month.' Start with a question, number, or provocative statement — never generic 'Real talk' openers.>",
      "cta": "<the CTA line — should naturally include meetdossie.com/founding or 'founding member spots open' or similar>",
      "hashtags": ["hashtag1", "hashtag2", "hashtag3"],
      "stat": "<bold anchor — single value, max 10 characters. Examples: '$29/mo', '80+', '$8,000', '9:47pm'. Pulled directly from the post — no new claims. This is the headline of an image card, must read at a glance.>",
      "stat_label": "<plain descriptive phrase, max 50 characters. Examples: 'per year for a solo TC', 'deals this month', 'what the stress costs'>"
    }
  ]
}

Rules:
- Exactly 6 posts, in the order listed in the plan above.
- HASHTAGS: Must be appended to the END of the "content" field (not just in the array):
  * Instagram: 8-10 hashtags separated by spaces
  * Twitter: 2-3 hashtags separated by spaces
  * LinkedIn: 3-5 hashtags separated by spaces
  * Facebook: NO hashtags (leave content without hashtags)
  * TikTok: 2-3 hashtags separated by spaces
- "hashtags" array must match what's in content (no leading "#", no spaces in array entries).
- "stat" and "stat_label" are required for every post. Pull the stat from
  something the post actually says — never invent a new number. The card
  renderer uses these as the visual anchor, so they must read clean.
- CARD COPY: The first 150-200 characters of "content" will be rendered on an
  image card alongside the stat, stat_label, and hook. Write the opening as
  2-3 punchy sentences that work standalone on the card. No long-form
  storytelling in the opening — save that for later in the post if needed.
- TEXT ENCODING: Never use em-dashes (—), en-dashes (–), curly quotes (" " ' '),
  or special Unicode characters. Use only plain hyphens (-) and straight quotes (' ").
  Card renderer requires ASCII-compatible text.
- The CTA must appear inside the "content" field naturally — don't tack it on.
- Vary the openings. Don't start every post with "Real talk" or "Honest take."
- Don't reuse the exact same numbers across posts (different agents, different math).`;
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
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Anthropic returned non-JSON: ' + text.slice(0, 200));
  }
  const content = data?.content?.[0]?.text;
  if (!content) throw new Error('Anthropic returned no content block');
  return content;
}

function extractJson(raw) {
  // Be lenient — strip markdown fences if present, find the first {…} block.
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

// ─── Card renderer (Option B) ────────────────────────────────────────────
// For Instagram and Facebook posts, generate a branded image card at the
// same time we insert the row. The PNG lands in Supabase Storage's
// `social-cards` bucket and the public URL goes into social_posts.media_url.
// cron-publish-approved.js then attaches it as mediaItems[0] when posting
// to Zernio — no separate render step needed at publish time.
//
// /api/generate-card is a Node.js endpoint that spawns scripts/render-card.py
// as a child process. Replaces the broken Python serverless approach.
const CARD_PLATFORMS = new Set(['instagram', 'facebook']);

async function renderSocialCard({ platform, hook, content, persona, post_id, stat, stat_label }) {
  // ALWAYS use the public production alias. Going through VERCEL_URL hits the
  // per-deployment URL, which is gated by Vercel's deployment-protection auth
  // page (returns 401 HTML, not JSON) — that's exactly what was silently
  // dropping every Instagram + Facebook card render. The published alias has
  // no protection.
  const host = 'https://meetdossie.com';
  const url = `${host}/api/generate-card`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ platform, hook, content, persona, post_id, stat, stat_label }),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok || !data?.publicUrl) {
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  }
  return { ok: true, publicUrl: data.publicUrl, size_bytes: data.size_bytes };
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
  if (!CRON_SECRET) {
    console.error('[cron-generate-posts] CRON_SECRET not configured — refusing to run.');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const now = new Date();
  const topic = pickTopic();
  const forceDay = parseForceDay(req);
  const plan = getPostPlan(now, { forceDay });
  console.log('[cron-generate-posts] starting batch — topic:', topic.key, 'platforms:', plan.map((p) => p.platform).join(','), 'force_day:', forceDay, 'at', now.toISOString());

  let raw;
  try {
    raw = await callAnthropic(buildPrompt(topic, plan));
  } catch (err) {
    console.error('[cron-generate-posts] Anthropic call failed:', err && err.message);
    return res.status(502).json({ ok: false, error: 'content generation failed', detail: err && err.message });
  }

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    console.error('[cron-generate-posts] failed to parse JSON. Raw head:', String(raw).slice(0, 400));
    return res.status(502).json({ ok: false, error: 'Anthropic response was not valid JSON' });
  }

  const generated = Array.isArray(parsed?.posts) ? parsed.posts : [];
  if (generated.length === 0) {
    console.error('[cron-generate-posts] no posts returned. Parsed:', JSON.stringify(parsed).slice(0, 400));
    return res.status(502).json({ ok: false, error: 'no posts returned' });
  }

  // Dry-run path: return the generated posts without inserting into the DB.
  // Used to preview output of new prompt/rules without polluting the queue.
  const reqUrl = new URL(req.url, 'https://meetdossie.com');
  if (reqUrl.searchParams.get('dry_run') === '1') {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      topic: topic.key,
      generated_count: generated.length,
      posts: generated,
    });
  }

  // Create batch row first so each post can reference it (informational only —
  // social_posts has no batch_id column today; we still record the totals).
  const batchPayload = {
    batch_name: `${now.toISOString().slice(0, 10)} — ${topic.key}`,
    total_posts: 0,
    approved_posts: 0,
    rejected_posts: 0,
    notes: `Auto-generated. Topic: ${topic.label}`,
    generated_at: now.toISOString(),
  };
  const batchInsert = await supabaseFetch('/rest/v1/content_batches', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(batchPayload),
  });
  const batchRow = Array.isArray(batchInsert.data) ? batchInsert.data[0] : batchInsert.data;
  const batchId = batchRow?.id || null;

  let inserted = 0;
  const insertErrors = [];
  const renderSummary = []; // diagnostic: per-eligible-post render outcome
  for (let i = 0; i < generated.length; i++) {
    const p = generated[i];
    if (!p || typeof p !== 'object') continue;
    const persona = String(p.persona || '').toLowerCase();
    const platform = String(p.platform || '').toLowerCase();
    const content = String(p.content || '').trim();
    const hook = String(p.hook || '').trim();
    const cta = String(p.cta || '').trim();
    const stat = String(p.stat || '').trim();
    const stat_label = String(p.stat_label || '').trim();
    const hashtags = Array.isArray(p.hashtags) ? p.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean) : [];
    if (!content || !platform || !persona) {
      insertErrors.push({ index: i, error: 'missing required field', got: { persona, platform, content_length: content.length } });
      continue;
    }

    let zernioAccountId = null;
    try { zernioAccountId = await lookupZernioAccountId(platform); } catch (_e) { zernioAccountId = null; }

    // When force_day is set we may run multiple test batches in a single day;
    // add a short epoch-second suffix so post_ids don't collide with the real
    // morning batch (which has no suffix).
    const testSuffix = forceDay !== null ? `-test${Math.floor(Date.now() / 1000) % 100000}` : '';
    const postId = `${now.toISOString().slice(0, 10)}-${persona}-${platform}-${i}${testSuffix}`;

    // Render branded card for Instagram + Facebook. Failure is non-fatal —
    // the row still inserts with media_url=null and cron-publish-approved
    // posts a text-only update.
    let mediaUrl = null;
    if (CARD_PLATFORMS.has(platform)) {
      // Debug logging: capture AI-generated card fields
      console.log(`[AI] ${postId} stat="${stat}" stat_label="${stat_label}" hook="${hook}" content_preview="${content.slice(0, 100)}..."`);

      const renderStart = Date.now();
      const card = await renderSocialCard({
        platform,
        hook: hook || content.slice(0, 120),
        content,
        persona,
        post_id: postId,
        stat,
        stat_label,
      });
      const renderMs = Date.now() - renderStart;
      if (card.ok) {
        mediaUrl = card.publicUrl;
        console.log(`[card] ${postId} -> ${card.publicUrl} (${card.size_bytes} bytes, ${renderMs}ms)`);
        renderSummary.push({ post_id: postId, platform, ok: true, ms: renderMs, size_bytes: card.size_bytes, public_url: card.publicUrl });
      } else {
        console.warn(`[card] ${postId} render failed status=${card.status} err=${String(card.error || '').slice(0, 200)} after ${renderMs}ms`);
        renderSummary.push({ post_id: postId, platform, ok: false, ms: renderMs, status: card.status, error: String(card.error || '').slice(0, 200) });
      }
    }

    const row = {
      post_id: postId,
      platform,
      content,
      content_hash: require('crypto').createHash('md5').update(content).digest('hex'),
      hook: hook || content.slice(0, 120),
      cta,
      hashtags,
      status: 'draft',
      zernio_account_id: zernioAccountId,
      persona,
      topic: topic.key,
      media_url: mediaUrl,
      generated_at: now.toISOString(),
      created_at: now.toISOString(),
    };

    const ins = await supabaseFetch('/rest/v1/social_posts', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    if (ins.ok) inserted++;
    else insertErrors.push({ index: i, status: ins.status, body: typeof ins.data === 'string' ? ins.data.slice(0, 200) : JSON.stringify(ins.data).slice(0, 200) });
  }

  // Update batch totals.
  if (batchId) {
    await supabaseFetch(`/rest/v1/content_batches?id=eq.${encodeURIComponent(batchId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ total_posts: inserted }),
    });
  }

  console.log('[cron-generate-posts] done — inserted', inserted, 'of', generated.length, 'errors:', insertErrors.length, 'renders:', renderSummary.filter(r => r.ok).length, '/', renderSummary.length);
  return res.status(200).json({
    ok: true,
    generated: generated.length,
    inserted,
    batch_id: batchId,
    topic: topic.key,
    force_day: forceDay,
    errors: insertErrors,
    render_summary: renderSummary,
  });
};
