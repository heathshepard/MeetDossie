// scripts/claude-code-task-handlers/competitor_scan.js
//
// Weekly competitor deep-scan handler.
// Delegated by cron-competitor-scan-weekly.js. Uses `claude --print` with web
// tools to scrape / evaluate each tracked account + hashtag search. Updates:
//   - public.competitor_tracked_accounts (active/dormant/new)
//   - public.social_posts (adds source_type='competitor_remix' drafts)
//   - Shepard-Ventures/Marketing/sage/competitors-live.json
//   - Shepard-Ventures/Marketing/sage/competitor-intel-weekly-YYYY-MM-DD.md
//
// This handler intentionally trusts the LLM to do the heavy scraping in-session
// because we ship `--dangerously-skip-permissions` — Claude Code inside Heath's
// Max session already has web tools. The prompt asks for a strict-JSON envelope
// summarising what to persist; we don't post-process HTML in Node.
//
// Contract:
//   payload: {
//     week_of: 'YYYY-MM-DD',
//     tracked: [ { platform, handle, ... } ],
//     tracked_count: int,
//     discovery_hashtags: { platform: [tag, ...] },
//     dormant_threshold_days: 30,
//     viral_min_likes: 500,
//     viral_min_share_ratio: 0.02
//   }
//
// Owner: Atlas, 2026-07-08.

'use strict';

const fs = require('fs');
const path = require('path');
const { runClaude, extractJsonTail, sbFetch } = require('./_lib/claude-spawn.js');

const REPORT_DIR = 'C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\Marketing\\sage';

function buildPrompt(p) {
  const tracked = (p.tracked || []).slice(0, 60);
  return [
    `# Competitor scan — week of ${p.week_of}`,
    ``,
    `You are Sage. Deep-scan REALTOR/TC social competitors this week.`,
    ``,
    `## Tracked accounts (up to 60)`,
    ...tracked.map((a) => `- ${a.platform}/@${a.handle} last_post=${a.last_post_at || '?'} followers=${a.followers || '?'}`),
    ``,
    `## Discovery hashtags`,
    ...Object.entries(p.discovery_hashtags || {}).map(([platform, tags]) => `- ${platform}: ${(tags || []).join(', ')}`),
    ``,
    `## Rules`,
    `- "Dormant" = no post in ${p.dormant_threshold_days || 30}+ days.`,
    `- "Viral" = likes >= ${p.viral_min_likes || 500} OR share_ratio >= ${p.viral_min_share_ratio || 0.02}.`,
    `- "New discovered" = REALTOR/TC-adjacent account not in the tracked list, appearing in hashtag results with >= 5k followers OR >= 1 viral post this week.`,
    `- Keep viral_posts to max 12 across all competitors — the strongest ones we'd want Sage to remix.`,
    ``,
    `## Return ONLY this JSON on the last line, no code fences`,
    ``,
    `{`,
    `  "retained":[{"platform":"...","handle":"..."}],`,
    `  "new_discovered":[{"platform":"...","handle":"...","display_name":"...","followers":int,"why":"one line","discovery_source":"hashtag_scan"}],`,
    `  "dormant":[{"platform":"...","handle":"...","days_since_post":int}],`,
    `  "viral_posts":[{"platform":"...","handle":"...","external_url":"...","hook":"one line summary of their hook","angle":"one line summary of the angle","estimated_likes":int,"remix_direction":"one line — how Sage should remix this for Dossie"}]`,
    `}`,
  ].join('\n');
}

module.exports = async function competitorScan({ payload, task_id, log }) {
  if (!payload || !payload.week_of) {
    return { ok: false, summary: 'payload.week_of required', error: 'missing_week_of' };
  }

  log(`competitor_scan week=${payload.week_of} tracked=${payload.tracked_count}`);
  const prompt = buildPrompt(payload);
  const runResult = await runClaude(prompt, { model: 'sonnet', timeoutMs: 15 * 60 * 1000, log });
  if (!runResult.ok) {
    return { ok: false, summary: `claude failed: ${runResult.error}`, error: runResult.error };
  }
  const parsed = extractJsonTail(runResult.raw);
  if (!parsed) {
    return { ok: false, summary: 'json_parse_failed', error: 'json_parse_failed' };
  }

  const results = {
    week_of: payload.week_of,
    retained_count: (parsed.retained || []).length,
    new_discovered_count: (parsed.new_discovered || []).length,
    dormant_count: (parsed.dormant || []).length,
    viral_posts_count: (parsed.viral_posts || []).length,
    inserts: { competitors: 0, seed_drafts: 0 },
    updates: { dormant_flagged: 0 },
  };

  // Upsert new_discovered → competitor_tracked_accounts
  for (const acct of (parsed.new_discovered || []).slice(0, 30)) {
    if (!acct.platform || !acct.handle) continue;
    const r = await sbFetch(
      `competitor_tracked_accounts?on_conflict=platform,handle`,
      {
        method: 'POST',
        headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify({
          platform: acct.platform,
          handle: acct.handle,
          display_name: acct.display_name || null,
          status: 'active',
          followers: acct.followers || null,
          discovery_source: acct.discovery_source || 'hashtag_scan',
          last_scanned_at: new Date().toISOString(),
          metadata: { why: acct.why || null, week_of: payload.week_of },
        }),
      }
    );
    if (r.ok) results.inserts.competitors++;
  }

  // Flag dormant accounts
  for (const d of (parsed.dormant || [])) {
    if (!d.platform || !d.handle) continue;
    const r = await sbFetch(
      `competitor_tracked_accounts?platform=eq.${encodeURIComponent(d.platform)}&handle=eq.${encodeURIComponent(d.handle)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'dormant',
          last_scanned_at: new Date().toISOString(),
        }),
      }
    );
    if (r.ok) results.updates.dormant_flagged++;
  }

  // Seed viral_posts into social_posts as competitor_remix drafts.
  //
  // CRITICAL (locked 2026-07-12): the SEED briefing (angle/remix direction/
  // source URL) MUST NEVER land in the `content` column. `content` is the
  // public caption Zernio sends verbatim to Instagram/Facebook/etc. Previous
  // wiring wrote "[COMPETITOR REMIX SEED] From: TikTok #transactioncoordinator..."
  // into content — that briefing then leaked to public IG when cron-auto-approve
  // promoted the draft after 30 min silence without any transformation step.
  //
  // Fix: put the SEED into `error_message` (misuse of column, but the only
  // free-form text field that isn't published). Content stays 'BRIEFING_PENDING'
  // — a marker that the caption-sanitizer will catch AND that clearly signals
  // to the downstream generator "you must fill this in before publish."
  // Status stays 'pending_video' (never 'draft') so cron-auto-approve won't
  // promote it — a Sage remix pass has to explicitly generate the real caption
  // and flip status to 'draft'/'approved' when it's ready.
  for (const v of (parsed.viral_posts || []).slice(0, 12)) {
    if (!v.hook) continue;
    const briefing = `[COMPETITOR REMIX SEED]\nFrom: ${v.platform}/@${v.handle}\nAngle: ${v.angle || ''}\nRemix direction: ${v.remix_direction || ''}\nOriginal URL: ${v.external_url || ''}`;
    const r = await sbFetch('social_posts', {
      method: 'POST',
      body: JSON.stringify({
        platform: v.platform || 'tiktok',
        status: 'pending_video',
        source_type: 'competitor_remix',
        competitor_source: `${v.platform}/@${v.handle}`,
        hook: (v.hook || '').slice(0, 200),
        content: 'BRIEFING_PENDING — Sage must generate the real caption before this row can be promoted to draft/approved. See error_message for the seed briefing.',
        error_message: briefing.slice(0, 2000),
        persona: 'dossie',
        requires_approval: true,
        generated_at: new Date().toISOString(),
      }),
    });
    if (r.ok) results.inserts.seed_drafts++;
  }

  // Write competitors-live.json + weekly report
  let jsonPath = null;
  let reportPath = null;
  try {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    jsonPath = path.join(REPORT_DIR, 'competitors-live.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      updated_at: new Date().toISOString(),
      week_of: payload.week_of,
      retained: parsed.retained || [],
      new_discovered: parsed.new_discovered || [],
      dormant: parsed.dormant || [],
    }, null, 2), 'utf8');

    reportPath = path.join(REPORT_DIR, `competitor-intel-weekly-${payload.week_of}.md`);
    const md = [
      `# Competitor intel — week of ${payload.week_of}`,
      ``,
      `_Generated ${new Date().toISOString()}_`,
      ``,
      `## Counts`,
      `- Retained: ${results.retained_count}`,
      `- New discovered: ${results.new_discovered_count}`,
      `- Dormant: ${results.dormant_count}`,
      `- Viral posts seeded: ${results.viral_posts_count}`,
      ``,
      `## New discovered`,
      ...(parsed.new_discovered || []).map((a) => `- ${a.platform}/@${a.handle} — ${a.why || ''}`),
      ``,
      `## Dormant (>=${payload.dormant_threshold_days}d silent)`,
      ...(parsed.dormant || []).map((a) => `- ${a.platform}/@${a.handle} (${a.days_since_post}d)`),
      ``,
      `## Viral post remixes (drafts seeded to social_posts)`,
      ...(parsed.viral_posts || []).map((v) => `- ${v.platform}/@${v.handle}: "${v.hook}" — remix: ${v.remix_direction}`),
    ].join('\n');
    fs.writeFileSync(reportPath, md, 'utf8');
  } catch (e) {
    log(`report_write_failed: ${e.message}`);
  }

  return {
    ok: true,
    summary: `Competitor scan ${payload.week_of}: +${results.inserts.competitors} new, +${results.inserts.seed_drafts} viral remixes, ${results.updates.dormant_flagged} flagged dormant.`,
    result: { ...results, json_path: jsonPath, report_path: reportPath, max_billed: true },
  };
};
