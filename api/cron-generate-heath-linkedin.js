// Vercel Serverless Function: /api/cron-generate-heath-linkedin
// Generates 1 LinkedIn post per day in Heath's authentic first-person voice.
// This is NOT the Dossie brand voice used by cron-generate-posts.js.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 11 * * 1-5 (11:00 UTC / 6am CDT, weekdays only)
//
// The existing cron-send-to-sage.js picks up drafts automatically.
// The existing cron-publish-approved.js will skip these (no posting_schedule
// row for linkedin_personal). Publishing is handled by
// scripts/linkedin-engager.js --post-approved via Playwright.

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ANTHROPIC_MODEL = 'claude-sonnet-5';
const VERIFIER_MODEL = 'claude-haiku-4-5-20251001';

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
];

function pickTopic() {
  const start = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
  const today = new Date();
  const dayOfYear = Math.floor((today - start) / 86400000);
  return TOPICS[dayOfYear % TOPICS.length];
}

// ─── System prompt ───────────────────────────────────────────────────────────
const HEATH_SYSTEM_PROMPT = `You are Heath Shepard, a licensed Texas REALTOR at Keller Williams in San Antonio who built Dossie — an AI transaction coordinator for TX agents. You write LinkedIn posts in your own voice.

VOICE RULES:
- First person always (I, me, my, we)
- Casual but professional — like texting a colleague who respects your opinion
- Short paragraphs (1-2 sentences each)
- No hashtags (LinkedIn algorithm penalizes them)
- No emojis
- No corporate marketing language ("revolutionize", "game-changer", "innovative")
- Tell stories, not pitches
- End with a question or soft observation, not a hard CTA
- 150-250 words max
- Never mention founding spots, specific pricing, or member counts in posts
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

// ─── Verifier system prompt ──────────────────────────────────────────────────
const VERIFIER_SYSTEM_PROMPT = `You are the Heath LinkedIn Content Verifier. Your job is to check a LinkedIn post written as Heath Shepard against his verified facts and flag any fabrications.

VERIFIED FACTS:
- Licensed TX REALTOR at Keller Williams (City View / Boerne), San Antonio
- Been through 3 transaction coordinators
- Last TC quit while he was on vacation in Italy with active deals in escrow, 7-8 hour time difference
- TC services cost $350-$400 per file
- Waking at 4:30am wondering if repair amendment / option fee receipt was sent
- Built Dossie — AI transaction coordinator for TX agents
- Dossie has real paying customers (no specific count allowed)
- Runs Plane & Ember (cigar woodwork) on the side
- Shipped features: TREC deadline auto-calc, contract PDF scanning, email draft queue, morning brief, closing milestone cards, pipeline view, Talk-to-Dossie chat

FLAG AS RED:
- Specific dollar amounts not in verified facts ($350-$400/file is OK)
- Invented timestamps with false specificity ("Tuesday at 9:43pm")
- Named customers or invented quotes
- Features claimed as live that are not shipped
- Specific member/customer counts
- Founding spot counts or specific pricing in post body
- Invented anecdotes not traceable to the three verified pain stories

FLAG AS YELLOW:
- Claims that could be true but cannot be verified from facts above
- Paraphrased quotes that should be checked

Output ONLY this JSON (no markdown fences, no prose):
{
  "verdict": "approve" | "needs_revision",
  "flags": [
    {
      "severity": "red" | "yellow",
      "claim": "<exact phrase from draft>",
      "issue": "<why it's a problem>",
      "fix": "<suggested replacement>"
    }
  ],
  "summary": "<one sentence>"
}

Rules:
- verdict "approve" ONLY when zero red flags AND at most one yellow flag.
- verdict "needs_revision" when ANY red flag OR two+ yellow flags.
- Be terse. Under 400 tokens total.`;

// ─── Supabase helper ─────────────────────────────────────────────────────────
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

// ─── Anthropic helpers ───────────────────────────────────────────────────────
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
  if (!res.ok) {
    const err = new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  let data;
  try { data = JSON.parse(text); } catch (e) {
    throw new Error('Anthropic returned non-JSON: ' + text.slice(0, 200));
  }
  const content = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
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

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = withTelemetry('cron-generate-heath-linkedin', async function handler(req, res) {
  // Auth
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
  const postId = `heath-linkedin-${dateStr}`;

  // ─── Idempotency check ──────────────────────────────────────────────────
  const existing = await supabaseFetch(
    `/rest/v1/social_posts?post_id=eq.${encodeURIComponent(postId)}&select=id,status&limit=1`,
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    console.log(`[cron-generate-heath-linkedin] post ${postId} already exists, skipping`);
    return res.status(200).json({ ok: true, skipped: true, post_id: postId, reason: 'already exists' });
  }

  // ─── Pick topic ─────────────────────────────────────────────────────────
  const topic = pickTopic();
  console.log(`[cron-generate-heath-linkedin] generating for ${dateStr}, topic: ${topic.key}`);

  // ─── Generate post via Claude ───────────────────────────────────────────
  const userMessage = `${topic.prompt}

Write a LinkedIn post. Return ONLY the post text, nothing else. No JSON, no markdown fences, no commentary.`;

  let postContent;
  try {
    postContent = await callAnthropic(ANTHROPIC_MODEL, HEATH_SYSTEM_PROMPT, userMessage, 1024);
  } catch (err) {
    console.error('[cron-generate-heath-linkedin] generation failed:', err.message);
    return res.status(502).json({ ok: false, error: 'generation failed', detail: err.message });
  }

  if (!postContent || postContent.length < 50) {
    console.error('[cron-generate-heath-linkedin] generated content too short:', postContent?.length);
    return res.status(502).json({ ok: false, error: 'generated content too short' });
  }

  // ─── Verify post against facts ──────────────────────────────────────────
  let verifierResult;
  try {
    const verifierRaw = await callAnthropic(
      VERIFIER_MODEL,
      VERIFIER_SYSTEM_PROMPT,
      `Verify this LinkedIn post draft:\n\n${postContent}`,
      800,
    );
    verifierResult = extractJson(verifierRaw);
  } catch (err) {
    console.warn('[cron-generate-heath-linkedin] verifier failed, defaulting to needs_revision:', err.message);
    verifierResult = {
      verdict: 'needs_revision',
      flags: [{ severity: 'red', claim: '(verifier error)', issue: err.message, fix: 'review manually' }],
      summary: 'Verifier call failed — defaulting to needs_revision.',
    };
  }

  // Normalize verdict
  const hasRedFlag = Array.isArray(verifierResult.flags) &&
    verifierResult.flags.some((f) => String(f?.severity || '').toLowerCase() === 'red');
  const verdict = hasRedFlag ? 'needs_revision' : (verifierResult.verdict === 'approve' ? 'approve' : 'needs_revision');

  const rowStatus = verdict === 'needs_revision' ? 'rejected' : 'draft';
  const rejectionReason = verdict === 'needs_revision'
    ? `VERIFIER: ${verifierResult.summary || 'needs_revision'}${
        Array.isArray(verifierResult.flags) ? '\n' + verifierResult.flags
          .filter((f) => ['red', 'yellow'].includes(String(f?.severity || '').toLowerCase()))
          .map((f) => `[${f.severity}] "${String(f.claim || '').slice(0, 100)}" — ${String(f.issue || '').slice(0, 150)}`)
          .join('\n') : ''
      }`.slice(0, 1800)
    : null;

  console.log(`[cron-generate-heath-linkedin] verifier: ${verdict}, status: ${rowStatus}`);

  // ─── Insert into social_posts ───────────────────────────────────────────
  const row = {
    post_id: postId,
    platform: 'linkedin_personal',
    persona: 'heath',
    content: postContent,
    content_hash: require('crypto').createHash('md5').update(postContent).digest('hex'),
    hook: postContent.split('\n')[0].slice(0, 120),
    status: rowStatus,
    topic: topic.key,
    video_required: false,
    generated_at: now.toISOString(),
    created_at: now.toISOString(),
    verifier_result: verifierResult,
    error_message: rejectionReason,
  };

  const ins = await supabaseFetch('/rest/v1/social_posts?on_conflict=post_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });

  if (!ins.ok) {
    console.error('[cron-generate-heath-linkedin] insert failed:', ins.status, JSON.stringify(ins.data).slice(0, 300));
    return res.status(502).json({ ok: false, error: 'insert failed', detail: ins.status });
  }

  console.log(`[cron-generate-heath-linkedin] done — post_id=${postId} status=${rowStatus} topic=${topic.key} words=${postContent.split(/\s+/).length}`);

  return res.status(200).json({
    ok: true,
    post_id: postId,
    status: rowStatus,
    topic: topic.key,
    verifier_verdict: verdict,
    word_count: postContent.split(/\s+/).length,
  });
});
