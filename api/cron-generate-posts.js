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
    hashtags: "3-5 hashtags maximum. Use #texasrealtor #realestatetips and 1-2 niche ones.",
  },
  instagram: {
    hook_rule: "First line must make someone stop scrolling. Ask a question or make a bold claim. Gets cut off at ~125 chars so front-load the value.",
    length_rule: "150-300 words ideal. Long enough to be useful, short enough to read.",
    format_rule: "Line breaks between every thought. Use emojis sparingly — 1-2 max, relevant only.",
    cta_rule: "Ask for a SAVE ('save this for your next transaction') or SHARE ('send this to an agent who needs it'). Saves and shares beat likes for reach.",
    timing: "Best performing: 8-11AM or 6-8PM CST",
    hashtags: "5-10 hashtags. Mix broad (#realtor) and niche (#texasrealtor #trec) and product (#dossieai)",
  },
  facebook: {
    hook_rule: "Start with a relatable pain point or a question agents are already thinking. Facebook audience skews older — be direct, not trendy.",
    length_rule: "Facebook rewards long-form. 200-500 words performs better than short posts. Tell a story.",
    format_rule: "Short paragraphs, 2-3 sentences max. White space is your friend. No bullet points — Facebook reads like a conversation.",
    cta_rule: "Ask a direct question at the end to drive comments. Comments are the strongest signal. 'How many of you are still doing this manually?' works.",
    timing: "Best performing: Tuesday-Thursday 9AM-1PM CST",
    hashtags: "2-3 hashtags only. Facebook hashtags barely matter.",
  },
  twitter: {
    hook_rule: "Under 280 chars for the opener. Punchy, opinionated, or contrarian. Takes get pushed. Safe content dies.",
    length_rule: "Either under 280 chars (single tweet) or a thread of 5-8 tweets. Nothing in between.",
    format_rule: "For threads: each tweet must stand alone AND connect to the next. Number them (1/ 2/ etc).",
    cta_rule: "End threads with 'RT if this helped' or a question. Quote tweets and replies are the strongest signals.",
    timing: "Best performing: 8-10AM or 12-1PM CST weekdays",
    hashtags: "1-2 max or none. Twitter hashtags hurt more than help for most content.",
  },
};

// Connected zernio_accounts as of 2026-05-04: facebook, instagram, tiktok, twitter.
// LinkedIn intentionally not in this plan — without a connected zernio_account
// row those posts can never publish, so we don't generate them.
//
// Length rules now live in PLATFORM_RULES (single source of truth). Per-post
// notes only carry persona-flavor guidance, not length conflicts.
const POST_PLAN = [
  { persona: 'brenda',   platform: 'facebook',  notes: 'Story-shaped. Emotional honesty.' },
  { persona: 'brenda',   platform: 'twitter',   notes: 'One punchline. Tired-but-witty voice.' },
  { persona: 'patricia', platform: 'facebook',  notes: 'Conversational. Real-numbers focus.' },
  { persona: 'patricia', platform: 'instagram', notes: 'Plainspoken. Skeptical-of-marketers tone.' },
  { persona: 'victor',   platform: 'facebook',  notes: 'Operational/strategic framing.' },
  { persona: 'victor',   platform: 'tiktok',    notes: 'Confident, not cocky. Math-driven.' },
];

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

function buildPrompt(topic) {
  const planLines = POST_PLAN.map((p, i) => {
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
      "content": "<the full post text>",
      "hook": "<first 1-2 lines from the post, max 120 chars>",
      "cta": "<the CTA line — should naturally include meetdossie.com/founding or 'founding member spots open' or similar>",
      "hashtags": ["hashtag1", "hashtag2", "hashtag3"]
    }
  ]
}

Rules:
- Exactly 6 posts, in the order listed in the plan above.
- "hashtags" array must have 3-5 entries, no leading "#", no spaces.
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
// /api/render-card lives in the same Vercel deployment (Python serverless
// function with @vercel/python). Same domain → in-region call, low latency.
const CARD_PLATFORMS = new Set(['instagram', 'facebook']);

async function renderSocialCard({ platform, hook, content, persona, post_id }) {
  // Use the production domain so we always hit the latest deployed renderer.
  // If running on a Vercel preview, VERCEL_URL is the preview deployment; in
  // production the cron always runs against meetdossie.com.
  const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://meetdossie.com';
  const url = `${host}/api/render-card`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ platform, hook, content, persona, post_id }),
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
  console.log('[cron-generate-posts] starting batch — topic:', topic.key, 'at', now.toISOString());

  let raw;
  try {
    raw = await callAnthropic(buildPrompt(topic));
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
  for (let i = 0; i < generated.length; i++) {
    const p = generated[i];
    if (!p || typeof p !== 'object') continue;
    const persona = String(p.persona || '').toLowerCase();
    const platform = String(p.platform || '').toLowerCase();
    const content = String(p.content || '').trim();
    const hook = String(p.hook || '').trim();
    const cta = String(p.cta || '').trim();
    const hashtags = Array.isArray(p.hashtags) ? p.hashtags.map((h) => String(h).replace(/^#/, '').trim()).filter(Boolean) : [];
    if (!content || !platform || !persona) {
      insertErrors.push({ index: i, error: 'missing required field', got: { persona, platform, content_length: content.length } });
      continue;
    }

    let zernioAccountId = null;
    try { zernioAccountId = await lookupZernioAccountId(platform); } catch (_e) { zernioAccountId = null; }

    const postId = `${now.toISOString().slice(0, 10)}-${persona}-${platform}-${i}`;

    // Render branded card for Instagram + Facebook. Failure is non-fatal —
    // the row still inserts with media_url=null and cron-publish-approved
    // posts a text-only update.
    let mediaUrl = null;
    if (CARD_PLATFORMS.has(platform)) {
      const card = await renderSocialCard({
        platform,
        hook: hook || content.slice(0, 120),
        content,
        persona,
        post_id: postId,
      });
      if (card.ok) {
        mediaUrl = card.publicUrl;
        console.log(`[card] ${postId} -> ${card.publicUrl} (${card.size_bytes} bytes)`);
      } else {
        console.warn(`[card] ${postId} render failed status=${card.status} err=${String(card.error || '').slice(0, 200)}`);
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

  console.log('[cron-generate-posts] done — inserted', inserted, 'of', generated.length, 'errors:', insertErrors.length);
  return res.status(200).json({
    ok: true,
    generated: generated.length,
    inserted,
    batch_id: batchId,
    topic: topic.key,
    errors: insertErrors,
  });
};
