// scripts/claude-code-task-handlers/sage_weekly_review.js
//
// Handler for the weekly Sage post-review loop.
// Reads last-7d post_analytics via payload, ranks hook_type / cta_type /
// hook_variant / sounds, writes:
//   - a markdown report to Shepard-Ventures/Marketing/sage/
//     weekly-review-YYYY-MM-DD.md
//   - a row into public.sage_weekly_reviews
//
// Contract:
//   payload: {
//     week_start:   'YYYY-MM-DD',
//     week_end:     'YYYY-MM-DD',
//     posts_analyzed: int,
//     rows: [ post_analytics row, ... ]
//   }
//
// Owner: Atlas, 2026-07-08.

'use strict';

const fs = require('fs');
const path = require('path');
const { runClaude, extractJsonTail, sbFetch } = require('./_lib/claude-spawn.js');

const REPORT_DIR = 'C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\Marketing\\sage';

function bucket(rows, field) {
  const map = new Map();
  for (const r of rows) {
    const k = (r && r[field]) ? String(r[field]) : 'unknown';
    const cur = map.get(k) || { key: k, n: 0, sum_er: 0, sum_score: 0, sum_likes: 0 };
    cur.n += 1;
    cur.sum_er += Number(r.engagement_rate || 0);
    cur.sum_score += Number(r.engagement_score || 0);
    cur.sum_likes += Number(r.likes || 0);
    map.set(k, cur);
  }
  return [...map.values()]
    .map((x) => ({ ...x, avg_er: x.sum_er / (x.n || 1), avg_score: x.sum_score / (x.n || 1) }))
    .sort((a, b) => b.avg_score - a.avg_score);
}

function buildPrompt(payload, buckets) {
  return [
    `# Sage Weekly Review — ${payload.week_start}..${payload.week_end}`,
    ``,
    `You are Sage, Dossie's head of social. Analyze the last 7 days of post analytics.`,
    ``,
    `## Volume`,
    `- Posts analyzed: ${payload.posts_analyzed}`,
    ``,
    `## Hook type ranking (top 6 by avg engagement_score)`,
    ...buckets.hook_type.slice(0, 6).map((b) => `- ${b.key}: n=${b.n}, avg_score=${Math.round(b.avg_score)}, avg_er=${b.avg_er.toFixed(3)}`),
    ``,
    `## CTA type ranking`,
    ...buckets.cta_type.slice(0, 6).map((b) => `- ${b.key}: n=${b.n}, avg_score=${Math.round(b.avg_score)}, avg_er=${b.avg_er.toFixed(3)}`),
    ``,
    `## Hook variant (A/B) ranking`,
    ...buckets.hook_variant.slice(0, 6).map((b) => `- ${b.key}: n=${b.n}, avg_score=${Math.round(b.avg_score)}, avg_er=${b.avg_er.toFixed(3)}`),
    ``,
    `## Trending sounds used`,
    ...buckets.sound_title.slice(0, 6).map((b) => `- ${b.key}: n=${b.n}, avg_score=${Math.round(b.avg_score)}`),
    ``,
    `## Task`,
    `Return ONLY this JSON on the last line — no code fences.`,
    ``,
    `{`,
    `  "top_hooks": [{"hook_type":"...","why_it_won":"one line"}, ...],`,
    `  "top_ctas":  [{"cta_type":"...","why_it_won":"one line"}, ...],`,
    `  "top_sounds":[{"sound_title":"...","why_it_won":"one line"}, ...],`,
    `  "ab_verdicts":[{"variant":"A|B","verdict":"win|loss|inconclusive","confidence":"low|med|high"}],`,
    `  "recommendations":"3-6 sentences of exactly what Sage should double down on in next batch — plain prose, no bullet chars."`,
    `}`,
  ].join('\n');
}

module.exports = async function sageWeeklyReview({ payload, task_id, log }) {
  if (!payload || !Array.isArray(payload.rows)) {
    return { ok: false, summary: 'payload.rows required', error: 'missing_rows' };
  }

  const rows = payload.rows;
  const buckets = {
    hook_type:    bucket(rows, 'hook_type'),
    cta_type:     bucket(rows, 'cta_type'),
    hook_variant: bucket(rows, 'hook_variant'),
    sound_title:  bucket(rows, 'sound_title'),
  };

  log(`sage_weekly_review analyzing ${rows.length} rows`);
  const prompt = buildPrompt(payload, buckets);
  const runResult = await runClaude(prompt, { model: 'sonnet', timeoutMs: 5 * 60 * 1000, log });
  if (!runResult.ok) {
    return { ok: false, summary: `claude failed: ${runResult.error}`, error: runResult.error };
  }

  const parsed = extractJsonTail(runResult.raw);
  if (!parsed) {
    return { ok: false, summary: 'json_parse_failed', error: 'json_parse_failed' };
  }

  // Write the markdown report.
  const md = [
    `# Sage Weekly Review — ${payload.week_start} to ${payload.week_end}`,
    ``,
    `_Generated ${new Date().toISOString()} — Claude Code CLI worker (Max-billed)._`,
    ``,
    `## Volume`,
    `- Posts analyzed: **${rows.length}**`,
    ``,
    `## Winners`,
    ``,
    `### Top hook types`,
    ...(parsed.top_hooks || []).map((h) => `- **${h.hook_type}** — ${h.why_it_won}`),
    ``,
    `### Top CTAs`,
    ...(parsed.top_ctas || []).map((c) => `- **${c.cta_type}** — ${c.why_it_won}`),
    ``,
    `### Top sounds`,
    ...(parsed.top_sounds || []).map((s) => `- **${s.sound_title}** — ${s.why_it_won}`),
    ``,
    `### A/B verdicts`,
    ...(parsed.ab_verdicts || []).map((v) => `- ${v.variant}: ${v.verdict} (${v.confidence})`),
    ``,
    `## Recommendations`,
    ``,
    parsed.recommendations || '',
    ``,
    `## Raw ranking snapshot`,
    ``,
    `### Hook type buckets`,
    ...buckets.hook_type.slice(0, 10).map((b) => `- ${b.key}: n=${b.n}, avg_score=${Math.round(b.avg_score)}`),
    ``,
    `### CTA buckets`,
    ...buckets.cta_type.slice(0, 10).map((b) => `- ${b.key}: n=${b.n}, avg_score=${Math.round(b.avg_score)}`),
    ``,
  ].join('\n');

  let reportPath = null;
  try {
    if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
    reportPath = path.join(REPORT_DIR, `weekly-review-${payload.week_start}.md`);
    fs.writeFileSync(reportPath, md, 'utf8');
  } catch (e) {
    log(`report_write_failed: ${e.message}`);
  }

  // Persist the DB row.
  const ins = await sbFetch('sage_weekly_reviews', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify({
      week_start: payload.week_start,
      week_end:   payload.week_end,
      posts_analyzed: rows.length,
      top_hooks:  parsed.top_hooks  || [],
      top_ctas:   parsed.top_ctas   || [],
      top_sounds: parsed.top_sounds || [],
      ab_verdicts: parsed.ab_verdicts || [],
      recommendations: parsed.recommendations || '',
      report_path: reportPath,
    }),
  });

  return {
    ok: true,
    summary: `Sage weekly review shipped for ${payload.week_start}..${payload.week_end} (n=${rows.length}). Report: ${reportPath || 'db_only'}.`,
    result: {
      week_start: payload.week_start,
      week_end: payload.week_end,
      report_path: reportPath,
      row_inserted: ins.ok,
      buckets_top: {
        hook_type: buckets.hook_type.slice(0, 3),
        cta_type: buckets.cta_type.slice(0, 3),
        hook_variant: buckets.hook_variant.slice(0, 3),
      },
      max_billed: true,
    },
  };
};
