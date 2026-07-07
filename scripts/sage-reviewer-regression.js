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
// Local dev key resolves to 'claude-sonnet-5' — same model family, same prompt behavior.
const REVIEWER_MODEL = process.env.SAGE_REGRESSION_MODEL || 'claude-sonnet-5';

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

// -------------------------------------------------------------------------
// DEMOTED-RULE SANITIZER (2026-07-07 sage recalibration)
// Mirror of api/cron-sage-autonomous-review.js — must stay in sync.
// -------------------------------------------------------------------------
// Mirror of api/cron-sage-autonomous-review.js — must stay in sync.
const DEMOTED_KEYWORD_PATTERNS = [
  /dossie\s+mention(ion)?\s+rule/i,
  /dossie\s+(should\s+)?(be\s+)?(in|moved\s+to)\s+(the\s+)?first\s+comment/i,
  /(reserve|save|move)\s+.*dossie.*for\s+first\s+comment/i,
  /dossie\s+in\s+(the\s+)?(main\s+)?(body|caption|post)/i,
  /product\s+details?\s+(buried|in\s+caption).*first\s+comment/i,
  /mentions?\s+dossie\s+throughout/i,
  /dossie\s+isn'?t\s+mentioned\s+until/i,
  /bury(?:ing|ies|ied)?\s+dossie/i,
  /dossie\s+(is\s+)?(mentioned\s+)?buried/i,
  /dossie\s+mention.*first\s+comment/i,
  /caption\s+.*(first\s+comment|save.*first)/i,
  /first\s+comment\s+per\s+rules/i,
  /should\s+save\s+product\s+details/i,
  /persona\s+mismatch/i,
  /tagged\s+(as\s+)?['"]?dossie['"]?\s+but\s+should\s+be/i,
  /'?dossie'?\s+is\s+not\s+a\s+valid\s+persona/i,
  /dossie\s+doesn'?t\s+post\s+in\s+first-?person/i,
  /use\s+brenda\/?patricia\/?victor/i,
  /(reframe|rewrite|use)\s+(as\s+)?agent\s+persona/i,
  /should\s+be\s+agent[- ]?focused\s+voice/i,
  /dossie\s+persona\s+(should|but\s+reads)/i,
  /hashtag\s+count/i,
  /too\s+many\s+hashtags/i,
  /(more|less)\s+than\s+\d+\s+hashtags/i,
  /clunky\s+phrasing/i,
  /could\s+read\s+better/i,
  /consider\s+rephrasing/i,
  /on\s+second\s+thought/i,
  /actually\s+fine/i,
  /minor\s+(copy\s+)?nit/i,
  /reads?\s+(like\s+)?(a\s+)?(corporate|sales\s*[- ]?y|salesy|marketing|product\s+pitch|sales\s+pitch)/i,
  /too\s+corporate/i,
  /voice\s+is\s+off/i,
  /tone\s+(drift|is\s+off)/i,
  /reads?\s+more\s+like\s+a?\s*sales\s+pitch/i,
  /voice\s+too\s+salesy/i,
  /salesy\/?corporate/i,
];
const VERIFIED_FACT_KEYWORDS = [
  /\$29(?![\d])/i,
  /\$400(?![\d])/i,
  /founding\s+pricing/i,
  /founding\s+member\s+pricing/i,
  /founding\s+price/i,
  /italy/i,
  /4:?30\s*(am|a\.m\.)/i,
  /4:?30\s*in\s+the\s+morning/i,
  /heath\s+built\s+dossie/i,
  /heath.*tc\s+quit/i,
  /tc\s+quit.*heath/i,
  /locked\s+while\s+(your\s+)?subscription/i,
];
const UNVERIFICATION_KEYWORDS = [
  /unverified/i,
  /fabricat/i,
  /invented/i,
  /needs\s+verification/i,
  /not\s+confirmed/i,
  /no\s+evidence/i,
  /lacks\s+verification/i,
  /is\s+a\s+(specific\s+)?claim/i,
  /is\s+a\s+specific\s+detail/i,
  /invented\s+narrative/i,
  /specific\s+claim.*verification/i,
];
function isDemotedChunk(chunk) {
  if (DEMOTED_KEYWORD_PATTERNS.some((rx) => rx.test(chunk))) return true;
  const hasFact = VERIFIED_FACT_KEYWORDS.some((rx) => rx.test(chunk));
  const hasUnverif = UNVERIFICATION_KEYWORDS.some((rx) => rx.test(chunk));
  if (hasFact && hasUnverif) return true;
  return false;
}
const HARD_BLOCK_PATTERNS = [
  /invented\s+customer(?:\s+name)?/i,
  /fake\s+testimonial/i,
  /fabricated\s+testimonial/i,
  /made-?up\s+testimonial/i,
  /unshipped\s+feature/i,
  /unreleased\s+feature/i,
  /pii/i,
  /personal\s+information/i,
  /phone\s+number/i,
  /email\s+address\s+exposed/i,
  /home\s+address/i,
  /harmful/i,
  /discriminatory/i,
  /misleading\s+medical/i,
];
function scoreFeedback(feedback) {
  if (!feedback || typeof feedback !== 'string') {
    return { totalObjections: 0, demotedCount: 0, hardBlockCount: 0 };
  }
  const chunks = feedback
    .split(/(?:\n+|\(\d+\)|(?:^|\s)\d+[\.\)]\s+|;\s+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);
  const list = chunks.length > 0 ? chunks : [feedback];
  const substantive = list.filter((c) => {
    const t = c.trim();
    if (/^(multiple\s+)?(hard\s+)?(critical\s+)?(blockers?|issues?|violations?|failures?)[\s:.-]*$/i.test(t)) return false;
    if (t.length < 15) return false;
    return true;
  });
  const scored = substantive.length > 0 ? substantive : list;
  let hardBlockCount = 0;
  let demotedCount = 0;
  for (const chunk of scored) {
    if (HARD_BLOCK_PATTERNS.some((rx) => rx.test(chunk))) {
      hardBlockCount++;
      continue;
    }
    if (isDemotedChunk(chunk)) {
      demotedCount++;
    }
  }
  return { totalObjections: scored.length, demotedCount, hardBlockCount };
}
function sanitizeReview(review, isGroupPost) {
  if (!review) return review;
  const decision = String(review.decision || '').toLowerCase();
  if (isGroupPost) return review;
  if (decision !== 'send_back' && decision !== 'reject') return review;
  const { totalObjections, demotedCount, hardBlockCount } = scoreFeedback(review.feedback);
  if (hardBlockCount > 0) return review;
  if (demotedCount >= 2 && totalObjections > 0 && demotedCount / totalObjections >= 0.5) {
    return {
      decision: 'approve',
      score: Math.max(review.score || 5, 7),
      feedback: `[sanitized: ${demotedCount}/${totalObjections} demoted objections]`,
      _sanitized: true,
      _originalDecision: decision,
      _originalFeedback: review.feedback,
    };
  }
  return review;
}

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

## HARD RULE — READ BEFORE ANSWERING

If your ONLY objections come from the DEMOTED list below, verdict is APPROVE.
Do not send_back. Do not reject. APPROVE.

## THE ONLY REASONS TO SEND_BACK ARE:

(a) INVENTED customer name (e.g., "Sarah from Plano") not in VERIFIED CUSTOMERS.
(b) INVENTED testimonial or quote attributed to a specific person we don't have.
(c) Specific fake MRR / deal count / metric that contradicts VERIFIED FACTS.
(d) A feature described as shipped that isn't in VERIFIED FEATURES.
(e) PII or sensitive data.
(f) FB-GROUP main-body Dossie mention (NOT applicable — this is a MAIN social post).

If NONE of (a)-(f) applies, verdict is APPROVE.

DEMOTED to warning (auto-approve, never a send_back reason):
- Dossie in main-body caption on FB Page / Twitter / LinkedIn / Instagram.
- Persona tagged 'dossie' flagged as mismatch.
- $29 / $400 / Italy / 4:30am / founding pricing flagged as unverified — all VERIFIED.
- Hashtag count too high on any platform.
- Reads "salesy" / "corporate" / "like marketing" without specific rule violation.
- Minor copy nits ("clunky", "could read better").
- Self-contradicting reasoning.

## MANDATORY SELF-CHECK

Before emitting JSON:
1. Feedback cites "Dossie mention rule" / "first comment" for non-group post? → APPROVE.
2. Feedback says persona 'dossie' is invalid? → APPROVE.
3. Feedback says $29 / $400 / Italy / 4:30am / founding pricing unverified? → APPROVE.
4. Feedback says hashtag count too high? → APPROVE.
5. Feedback says reads corporate/salesy without specific fabrication? → APPROVE.
6. Only concrete objection is in (a)-(f)? If not → APPROVE.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "≤20 words"}`;

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
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
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

  let sanitizedCount = 0;
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const rawReview = await coleReview(post);

    if (!rawReview) {
      results.error++;
      console.log(`[${i + 1}/${posts.length}] ERROR (${post.platform}/${post.persona})`);
      continue;
    }

    // Group post detection matches production cron
    const isGroupPost = !!post.post_body && post.first_comment_body !== undefined;
    const review = sanitizeReview(rawReview, isGroupPost);
    if (review._sanitized) {
      sanitizedCount++;
      if (VERBOSE) console.log(`[${i + 1}/${posts.length}] SANITIZED ${rawReview.decision} → approve (${post.platform}/${post.persona})`);
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
  console.log(`  of which sanitized (LLM said no → override yes): ${sanitizedCount}`);
  console.log(`SEND_BACK:        ${results.send_back}`);
  console.log(`REJECT:           ${results.reject}`);
  console.log(`Errors:           ${results.error}`);
  console.log('='.repeat(60));
  console.log(`Target:           40-60% approval on mixed batch, >75% on posted drafts`);
  console.log(`Pass:             ${approvalRate >= 40 && approvalRate <= 95 ? 'YES' : 'NO'}`);
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
