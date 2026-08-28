'use strict';

// scripts/sage-external-swipe-research.js
//
// External trend-research pass for the sage_swipe_* pipeline. Finds
// genuinely high-engagement examples in Dossie's real niche (real estate
// TC-pain / agent productivity content) across the platforms Dossie's own
// AI-video account actually posts to (FB, IG, TikTok, LinkedIn -- see
// docs/PIPELINE.md "SOCIAL MEDIA ACCOUNTS"; Twitter/X excluded here because
// it isn't a video-content platform and YouTube excluded because Dossie has
// zero content routed there yet), and extracts PATTERN-LEVEL data ONLY.
//
// HARD SAFETY RULE (see migration 20260828190000_sage_swipe_external_source.sql):
// never store verbatim script/caption/footage text for an external-source
// row. The DB itself enforces this (CHECK: source='external' => post_text
// IS NULL) -- this script additionally never attempts to populate post_text
// for ANY row it inserts, even before hitting that constraint.
//
// TOOLING NOTE (2026-08-28): this task specified Bright Data MCP tools
// (mcp__brightdata__search_engine, scrape_as_markdown) as the intended
// research mechanism. Those tools were NOT present in this agent session's
// actual tool list despite being named in the task brief -- only
// Bash/Read/Write/WebFetch/WebSearch were available. Research for this run
// was done via WebSearch/WebFetch against public, non-authenticated sources
// (Inman News, journalism covering specific viral posts, aggregate
// engagement-rate studies) instead. The INSERT_ROWS data below is what that
// research produced, hand-verified against real published numbers -- not
// invented. A future run with real Bright Data MCP access would call
// search_engine()/scrape_as_markdown() to gather the same PATTERN-LEVEL
// fields (never raw post text) and populate a directory below.
//
// USAGE:
//   node scripts/sage-external-swipe-research.js            -- inserts INSERT_ROWS
//   node scripts/sage-external-swipe-research.js --dry-run   -- prints only, no DB writes
//
// This script is NOT wired into any cron or agent_queue dispatch. It runs
// manually only, per Heath's explicit "review before unsupervised" call.
// See api/cron-sage-external-trend-research.js for the (also-dormant)
// scheduled-pass scaffold this would eventually be called from.

const fs = require('fs');
const path = require('path');

// Load .env.local when running locally (same pattern as ad-library-scraper.js)
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/\r$/, '').replace(/^"(.*)"$/, '$1');
      if (val && val !== '[SENSITIVE]') process.env[key] = val; // last real value wins over placeholders/dupes
    }
  }
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supaFetch(pathname, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${pathname}`;
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
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: res.ok, status: res.status, data };
}

// ─── Watchlist entries (creators observed, all real/public) ────────────────
// Not a claim that Dossie should model itself on these individuals -- just
// the source attribution for the patterns below.
const WATCHLIST_ROWS = [
  {
    creator_name: 'Jered Jones',
    platform: 'tiktok',
    handle: null, // not confirmed from source article, left null rather than guessed
    reason: 'Realtor, viral property-tour format shift (scripted-comedy to authentic-reaction) analyzed by Inman News',
    source: 'external',
  },
  {
    creator_name: 'Joe Seamon',
    platform: 'tiktok',
    handle: '@forsalebyjoe',
    reason: 'Realtor, 1.1M-view curiosity-gap walkthrough video, covered by local news (AOL/syndicated)',
    source: 'external',
  },
];

// ─── Pattern-level swipe items (PATTERN ONLY -- no captions/scripts quoted) ─
const INSERT_ROWS = [
  {
    creator_name: 'Jered Jones',
    platform: 'tiktok',
    post_url: null, // specific video URL not resolvable via non-JS fetch; article covers it, not a direct scrape
    observed_via_url: 'https://www.inman.com/2025/09/09/how-this-agent-went-viral-by-falling-in-love-with-the-home-in-his-tiktok-video-tour/',
    engagement_score: 1000000, // "a million views" within 2-3 days, per Inman
    hook_type: 'story-open / emotional-reveal',
    video_length_seconds: 90, // article: creator's stated ceiling/best-practice, not confirmed exact runtime of this video
    pacing_notes: 'Tone shift mid-video (cautious exploration -> genuine excitement) functions as the pacing beat, not rapid cuts -- single continuous scene, not text-overlay-driven.',
    caption_structure_notes: null, // not available from this source without risking paraphrase-as-quote; left null rather than guessed
    posting_time_notes: null,
    pattern_notes: 'Planned/scripted comedy bit (parody music video, ~48k views) was OUTPERFORMED 20x by an unplanned authentic reaction captured mid-tour, where the creator broke the "agent selling a house" frame and made a direct personal ask to the audience (turning viewers into participants in his own decision, not just an audience for the listing). Structural lesson: authenticity + direct audience address beat production value. Posting cadence: 4-5x/week.',
    source: 'external',
    status: 'pending',
  },
  {
    creator_name: 'Joe Seamon',
    platform: 'tiktok',
    post_url: null, // specific TikTok video URL not resolvable via non-JS fetch
    observed_via_url: 'https://www.aol.com/north-augusta-realtor-goes-viral-090431270.html',
    engagement_score: 1100000, // 1.1M views, ~12,000 comments per article
    hook_type: 'curiosity-gap / open-question',
    video_length_seconds: null, // not stated in source
    pacing_notes: 'Single walkthrough format (not fast-cut) -- pacing driven by the open question, not edit rhythm.',
    caption_structure_notes: 'Question posed directly to the audience as the core CTA ("why do you think this is still on the market") rather than a listing-info caption -- structurally invites comment-section engagement, which is likely why comment count (12k) is unusually high relative to view count.',
    posting_time_notes: 'Posted Sunday afternoon; reached 500-600k views within 4-5 hours -- fast early velocity on a weekend afternoon slot.',
    pattern_notes: 'Structural pattern: turn the viewer into the judge/decision-maker (an open "why" question about a real, unresolved situation) rather than delivering an answer. Creator had <1 year on the platform at time of virality -- pattern is replicable without an established audience.',
    source: 'external',
    status: 'pending',
  },
  {
    creator_name: 'aggregate: Reel-E / TrueFuture Media / Buffer engagement-rate studies',
    platform: 'instagram',
    post_url: null,
    observed_via_url: 'https://www.reel-e.ai/blog/real-estate-marketing-statistics',
    engagement_score: null, // this is an aggregate stat, not a single post's score
    hook_type: null,
    video_length_seconds: null,
    pacing_notes: null,
    caption_structure_notes: 'Carousels (multi-image/document format) out-save Reels significantly -- one 2026 analysis puts carousel engagement rate near 10%, Reels near 6% on the same measure; a separate study (Buffer) shows the reach-weighted numbers roughly inverted-in-magnitude but same directional finding (carousels win on save/return-visit metrics, Reels win on cold reach to non-followers).',
    posting_time_notes: null,
    pattern_notes: 'Aggregate, not single-post pattern: for an account under 50k followers (Dossie is well under this), Reels should be the DISCOVERY format (reach to non-followers) and carousels the RETENTION/save format for the same underlying content -- i.e. the same educational point should be repurposed into both a Reel (hook-first, fast) and a carousel (slower, save-worthy) rather than picking one. Cross-platform posting frequency finding: 3-5x/week is the consistency floor most studies associate with growth; below that, algorithmic reach compounds down.',
    source: 'external',
    status: 'pending',
  },
  {
    creator_name: 'aggregate: LinkedIn viral-post structure guides (Comment Rocket / meet-lea)',
    platform: 'linkedin',
    post_url: null,
    observed_via_url: 'https://commentrocket.com/blog/linkedin-strategy-for-real-estate-agents',
    engagement_score: null,
    hook_type: 'stat-or-story-specific (not generic-claim) opener',
    video_length_seconds: null,
    pacing_notes: null,
    caption_structure_notes: 'Highest-performing LinkedIn document-carousel/PDF posts get ~7% engagement vs ~6% for native video and get 39% more reach / 30% more engagement than the platform average -- yet under 5% of profiles post that format, meaning it is under-used specifically in this niche. Structural post shape reported across multiple guides: specific hook (a number or named situation, not a generic claim) -> one concrete insight -> a personal-authority angle -> soft CTA.',
    posting_time_notes: 'Replying to all comments within the first 2 hours is associated with ~30% more total engagement on the post (comment-velocity feeds the algorithm early).',
    pattern_notes: 'Structural gap for LinkedIn specifically: video content on this platform gets 5x the engagement of a plain text post and is reported as 20x more likely to be shared, but Dossie is not currently using LinkedIn document/PDF-carousel format at all (per docs/PIPELINE.md, LinkedIn gets Victor persona video via cron-generate-posts.js only) -- an underused high-performing format for this specific platform.',
    source: 'external',
    status: 'pending',
  },
];

// ─── Distilled rules (generalized, cross-checkable statements) ─────────────
const RULE_ROWS = [
  {
    rule_text: 'Authentic/unplanned reaction format outperforms scripted comedy in real estate TC/agent content -- direct audience address (making the viewer a participant, not a spectator) is the transferable mechanic, not the specific scene.',
    rule_type: 'hook-format',
    source_creator: 'Jered Jones',
    source_url: 'https://www.inman.com/2025/09/09/how-this-agent-went-viral-by-falling-in-love-with-the-home-in-his-tiktok-video-tour/',
    status: 'active',
    source: 'external',
  },
  {
    rule_text: 'Open-question curiosity-gap hooks ("why do you think X") posed directly to camera drive disproportionately high comment counts relative to views -- useful for TC-pain content asking "why do you think this deal fell through" style prompts.',
    rule_type: 'hook-format',
    source_creator: 'Joe Seamon',
    source_url: 'https://www.aol.com/north-augusta-realtor-goes-viral-090431270.html',
    status: 'active',
    source: 'external',
  },
  {
    rule_text: 'Under 50k followers: lead with Reels for cold reach, republish the same educational point as a carousel for saves/retention -- do not choose one format per topic, pair them.',
    rule_type: 'trend',
    source_creator: 'aggregate (Reel-E / TrueFuture Media / Buffer)',
    source_url: 'https://www.reel-e.ai/blog/real-estate-marketing-statistics',
    status: 'active',
    source: 'external',
  },
  {
    rule_text: 'LinkedIn document/PDF-carousel posts outperform native video and text on this platform specifically (higher engagement + reach) and are almost unused in this niche -- a real, currently-untapped format gap for Dossie on LinkedIn.',
    rule_type: 'trend',
    source_creator: 'aggregate (Comment Rocket / meet-lea)',
    source_url: 'https://commentrocket.com/blog/linkedin-strategy-for-real-estate-agents',
    status: 'active',
    source: 'external',
  },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const rulesOnly = process.argv.includes('--rules-only');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in environment.');
    process.exit(1);
  }

  // Safety self-check before writing anything: refuse to insert any
  // external-source row that carries post_text, even though the DB also
  // enforces this. Fail loud, not silent.
  for (const row of INSERT_ROWS) {
    if (row.source === 'external' && row.post_text) {
      console.error(`REFUSING TO INSERT: row for ${row.creator_name} has post_text set on an external-source row.`);
      process.exit(1);
    }
  }

  console.log(`=== sage-external-swipe-research: ${dryRun ? 'DRY RUN' : 'LIVE'} ===`);
  console.log(`Watchlist rows: ${WATCHLIST_ROWS.length}`);
  console.log(`Swipe items: ${INSERT_ROWS.length}`);
  console.log(`Distilled rules: ${RULE_ROWS.length}`);

  if (dryRun) {
    console.log(JSON.stringify({ WATCHLIST_ROWS, INSERT_ROWS, RULE_ROWS }, null, 2));
    return;
  }

  if (!rulesOnly) {
    // 1. Watchlist (upsert-ish: insert, tolerate dupes since table is empty pre-run)
    const wl = await supaFetch('sage_swipe_watchlist', {
      method: 'POST',
      body: JSON.stringify(WATCHLIST_ROWS),
    });
    console.log(`Watchlist insert: ok=${wl.ok} status=${wl.status} rows=${Array.isArray(wl.data) ? wl.data.length : 0}`);
    if (!wl.ok) console.error(wl.data);

    // 2. Swipe items
    const items = await supaFetch('sage_swipe_items', {
      method: 'POST',
      body: JSON.stringify(INSERT_ROWS),
    });
    console.log(`Swipe items insert: ok=${items.ok} status=${items.status} rows=${Array.isArray(items.data) ? items.data.length : 0}`);
    if (!items.ok) console.error(items.data);
  } else {
    console.log('--rules-only: skipping watchlist + swipe items inserts');
  }

  // 3. Distilled rules
  const rules = await supaFetch('sage_swipe_rules', {
    method: 'POST',
    body: JSON.stringify(RULE_ROWS),
  });
  console.log(`Rules insert: ok=${rules.ok} status=${rules.status} rows=${Array.isArray(rules.data) ? rules.data.length : 0}`);
  if (!rules.ok) console.error(rules.data);

  console.log('=== done ===');
}

main().catch((err) => {
  console.error('sage-external-swipe-research failed:', err);
  process.exit(1);
});

module.exports = { WATCHLIST_ROWS, INSERT_ROWS, RULE_ROWS };
