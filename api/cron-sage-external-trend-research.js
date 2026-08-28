// Vercel Serverless Function: /api/cron-sage-external-trend-research
//
// *** BUILT BUT NOT ACTIVATED. NOT in vercel.json's `crons` array. ***
// Per Heath's explicit instruction (2026-08-28 task brief): "Heath explicitly
// wants to review real output before this runs unsupervised on any
// schedule." This file exists so the weekly pass CAN be turned on later by
// adding one entry to vercel.json — do not add that entry without Heath's
// go-ahead.
//
// ARCHITECTURE NOTE: Bright Data MCP tools (search_engine, scrape_as_markdown)
// are only available inside a real Claude Code agent SESSION — they cannot
// be called from a bare Vercel serverless function the way the RSS/Atom
// fetchers in cron-sage-trends.js can. This endpoint therefore does NOT try
// to do the research itself. It follows the exact same handoff pattern as
// api/cron-generate-pages.js (nightly guide/feature/answer pipeline, see
// docs/CONTENT-PIPELINE.md): it enqueues a real agent_queue task for `sage`,
// which scripts/agent-queue-poller.js (already running on Heath's PC) picks
// up and spawns as a full `claude --agent sage --dangerously-skip-permissions`
// session — an actual agent session with real Bright Data MCP tool access,
// not a fetch() call from serverless.
//
// The spawned session's job (per the task_brief below): run Bright Data
// search_engine/scrape_as_markdown against FB/IG/TikTok/LinkedIn for
// high-engagement examples in Dossie's real estate TC-pain/agent-productivity
// niche, extract PATTERN-LEVEL data only (see
// scripts/sage-external-swipe-research.js header for the exact safety rule
// and column shape), and insert into sage_swipe_watchlist/items/rules with
// source='external' — never verbatim script/caption/footage text (DB-enforced
// via the sage_swipe_items_external_no_verbatim CHECK constraint).
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1

require('./_lib/telegram-gate').install('cron-sage-external-trend-research');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function sb(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function buildTaskBrief() {
  return `
SAGE — WEEKLY EXTERNAL TREND-RESEARCH PASS

Extend the sage_swipe_* pipeline with real high-engagement examples from
outside Dossie, matching the platforms Dossie's own AI-video account
actually posts to (check docs/PIPELINE.md "SOCIAL MEDIA ACCOUNTS" for the
current live list — do not guess).

HARD SAFETY RULE — read scripts/sage-external-swipe-research.js header
before writing anything: extract PATTERN only (hook type, video length,
pacing, caption structure, posting time). NEVER store or reproduce
verbatim script/caption/footage text. The DB enforces this on
sage_swipe_items (source='external' rows cannot have post_text set) but
apply the same judgment to every field you write, especially pattern_notes
— describe structure, never quote. If genuinely unsure whether something
is "pattern" or "content," leave it out and say so in your summary.

1. Use Bright Data MCP (search_engine, scrape_as_markdown) to find genuinely
   high-engagement examples in real estate TC-pain / agent-productivity
   content on the live platforms.
2. For each: extract hook_type, video_length_seconds, pacing_notes,
   caption_structure_notes, posting_time_notes, pattern_notes,
   engagement_score (if a real number is stated by the source), source_url /
   observed_via_url. Insert into sage_swipe_items with source='external'.
3. Distill repeatable rules into sage_swipe_rules (rule_type must be one of:
   copywriting, hook-format, trend, edit-technique, cta-pattern — this is a
   real DB CHECK constraint), source='external'.
4. Add any new creators worth tracking to sage_swipe_watchlist.
5. Report back a summary: how many items/rules added, and the actual rows
   (Heath reviews this via Telegram/DossieMarketingBot before anything
   downstream uses it — do not wire this into cron-generate-posts.js
   yourself; that's a separate, still-dormant step in
   api/_lib/sage-external-patterns.js).

Reference: scripts/sage-external-swipe-research.js (the manual run this
scaffold is modeled on, executed once 2026-08-28) and
supabase/migrations/20260828190000_sage_swipe_external_source.sql (schema).
`.trim();
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Extra belt-and-suspenders kill switch, independent of vercel.json not
  // listing this cron: even a manual/forced hit refuses to enqueue work
  // unless explicitly overridden. Flip via Vercel env var when Heath
  // approves activation — do not remove this check as part of "wiring in."
  if (process.env.SAGE_EXTERNAL_TREND_RESEARCH_ENABLED !== 'true') {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'SAGE_EXTERNAL_TREND_RESEARCH_ENABLED is not set to true — this pass is built but intentionally inactive pending Heath review.',
    });
  }

  try {
    const insertAgentTask = await sb('agent_queue', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_name: 'sage',
        task_subject: 'Weekly external trend-research pass (sage_swipe_*)',
        task_brief: buildTaskBrief(),
        priority: 5,
        venture: 'dossie',
        status: 'pending',
        metadata: {
          source: 'cron-sage-external-trend-research',
          enqueued_at: new Date().toISOString(),
        },
      }),
    });
    if (!insertAgentTask.ok) {
      return res.status(500).json({ ok: false, error: 'agent_queue insert failed', detail: insertAgentTask.data });
    }
    return res.status(200).json({ ok: true, enqueued: true, task: insertAgentTask.data && insertAgentTask.data[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
