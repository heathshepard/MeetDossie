#!/usr/bin/env node
// sage-reviewer-regression.js
// Pull the last N posted drafts from social_posts and dry-run them through
// Cole's reviewer (cron-sage-autonomous-review.js logic). Report approval %.
//
// Built 2026-06-22 by sage_4 to verify the new VERIFIED_FACTS whitelist +
// surface-matrix demotions push approval rate >90% on already-shipped drafts.
//
// Usage:
//   node scripts/sage-reviewer-regression.js              # 50 posts, last 30 days
//   node scripts/sage-reviewer-regression.js --limit 25   # custom count
//   node scripts/sage-reviewer-regression.js --verbose    # show every result
//
// Needs in .env.local:
//   ANTHROPIC_API_KEY   (required — Cole reviewer calls Claude Sonnet)
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (optional — falls back to fixture file)

'use strict';

const fs = require('fs');
const path = require('path');

// Load .env.local manually (no dotenv dep)
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotEnv();

const { buildVerifiedFactsBlock, POLICY_SURFACE_MATRIX } = require('../api/_lib/sage-verified-facts.js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// In production, cron uses 'claude-sonnet-4-20250514' (Anthropic-internal alias).
// Local dev key resolves to 'claude-sonnet-4-6' — same model family, same prompt behavior.
const REVIEWER_MODEL = process.env.SAGE_REGRESSION_MODEL || 'claude-sonnet-4-6';

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg !== -1 ? parseInt(args[limitArg + 1], 10) : 50;
const VERBOSE = args.includes('--verbose');
const FIXTURE_ARG = args.indexOf('--fixture');
const FIXTURE = FIXTURE_ARG !== -1 ? args[FIXTURE_ARG + 1] : null;

if (!ANTHROPIC_API_KEY) {
  console.error('ERR: ANTHROPIC_API_KEY not set in .env.local');
  process.exit(1);
}

const VERIFIED_FACTS = buildVerifiedFactsBlock();

// ----- Inline copy of Cole review prompts (kept in sync with cron) -----
function buildPrompts(post) {
  const isGroupPost = !!post.post_body && post.first_comment_body !== undefined;

  const systemPrompt = isGroupPost
    ? `You are Cole, Chief of Staff at Shepard Ventures (which owns Dossie). You're reviewing this Facebook group post for brand fit and editorial polish before it ships.

Your role: warm but rigorous. You DEFAULT TO APPROVE. The deterministic verifier already passed these posts on facts. Your job is brand voice — NOT re-checking facts.

${VERIFIED_FACTS}

${POLICY_SURFACE_MATRIX}

## Facebook GROUP Post Rules (THIS POST IS A GROUP POST)

1. **No Dossie in Main Body** (HARD-BLOCK): Post body must NEVER mention Dossie. This rule applies ONLY to FB group posts.
2. **Dossie in First Comment** (HARD-BLOCK): If post has a first comment, it MUST contain the literal word "Dossie" and name ONE specific shipped capability.
3. **Brand Voice Fit**: Tone is warm, casual, genuine, first-person. Like an agent talking to other agents.
4. **Hook Quality**: Opening must be punchy and agent-relatable.
5. **Pillar Alignment**: Touches one of Cost, Control, Visibility, Speed, Coverage.

## Decision Framework — DEFAULT TO APPROVE

Send back ONLY for these four conditions (per locked spec):
(a) Obvious factual fabrication BEYOND the VERIFIED FACTS whitelist.
(b) Wrong persona for the platform's audience.
(c) PII or sensitive data exposure.
(d) FB-group main-body Dossie mention.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "concise specific reason if not approve"}`
    : `You are Cole, Chief of Staff at Shepard Ventures (which owns Dossie). You review main social posts (Facebook page, Twitter, LinkedIn, Instagram) for brand voice and editorial fit.

Your role: warm but rigorous editor. You DEFAULT TO APPROVE. The deterministic verifier already passed these posts on facts. Your job is brand voice — NOT re-checking facts.

${VERIFIED_FACTS}

${POLICY_SURFACE_MATRIX}

## Review Rules (MAIN SOCIAL POSTS — Facebook PAGE, Twitter, LinkedIn, Instagram)

1. **Dossie Mention IS EXPECTED**: This is the brand's own social presence. Dossie naming in the caption is correct. NEVER send back for "Dossie should be in first comment" — that rule is FB-group-only.
2. **All 4 Personas Are Valid**: 'brenda', 'patricia', 'victor', 'dossie' — all 4 are documented valid personas.
3. **Brand Voice**: Warm, capable, agent-focused.
4. **Hook Quality**: First 1-2 sentences are punchy and agent-relatable.
5. **Pillar Alignment**: Touches Cost, Control, Visibility, Speed, or Coverage.

## Decision Framework — DEFAULT TO APPROVE

Send back ONLY for these four conditions:
(a) Obvious factual fabrication BEYOND the VERIFIED FACTS whitelist.
(b) Wrong persona for the platform's audience.
(c) PII or sensitive data exposure.
(d) FB-group rule violation (DOES NOT APPLY HERE).

DEMOTED to warning (auto-approve):
- "Dossie mentioned in main body" objections on FB Page / Twitter / LinkedIn / Instagram.
- "Persona is dossie not brenda/patricia/victor".
- "$29/month / $400 per file / TC quit in Italy / 4:30am" objections (verified).
- **Hashtag COUNT alone is NEVER a send-back trigger.** Twitter 2-5, LinkedIn 3-5, Instagram 8-10 are all normal.
- Minor copy nits (clunky phrasing, "could read better") → AUTO-APPROVE.
- Self-contradicting reasoning ("on second thought, actually fine") → AUTO-APPROVE.

DECIDE THE VERDICT FIRST. Then write feedback only if send_back or reject. ≤25 words in feedback.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "concise specific reason if not approve"}`;

  const userPrompt = isGroupPost
    ? `Review this Facebook group post:

Group: ${post.group_name || 'unknown'}
Category: ${post.category || 'general'}
Pillar: ${post.pillar || 'unspecified'}

POST BODY:
${post.post_body}

FIRST COMMENT:
${post.first_comment_body || '(no first comment)'}

Apply the rules above. DEFAULT to APPROVE. Return JSON only.`
    : `Review this social media post:

Platform: ${post.platform}
Persona: ${post.persona || 'brand'}
Topic: ${post.topic || 'unspecified'}

Caption:
${post.content}

Hashtags: ${Array.isArray(post.hashtags) ? post.hashtags.join(' ') : (typeof post.hashtags === 'string' ? post.hashtags : '(none)')}

Media: ${post.media_url ? 'attached' : 'text only'}

Apply the rules above. DEFAULT to APPROVE. Return JSON only.`;

  return { systemPrompt, userPrompt };
}

async function coleReview(post) {
  const { systemPrompt, userPrompt } = buildPrompts(post);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: REVIEWER_MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn('API failed:', res.status, body.slice(0, 200));
      return null;
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;
    return JSON.parse(text.slice(start, end + 1));
  } catch (err) {
    console.warn('review failed:', err.message);
    return null;
  }
}

async function loadPostsFromSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env not set');
  }
  const url = `${SUPABASE_URL}/rest/v1/social_posts?status=eq.posted&order=created_at.desc&limit=${LIMIT}&select=id,platform,persona,topic,hook,content,hashtags,media_url`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

function loadPostsFromFixture(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  let posts;
  if (FIXTURE) {
    console.log(`Loading fixture: ${FIXTURE}`);
    posts = loadPostsFromFixture(FIXTURE);
  } else {
    try {
      posts = await loadPostsFromSupabase();
    } catch (err) {
      console.error('Supabase load failed:', err.message);
      console.error('Pass --fixture <file.json> to use a local fixture');
      process.exit(1);
    }
  }

  posts = posts.slice(0, LIMIT);
  console.log(`\nRegression test: ${posts.length} shipped drafts → Cole reviewer\n`);
  console.log(`Model: ${REVIEWER_MODEL}\n`);

  const results = { approve: 0, send_back: 0, reject: 0, error: 0 };
  const sendBackSamples = [];
  const rejectSamples = [];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const review = await coleReview(post);

    if (!review) {
      results.error++;
      console.log(`[${i + 1}/${posts.length}] ERROR (${post.platform}/${post.persona})`);
      continue;
    }

    const decision = String(review.decision || '').toLowerCase();
    if (decision === 'approve') {
      results.approve++;
      if (VERBOSE) console.log(`[${i + 1}/${posts.length}] APPROVE ${review.score} (${post.platform}/${post.persona})`);
    } else if (decision === 'send_back') {
      results.send_back++;
      sendBackSamples.push({
        platform: post.platform,
        persona: post.persona,
        hook: post.hook || (post.content || '').slice(0, 80),
        score: review.score,
        feedback: review.feedback,
      });
      console.log(`[${i + 1}/${posts.length}] SEND_BACK ${review.score} (${post.platform}/${post.persona}): ${review.feedback}`);
    } else if (decision === 'reject') {
      results.reject++;
      rejectSamples.push({
        platform: post.platform,
        persona: post.persona,
        hook: post.hook || (post.content || '').slice(0, 80),
        score: review.score,
        feedback: review.feedback,
      });
      console.log(`[${i + 1}/${posts.length}] REJECT ${review.score} (${post.platform}/${post.persona}): ${review.feedback}`);
    } else {
      results.error++;
      console.log(`[${i + 1}/${posts.length}] UNKNOWN decision: ${decision}`);
    }
  }

  const total = posts.length;
  const approvalRate = ((results.approve / total) * 100).toFixed(1);

  console.log('\n' + '='.repeat(60));
  console.log('REGRESSION RESULTS');
  console.log('='.repeat(60));
  console.log(`Total drafts:     ${total}`);
  console.log(`APPROVE:          ${results.approve} (${approvalRate}%)`);
  console.log(`SEND_BACK:        ${results.send_back}`);
  console.log(`REJECT:           ${results.reject}`);
  console.log(`Errors:           ${results.error}`);
  console.log('='.repeat(60));
  console.log(`Target:           >90% approval`);
  console.log(`Pass:             ${approvalRate >= 90 ? 'YES' : 'NO'}`);
  console.log('='.repeat(60));

  if (sendBackSamples.length > 0) {
    console.log('\nSEND_BACK PATTERNS (top 5):');
    for (const s of sendBackSamples.slice(0, 5)) {
      console.log(`  - [${s.platform}/${s.persona}] score=${s.score} "${(s.hook || '').slice(0, 60)}"`);
      console.log(`    feedback: ${s.feedback}`);
    }
  }
  if (rejectSamples.length > 0) {
    console.log('\nREJECT PATTERNS:');
    for (const s of rejectSamples) {
      console.log(`  - [${s.platform}/${s.persona}] score=${s.score} "${(s.hook || '').slice(0, 60)}"`);
      console.log(`    feedback: ${s.feedback}`);
    }
  }

  // Persist results for the spawn record
  const reportPath = path.join(__dirname, '..', '.sage-regression-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    run_at: new Date().toISOString(),
    model: REVIEWER_MODEL,
    total,
    approve: results.approve,
    send_back: results.send_back,
    reject: results.reject,
    errors: results.error,
    approval_rate_pct: parseFloat(approvalRate),
    pass: approvalRate >= 90,
    send_back_samples: sendBackSamples,
    reject_samples: rejectSamples,
  }, null, 2));
  console.log(`\nReport saved: ${reportPath}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
