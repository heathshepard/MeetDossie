'use strict';

// Vercel Serverless Function: /api/sage-ab-test
//
// Creates an A/B test pair from an existing social_posts row. Sage calls this
// either directly via a trigger marker or as a follow-up after generating a
// draft she wants to test.
//
// POST /api/sage-ab-test?source_id=<social_posts.id>
//   Authorization: Bearer ${SAGE_TRIGGER_SECRET}
//
// What it does:
//   1. Loads the source post.
//   2. Marks the source as variant='A' and assigns a new ab_test_group_id.
//   3. Generates a variant B by asking Claude for a different angle on the
//      same hook/topic, posted to the same platform on the next available
//      day at the same time slot.
//   4. Inserts variant B as status='draft' with the same ab_test_group_id
//      and variant='B'.
//
// The publisher (cron-publish-approved) treats both variants like normal
// drafts. cron-analytics-sync flags the winner 72h after both publish — see
// the ab_test_winner column on social_posts.

const { randomUUID } = require('node:crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SAGE_TRIGGER_SECRET = process.env.SAGE_TRIGGER_SECRET;

const VARIANT_MODEL = 'claude-sonnet-5';

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

async function generateVariantB(sourcePost) {
  const platform = sourcePost.platform;
  const persona = sourcePost.persona || 'brand voice';
  const topic = sourcePost.topic || 'general';
  const hook = sourcePost.hook || '';
  const content = sourcePost.content || '';

  const prompt = `You are Sage, Head of Social Media for Dossie. Write a SECOND variant of the post below for an A/B test. Same platform, same persona, same topic. DIFFERENT angle.

Platform: ${platform}
Persona: ${persona}
Topic: ${topic}
Variant A hook: ${hook}
Variant A content:
${content}

Variant B should:
- Hit the same value pillar but from a different angle (e.g. if A is cost-focused, B can be control-focused).
- Be the same approximate length as A.
- Use the same persona voice rules.
- Not reuse the same hook line.

Reply with JSON only: {"hook": "...", "content": "...", "hashtags": ["..."]}.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: VARIANT_MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  }
  const body = await res.json();
  const text = body?.content?.[0]?.text || '';
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error('Variant generator returned no JSON');
  }
  return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
}

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

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }

  const loadRes = await supaFetch(`social_posts?id=eq.${encodeURIComponent(sourceId)}&limit=1`);
  if (!loadRes.ok || !Array.isArray(loadRes.data) || loadRes.data.length === 0) {
    return res.status(404).json({ ok: false, error: 'source post not found' });
  }
  const source = loadRes.data[0];

  const groupId = randomUUID();

  await supaFetch(`social_posts?id=eq.${encodeURIComponent(sourceId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ variant: 'A', ab_test_group_id: groupId }),
  });

  let variantB;
  try {
    variantB = await generateVariantB(source);
  } catch (err) {
    return res.status(502).json({ ok: false, error: `variant gen failed: ${err && err.message}` });
  }

  // Schedule variant B 24h after variant A's posted_at or scheduled_for.
  const baseTime = source.scheduled_for || source.posted_at || new Date().toISOString();
  const scheduledB = new Date(new Date(baseTime).getTime() + 24 * 60 * 60 * 1000).toISOString();

  const rowB = {
    post_id: `${source.post_id || source.id}_B`,
    platform: source.platform,
    content: variantB.content,
    hook: variantB.hook,
    cta: source.cta,
    hashtags: Array.isArray(variantB.hashtags) ? variantB.hashtags : (source.hashtags || []),
    suggested_time: source.suggested_time,
    status: 'draft',
    zernio_account_id: source.zernio_account_id,
    scheduled_for: scheduledB,
    persona: source.persona,
    topic: source.topic,
    variant: 'B',
    ab_test_group_id: groupId,
  };

  const insertRes = await supaFetch('social_posts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(rowB),
  });

  if (!insertRes.ok) {
    return res.status(500).json({ ok: false, error: 'insert variant B failed', detail: insertRes.data });
  }

  return res.status(200).json({
    ok: true,
    ab_test_group_id: groupId,
    variant_a: { id: source.id, post_id: source.post_id },
    variant_b: Array.isArray(insertRes.data) ? insertRes.data[0] : insertRes.data,
  });
};
