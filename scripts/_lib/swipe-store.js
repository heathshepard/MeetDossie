'use strict';

// scripts/_lib/swipe-store.js
//
// Shared storage + pattern-extraction layer for the swipe-file pipeline.
// Used by scripts/swipe-collect-meta.js, scripts/swipe-collect-youtube.js and
// api/swipe-ingest.js.
//
// Doc: docs/SWIPE-FILE-PIPELINE.md
// Migration: supabase/migrations/20260918a_swipe_file_pipeline.sql
//
// THE ONE RULE THIS FILE ENFORCES IN CODE:
// a performance number is only ever written if the SOURCE published it.
// scoreEvidence() below cannot produce a score out of thin air — it takes a
// typed evidence object and returns both the score and the sentence that
// justifies it. If there is no evidence, the score is low and evidence_basis
// says so in plain English. Nothing in this pipeline may write an impression
// count, a CTR, or a spend figure that a source did not hand us.

const crypto = require('crypto');

const SUPABASE_URL = () => (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SERVICE_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL()}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SERVICE_KEY(),
      Authorization: `Bearer ${SERVICE_KEY()}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ─── Market classification ───────────────────────────────────────────────────
// Deterministic keyword gate, not a model call — a classifier we can audit and
// that costs nothing. Order matters: tc_saas is checked before tx_real_estate
// because "transaction coordinator for realtors" is a TC ad, not a listing ad.

const MARKET_RULES = [
  {
    market: 'tc_saas',
    any: [
      // Every term is \b-anchored on BOTH ends. 2026-09-18: an unanchored
      // 'e-?sign' matched "de<esign>" and filed a fight-gym recovery ad as
      // TC/SaaS. A classifier that silently mislabels is worse than one that
      // returns 'unknown', because the bad row then looks like market signal.
      '\\btransaction coordinat', '\\btc\\b', '\\btc business\\b', '\\bclosing coordinat',
      '\\bcontract to close\\b', '\\bctc\\b', '\\bdeal management\\b', '\\bbrokerage software\\b',
      '\\bcompliance software\\b', '\\breal estate crm\\b', '\\blisting management software\\b',
      '\\be-?sign(ature|ing)?\\b', '\\bback office for agents\\b', '\\bpaperwork for agents\\b',
    ],
  },
  {
    market: 'tx_real_estate',
    any: [
      '\\brealtor', '\\breal estate agent\\b', '\\bmls\\b', '\\btrec\\b', '\\blisting agent\\b',
      '\\bbuyers agent\\b', "\\bbuyer's agent\\b", '\\bhome for sale\\b', '\\bjust listed\\b',
      '\\bjust sold\\b', '\\bopen house\\b', '\\bsan antonio\\b', '\\bboerne\\b', '\\btexas\\b',
      '\\bsabor\\b', '\\bhomes for sale\\b', '\\bsell your home\\b', '\\blist your home\\b',
      // '\\btx\\b' deliberately omitted: too many false hits on unrelated copy.
    ],
  },
  {
    market: 'fitness_ai',
    any: [
      '\\bworkout', '\\bfitness app\\b', '\\bpersonal train', '\\bai coach\\b', '\\bgym\\b',
      '\\bstrength train', '\\blifting\\b', '\\bhypertrophy\\b', '\\bmacros?\\b', '\\bmeal plan',
      '\\bweight loss app\\b', '\\bfitness coaching\\b', '\\bprogressive overload\\b',
      '\\breps and sets\\b', '\\bai (personal )?trainer\\b',
    ],
  },
];

const COMPILED = MARKET_RULES.map((r) => ({
  market: r.market,
  re: new RegExp(r.any.join('|'), 'i'),
}));

function classifyMarket(...texts) {
  const blob = texts.filter(Boolean).join(' \n ');
  if (!blob.trim()) return 'unknown';
  for (const { market, re } of COMPILED) {
    if (re.test(blob)) return market;
  }
  return 'unknown';
}

// ─── Evidence scoring ────────────────────────────────────────────────────────
// 0-100, built only from what a source actually published.
//
//   ad_longevity        — Meta prints the date an ad started running. A
//                         commercial ad carries no impressions or spend in the
//                         public Ad Library, so run length IS the signal:
//                         nobody keeps paying to run a loser. Curve is
//                         deliberately steep early and flat late — 90 days of
//                         continuous spend already clears the "this converts"
//                         bar; 400 days is not 4x better evidence than 100.
//   youtube_engagement  — real view/like/comment counts. Scored on engagement
//                         RATE against views (absolute views mostly measure
//                         channel size), with a floor on views so a 12-view
//                         video with 3 likes doesn't outrank a real hit.
//   source_reported     — the source published its own performance figure.
//   none                — no evidence. Capped at 25, and it says so.
//
// Returns { score, basis } — the basis string is stored verbatim in
// swipe_patterns.evidence_basis so the number can always be challenged.

function scoreEvidence(evidence) {
  const kind = evidence && evidence.kind;

  if (kind === 'ad_longevity') {
    const days = Number(evidence.days_running);
    if (!Number.isFinite(days) || days < 0) {
      return { score: 25, basis: 'Meta Ad Library gave no usable start date; run length unknown.' };
    }
    // 0d -> 30, 30d -> ~55, 90d -> ~72, 180d -> ~83, 365d+ -> ~92 (cap 95).
    const score = Math.min(95, 30 + 65 * (1 - Math.exp(-days / 130)));
    return {
      score: Number(score.toFixed(2)),
      basis: `${days} day${days === 1 ? '' : 's'} continuously running per Meta Ad Library's published start date. `
        + 'Meta publishes no impressions or spend for commercial ads, so longevity is the only performance signal available here.',
    };
  }

  if (kind === 'youtube_engagement') {
    const views = Number(evidence.views) || 0;
    const likes = Number(evidence.likes) || 0;
    const comments = Number(evidence.comments) || 0;
    if (views < 1000) {
      return {
        score: Math.min(35, 10 + views / 50),
        basis: `${views.toLocaleString()} views, ${likes.toLocaleString()} likes, ${comments.toLocaleString()} comments (YouTube Data API). Below the 1,000-view floor — treated as weak evidence.`,
      };
    }
    const rate = (likes + comments * 3) / views; // comments weighted; they cost more
    // rate 0.5% -> ~45, 2% -> ~70, 5% -> ~86, 10%+ -> ~93 (cap 95)
    const score = Math.min(95, 25 + 70 * (1 - Math.exp(-rate / 0.035)));
    return {
      score: Number(score.toFixed(2)),
      basis: `${views.toLocaleString()} views, ${likes.toLocaleString()} likes, ${comments.toLocaleString()} comments per the YouTube Data API `
        + `(engagement rate ${(rate * 100).toFixed(2)}% of views, comments weighted 3x). Real counts, not estimates.`,
    };
  }

  if (kind === 'source_reported') {
    return {
      score: Number(evidence.score) || 60,
      basis: evidence.basis || 'Performance figure published by the source itself.',
    };
  }

  return {
    score: 25,
    basis: 'No performance data available from this source. Filed on structure alone — treat as unproven.',
  };
}

// ─── Upsert ──────────────────────────────────────────────────────────────────
// Re-seeing an ad updates last_seen and still_active but never moves
// first_seen — that pair is how we watch an ad's life without guessing at it.

function refFor(source, key) {
  if (key) return String(key);
  return crypto.createHash('sha256').update(String(source)).digest('hex').slice(0, 32);
}

async function upsertSwipeAd(row) {
  const payload = {
    source: row.source,
    source_ref: refFor(row.source, row.source_ref),
    market: row.market || 'unknown',
    advertiser: row.advertiser || null,
    advertiser_url: row.advertiser_url || null,
    creative_type: row.creative_type || 'unknown',
    hook_text: row.hook_text || null,
    full_copy: row.full_copy || null,
    cta_text: row.cta_text || null,
    link: row.link || null,
    run_started_on: row.run_started_on || null,
    run_ended_on: row.run_ended_on || null,
    still_active: row.still_active === undefined ? null : row.still_active,
    last_seen: new Date().toISOString(),
    evidence: row.evidence || null,
    evidence_kind: row.evidence_kind || 'none',
    raw: row.raw || null,
    notes: row.notes || null,
  };

  const { ok, status, data } = await sb(
    'swipe_ads?on_conflict=source,source_ref',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([payload]),
    },
  );
  if (!ok) return { ok: false, status, error: data };
  const saved = Array.isArray(data) ? data[0] : data;
  return { ok: true, row: saved };
}

// ─── Pattern extraction ──────────────────────────────────────────────────────

const EXTRACT_MODEL = process.env.SWIPE_EXTRACT_MODEL || 'claude-sonnet-5';

const EXTRACT_SYSTEM = `You analyse advertising and social copy for a swipe file.

You extract STRUCTURE ONLY. You never reproduce, lightly reword, or paraphrase
the source's actual sentences, claims, statistics, offers, or brand names into
anything reusable. Describe the MECHANISM the copy uses, the way a critic
describes a plot device rather than retelling the plot.

Return ONLY a JSON object, no prose, no code fence:
{
  "hook_pattern": "<one sentence naming the mechanism the opening line uses>",
  "structure": "<the beat order, e.g. 'cost anchor -> agitation -> single proof -> low-friction ask'>",
  "cta_shape": "<what kind of ask it is, not its words>",
  "hook_type": "<one of: question, stat, before-after, testimonial, bold-claim, story-open, curiosity-gap, contrast>",
  "why_it_works": "<one sentence>",
  "transferable": true|false
}

Set "transferable" false when the mechanism only works because of a claim we
could not truthfully make (an income promise, an invented statistic, a
credential we do not hold).`;

async function extractPattern(ad) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'ANTHROPIC_API_KEY not set' };

  const userMsg = [
    `SOURCE: ${ad.source}`,
    `MARKET: ${ad.market}`,
    `ADVERTISER: ${ad.advertiser || 'unknown'}`,
    ad.run_started_on ? `RUNNING SINCE: ${ad.run_started_on}` : null,
    '',
    'COPY:',
    (ad.full_copy || ad.hook_text || '').slice(0, 6000),
    '',
    ad.cta_text ? `CTA: ${ad.cta_text}` : null,
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 700,
        system: EXTRACT_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) return { ok: false, error: `anthropic ${res.status}` };
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('').trim();
    const jsonStr = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    return { ok: true, pattern: JSON.parse(jsonStr) };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function savePattern(adRow, pattern, extractedBy) {
  const { score, basis } = scoreEvidence(adRow.evidence);
  const { ok, status, data } = await sb(
    'swipe_patterns?on_conflict=swipe_ad_id',
    {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{
        swipe_ad_id: adRow.id,
        market: adRow.market,
        hook_pattern: pattern.hook_pattern,
        structure: pattern.structure || null,
        cta_shape: pattern.cta_shape || null,
        hook_type: pattern.hook_type || null,
        evidence_score: score,
        evidence_basis: basis,
        extracted_by: extractedBy || EXTRACT_MODEL,
      }]),
    },
  );
  if (!ok) return { ok: false, status, error: data };
  return { ok: true, row: Array.isArray(data) ? data[0] : data };
}

// Mirror the pattern (never the copy) into sage_swipe_items so the existing
// post generator picks it up through api/_lib/sage-external-patterns.js. This
// is the one bridge into the generation side, and it deliberately carries no
// verbatim text — sage_swipe_items_external_no_verbatim would reject it anyway.
async function mirrorToSageSwipeItems(adRow, pattern, patternRow) {
  const payload = {
    creator_name: adRow.advertiser || 'unknown',
    platform: adRow.source === 'meta_ad_library' ? 'facebook'
      : adRow.source === 'youtube' ? 'youtube'
        : adRow.source === 'tiktok_creative_center' ? 'tiktok' : 'other',
    post_url: null,          // the link lives on swipe_ads; keep this side clean
    post_text: null,         // REQUIRED NULL for source='external'
    source: 'external',
    status: 'pending',
    hook_type: pattern.hook_type || null,
    pattern_notes: [
      pattern.hook_pattern,
      pattern.structure ? `Structure: ${pattern.structure}` : null,
      pattern.cta_shape ? `CTA shape: ${pattern.cta_shape}` : null,
      patternRow && patternRow.evidence_basis ? `Evidence: ${patternRow.evidence_basis}` : null,
    ].filter(Boolean).join(' | '),
    observed_via_url: adRow.link || null,
    engagement_score: patternRow ? patternRow.evidence_score : null,
  };
  return sb('sage_swipe_items', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([payload]),
  });
}

// Full pipe for one collected item: upsert -> extract -> score -> mirror.
async function ingestOne(row, opts = {}) {
  const up = await upsertSwipeAd(row);
  if (!up.ok) return { ok: false, stage: 'upsert', error: up.error };

  // Already analysed and unchanged? Don't pay for a second extraction.
  if (!opts.force) {
    const existing = await sb(`swipe_patterns?swipe_ad_id=eq.${up.row.id}&select=id&limit=1`);
    if (existing.ok && Array.isArray(existing.data) && existing.data.length) {
      return { ok: true, adId: up.row.id, skipped: 'already_analysed' };
    }
  }

  const ex = await extractPattern(up.row);
  if (!ex.ok) return { ok: true, adId: up.row.id, stored: true, analysed: false, error: ex.error };

  const saved = await savePattern(up.row, ex.pattern, EXTRACT_MODEL);
  if (!saved.ok) return { ok: true, adId: up.row.id, stored: true, analysed: false, error: saved.error };

  if (ex.pattern.transferable !== false) {
    await mirrorToSageSwipeItems(up.row, ex.pattern, saved.row).catch(() => {});
  }

  return {
    ok: true,
    adId: up.row.id,
    patternId: saved.row && saved.row.id,
    analysed: true,
    transferable: ex.pattern.transferable !== false,
    evidence_score: saved.row && saved.row.evidence_score,
  };
}

module.exports = {
  sb,
  classifyMarket,
  scoreEvidence,
  upsertSwipeAd,
  extractPattern,
  savePattern,
  mirrorToSageSwipeItems,
  ingestOne,
  EXTRACT_MODEL,
};
