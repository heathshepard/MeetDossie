'use strict';

// Vercel Serverless Function: /api/sage-ab-test
//
// Creates an N-way hook-variant test from an existing social_posts row.
// Originally A/B-only (2 variants); generalized 2026-08-18 to support up to
// 6 variants in one call — the actual Schneider tactic this implements is
// "10-20 opening-line variants on the same value prop, real engagement picks
// the winner within 48h" (this repo's convention keeps the existing 72h
// window used elsewhere). variant_count defaults to 2 so existing callers
// (Sage's Telegram flow, docs) keep working unchanged.
//
// POST /api/sage-ab-test?source_id=<social_posts.id>&variant_count=<2-6>
//   Authorization: Bearer ${SAGE_TRIGGER_SECRET}
//
// What it does:
//   1. Loads the source post.
//   2. Marks the source as variant='A', hook_variant=<label>, and assigns a
//      new ab_test_group_id.
//   3. Asks Claude for N-1 additional variants in one call — different
//      opening-line/positioning angle each, same core value prop, plus a
//      short descriptive hook_variant label per variant (e.g. "cost_focus",
//      "urgency_open") so post_analytics can bucket by it once synced.
//   4. Inserts each as status='draft' with the same ab_test_group_id,
//      variant='B'/'C'/..., staggered 24h apart on the same platform.
//
// The publisher (cron-publish-approved) treats every variant like a normal
// draft. cron-analytics-sync flags the winner once ALL variants in the group
// have posted (or terminally failed/rejected) — see the ab_test_winner
// column on social_posts and the group-completeness check added 2026-08-18.

const { randomUUID } = require('node:crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SAGE_TRIGGER_SECRET = process.env.SAGE_TRIGGER_SECRET;

const VARIANT_MODEL = 'claude-sonnet-5';
const MIN_VARIANTS = 2;
const MAX_VARIANTS = 6; // Anthropic call is a single request; 6 keeps prompt+output manageable

async function supaFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Ask Claude for: (1) a hook_variant label describing the SOURCE post's own
// existing angle, and (2) N-1 new variants each with a hook/content/hashtags
// AND a distinct hook_variant label. One call covers the whole cohort so the
// labels are guaranteed distinct from each other.
async function generateVariantCohort(sourcePost, extraCount) {
  const platform = sourcePost.platform;
  const persona = sourcePost.persona || 'brand voice';
  const topic = sourcePost.topic || 'general';
  const hook = sourcePost.hook || '';
  const content = sourcePost.content || '';

  const prompt = `You are Sage, Head of Social Media for Dossie. Run a hook-variant test: same core value prop, ${extraCount + 1} total distinct opening-line/positioning angles.

Platform: ${platform}
Persona: ${persona}
Topic: ${topic}
Variant A (already exists, do not rewrite) hook: ${hook}
Variant A content:
${content}

Task:
1. Assign variant A a short "hook_variant" label describing ITS angle (2-3 words, snake_case, e.g. "cost_focus", "story_open", "control_angle").
2. Write ${extraCount} MORE variants. Each must:
   - Hit the SAME value pillar as A but from a genuinely different angle (cost vs control vs speed vs risk vs peer-comparison vs urgency, etc — no two variants share an angle, and none repeat A's angle).
   - Be the same approximate length as A.
   - Use the same persona voice rules.
   - Get its own short "hook_variant" label (snake_case, distinct from every other label in this batch, including A's).

Reply with JSON only, no code fences:
{
  "source_hook_variant": "...",
  "variants": [
    {"hook_variant": "...", "hook": "...", "content": "...", "hashtags": ["..."]},
    ...
  ]
}
"variants" must have exactly ${extraCount} entries.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VARIANT_MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const text = ((body?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Variant generator returned no JSON');
  }
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
  if (!Array.isArray(parsed.variants) || parsed.variants.length !== extraCount) {
    throw new Error(`Expected ${extraCount} variants, got ${Array.isArray(parsed.variants) ? parsed.variants.length : 'none'}`);
  }
  return parsed;
}

const VARIANT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!SAGE_TRIGGER_SECRET || authHeader !== `Bearer ${SAGE_TRIGGER_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const sourceId = String(req.query?.source_id || req.body?.source_id || '').trim();
  if (!sourceId) return res.status(400).json({ ok: false, error: 'missing source_id' });

  let variantCount = parseInt(req.query?.variant_count || req.body?.variant_count, 10);
  if (!Number.isFinite(variantCount)) variantCount = MIN_VARIANTS;
  variantCount = Math.max(MIN_VARIANTS, Math.min(MAX_VARIANTS, variantCount));

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const loadRes = await supaFetch(`social_posts?id=eq.${encodeURIComponent(sourceId)}&limit=1`);
  if (!loadRes.ok || !Array.isArray(loadRes.data) || loadRes.data.length === 0) {
    return res.status(404).json({ ok: false, error: 'source post not found' });
  }
  const source = loadRes.data[0];

  const groupId = randomUUID();
  const extraCount = variantCount - 1;

  let cohort;
  try {
    cohort = await generateVariantCohort(source, extraCount);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `variant gen failed: ${err && err.message}` });
  }

  await supaFetch(`social_posts?id=eq.${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      variant: 'A',
      ab_test_group_id: groupId,
      hook_variant: cohort.source_hook_variant || 'original',
    }),
  });

  const baseTime = source.scheduled_for || source.posted_at || new Date().toISOString();
  const insertedVariants = [];
  const errors = [];

  for (let i = 0; i < cohort.variants.length; i++) {
    const v = cohort.variants[i];
    const letter = VARIANT_LETTERS[i + 1]; // A is the source, so first new variant is B
    const scheduledAt = new Date(new Date(baseTime).getTime() + (i + 1) * 24 * 60 * 60 * 1000).toISOString();

    const row = {
      post_id: `${source.post_id || source.id}_${letter}`,
      platform: source.platform,
      content: v.content,
      hook: v.hook,
      hook_variant: v.hook_variant || `variant_${letter.toLowerCase()}`,
      cta: source.cta,
      hashtags: Array.isArray(v.hashtags) ? v.hashtags : (source.hashtags || []),
      suggested_time: source.suggested_time,
      status: 'draft',
      zernio_account_id: source.zernio_account_id,
      scheduled_for: scheduledAt,
      persona: source.persona,
      topic: source.topic,
      variant: letter,
      ab_test_group_id: groupId,
    };

    const insertRes = await supaFetch('social_posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });

    if (insertRes.ok) {
      insertedVariants.push(Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data);
    } else {
      errors.push({ letter, error: insertRes.data });
    }
  }

  if (insertedVariants.length === 0) {
    return res.status(500).json({ ok: false, error: 'all variant inserts failed', details: errors });
  }

  return res.status(200).json({
    ok: true,
    ab_test_group_id: groupId,
    variant_count: variantCount,
    variant_a: { id: source.id, post_id: source.post_id, hook_variant: cohort.source_hook_variant || 'original' },
    variants: insertedVariants,
    errors: errors.length ? errors : undefined,
  });
};
