'use strict';

// scripts/swipe-propose-hook-candidates.js
//
// Turns high-evidence swipe patterns into PROPOSED hook-bank entries written
// in our own voice against the borrowed structure.
//
// This script never touches docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md. It writes
// rows to swipe_hook_candidates with status='pending'. A human accepts them;
// scripts/swipe-merge-hook-candidates.js then appends the accepted ones to the
// playbook. That separation is the whole point — the hook bank is Heath's, and
// a collector should never be able to quietly rewrite it.
//
// Every proposal is run through the repo's existing guards before it is
// written: api/_lib/fabrication-guard.js (invented customers, made-up stats,
// member counts past the real one) and the swap test (would this sentence be
// true of any competitor? then it is not a hook, it is a category claim).
//
// USAGE
//   node scripts/swipe-propose-hook-candidates.js
//   node scripts/swipe-propose-hook-candidates.js --min-score 60 --limit 5 --dry-run

const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local');
loadEnvLocal(path.join(__dirname, '..'));

const { sb, EXTRACT_MODEL } = require('./_lib/swipe-store');
const { checkFabrication } = require('../api/_lib/fabrication-guard');

const BRAND_BY_MARKET = {
  tx_real_estate: 'realtor',
  tc_saas: 'dossie',
  fitness_ai: 'rust',
  unknown: 'dossie',
};

// Verified-fact floor, lifted from docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §2's
// guardrail block. A proposal that needs a fact outside this list is not
// proposable — say so rather than inventing one.
const VERIFIED_FACTS = `
DOSSIE (real-estate transaction assistant, "she"):
  - Software the agent uses directly. Not a course, not a staffing agency, not a generic CRM.
  - The market anchor we may cite: a human transaction coordinator commonly runs ~$400 per file.
  - Texas/TREC-specific deadline and form knowledge is real and shipped.
  - Never state a customer count, a testimonial, or a feature that is not shipped.
RUST (AI fitness coach app):
  - Readiness sliders are 1-5, NOT 1-10.
  - There is no calendar-based deload; the only back-off is per-exercise, 10% after missed reps.
  - Price is $19.99. Coach is subscription-gated.
  - Never claim "live in the app store" and never invent user counts or testimonials.
REALTOR (Heath's own practice):
  - Licensed TX REALTOR at Keller Williams, San Antonio / Boerne.
  - Only war stories on the verified list may be told. Never invent a deal, a client, or a number.
`.trim();

const SYSTEM = `You write short-form video hooks for Heath Shepard's three brands.

You are given a STRUCTURAL PATTERN observed in someone else's ad or post, plus
the evidence behind it. Write ONE new hook that uses that STRUCTURE with our
OWN true content.

Hard rules:
1. Never reuse the source's words, claims, statistics, offer or framing. You
   borrow the mechanism, never the material.
2. Every factual element must come from the VERIFIED FACTS block. If the
   structure only works with a fact we do not have, return
   {"proposable": false, "reason": "..."} and nothing else.
3. Swap test: if the sentence would be equally true printed on a competitor's
   homepage, it fails. Name something specific and ours.
4. No invented customers, counts, testimonials, timeframes or dollar figures.
5. It has to sound like a person, not a brand. Warm, direct, no corporate voice.

Return ONLY JSON, no prose, no code fence:
{
  "proposable": true,
  "candidate_hook": "<the on-screen / opening line, under 100 characters>",
  "rationale": "<one sentence: which structure it borrows and why it should carry over>"
}`;

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { minScore: 55, limit: 6, dryRun: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--min-score' && a[i + 1]) { out.minScore = Number(a[++i]); continue; }
    if (a[i] === '--limit' && a[i + 1]) { out.limit = parseInt(a[++i], 10) || 6; continue; }
    if (a[i] === '--dry-run') { out.dryRun = true; continue; }
  }
  return out;
}

async function propose(pattern) {
  const brand = BRAND_BY_MARKET[pattern.market] || 'dossie';
  const user = [
    `TARGET BRAND: ${brand}`,
    '',
    'OBSERVED STRUCTURE (not to be reproduced, only reused):',
    `  hook mechanism: ${pattern.hook_pattern}`,
    pattern.structure ? `  beat order: ${pattern.structure}` : null,
    pattern.cta_shape ? `  CTA shape: ${pattern.cta_shape}` : null,
    `  evidence: ${pattern.evidence_basis}`,
    '',
    'VERIFIED FACTS:',
    VERIFIED_FACTS,
  ].filter(Boolean).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: EXTRACT_MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || '').join('').trim();
  return JSON.parse(text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
}

async function main() {
  const args = parseArgs();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[swipe-propose] ANTHROPIC_API_KEY not set.');
    process.exit(2);
  }

  // Patterns above the evidence floor that have not already produced a candidate.
  const got = await sb(
    'swipe_patterns?select=id,market,hook_pattern,structure,cta_shape,evidence_score,evidence_basis'
    + `&evidence_score=gte.${args.minScore}&order=evidence_score.desc&limit=${args.limit * 4}`,
  );
  if (!got.ok) { console.error('[swipe-propose] query failed:', got.data); process.exit(1); }

  const existing = await sb('swipe_hook_candidates?select=pattern_id');
  const taken = new Set((existing.data || []).map((r) => r.pattern_id).filter(Boolean));
  const todo = (got.data || []).filter((p) => !taken.has(p.id)).slice(0, args.limit);

  if (!todo.length) {
    console.log('[swipe-propose] nothing new above the evidence floor. Done.');
    return;
  }

  let written = 0; let rejected = 0;
  for (const p of todo) {
    let out;
    try {
      out = await propose(p);
    } catch (err) {
      console.warn(`  ! ${p.id}: ${err.message}`);
      continue;
    }

    if (!out || out.proposable === false || !out.candidate_hook) {
      console.log(`  - skipped (${(out && out.reason) || 'not proposable'})`);
      rejected++;
      continue;
    }

    // Repo guard: catches invented customers, fake stats, member counts.
    const guard = checkFabrication(out.candidate_hook);
    if (!guard.ok) {
      console.log(`  ✗ fabrication guard rejected: ${guard.violations.join('; ')}`);
      console.log(`      "${out.candidate_hook}"`);
      rejected++;
      continue;
    }

    const row = {
      pattern_id: p.id,
      market: p.market,
      candidate_hook: out.candidate_hook,
      rationale: out.rationale || 'Borrowed structure; content from verified facts.',
      target_brand: BRAND_BY_MARKET[p.market] || 'dossie',
      evidence_score: p.evidence_score,
      status: 'pending',
    };

    if (args.dryRun) {
      console.log(`  [dry] [${row.target_brand}] "${row.candidate_hook}"  (evidence ${row.evidence_score})`);
      continue;
    }

    const ins = await sb('swipe_hook_candidates', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify([row]),
    });
    if (!ins.ok) { console.warn(`  ! insert failed: ${JSON.stringify(ins.data).slice(0, 200)}`); continue; }
    written++;
    console.log(`  ok [${row.target_brand}] "${row.candidate_hook}"`);
  }

  console.log(`[swipe-propose] done. pending_written=${written} rejected=${rejected}`);
  if (written) {
    console.log('  These are PENDING. Nothing reaches docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md');
    console.log('  until a human sets status=accepted and runs scripts/swipe-merge-hook-candidates.js.');
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[swipe-propose] fatal:', err && err.message);
    process.exit(1);
  });
}
