// scripts/claude-code-task-handlers/trending_audio_scan.js
//
// Daily TikTok trending-audio scan handler.
// The heavy lifting (TikTok Creative Center scrape, US pool filter, niche
// re-rank) happens inside the Claude Code CLI session — the handler just:
//   - Feeds a strict prompt
//   - Parses back the top-N sound list
//   - Upserts into public.trending_audio (unique(scanned_date, platform, sound_id))
//   - Mirrors the JSON to Shepard-Ventures/Marketing/sage/trending-audio-live.json
//
// Contract:
//   payload: {
//     scan_date: 'YYYY-MM-DD',
//     platform: 'tiktok',
//     top_n: 20,
//     niche_keywords: [ ... ]
//   }
//
// Owner: Atlas, 2026-07-08.

'use strict';

const fs = require('fs');
const path = require('path');
const { runClaude, extractJsonTail, sbFetch } = require('./_lib/claude-spawn.js');

const MIRROR_PATH = 'C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\Marketing\\sage\\trending-audio-live.json';

function buildPrompt(p) {
  return [
    `# TikTok trending audio scan — ${p.scan_date}`,
    ``,
    `You are Sage. Find today's top ${p.top_n || 20} TikTok trending sounds that would fit a Texas REALTOR / transaction-coordinator brand ("Dossie").`,
    ``,
    `## Filters`,
    `- US region.`,
    `- Sounds actively growing (not stale).`,
    `- Bias toward: relatable-workday / storytime / voiceover / trend-remix formats.`,
    `- Reject: hyper-niche gaming, K-pop fandom-only, NSFW.`,
    ``,
    `## Niche keywords to bias re-ranking`,
    p.niche_keywords ? p.niche_keywords.join(', ') : 'realtor, closing, homebuyer',
    ``,
    `## Return ONLY this JSON on the last line, no code fences`,
    ``,
    `{`,
    `  "scan_date":"${p.scan_date}",`,
    `  "sounds":[`,
    `    {"rank":1,"sound_id":"...","title":"...","artist":"...","use_count":int,"trend_score":number}`,
    `  ]`,
    `}`,
  ].join('\n');
}

module.exports = async function trendingAudioScan({ payload, task_id, log }) {
  if (!payload || !payload.scan_date) {
    return { ok: false, summary: 'scan_date required', error: 'missing_scan_date' };
  }

  log(`trending_audio_scan date=${payload.scan_date} top_n=${payload.top_n}`);
  const prompt = buildPrompt(payload);
  const runResult = await runClaude(prompt, { model: 'sonnet', timeoutMs: 10 * 60 * 1000, log });
  if (!runResult.ok) {
    return { ok: false, summary: `claude failed: ${runResult.error}`, error: runResult.error };
  }

  const parsed = extractJsonTail(runResult.raw);
  if (!parsed || !Array.isArray(parsed.sounds)) {
    return { ok: false, summary: 'json_parse_failed', error: 'json_parse_failed' };
  }

  let inserted = 0;
  const rows = [];
  for (const s of parsed.sounds.slice(0, payload.top_n || 20)) {
    if (!s.sound_id) continue;
    const row = {
      scanned_date: payload.scan_date,
      platform: payload.platform || 'tiktok',
      sound_id: String(s.sound_id).slice(0, 200),
      title: (s.title || '').slice(0, 400),
      artist: (s.artist || '').slice(0, 200),
      use_count: Number.isFinite(s.use_count) ? s.use_count : null,
      trend_score: Number.isFinite(s.trend_score) ? s.trend_score : null,
      rank: Number.isFinite(s.rank) ? s.rank : null,
    };
    const r = await sbFetch(`trending_audio?on_conflict=scanned_date,platform,sound_id`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal,resolution=merge-duplicates' },
      body: JSON.stringify(row),
    });
    if (r.ok) inserted++;
    rows.push(row);
  }

  try {
    fs.writeFileSync(MIRROR_PATH, JSON.stringify({
      updated_at: new Date().toISOString(),
      scan_date: payload.scan_date,
      platform: payload.platform || 'tiktok',
      sounds: rows,
    }, null, 2), 'utf8');
  } catch (e) {
    log(`mirror_write_failed: ${e.message}`);
  }

  return {
    ok: true,
    summary: `Trending audio ${payload.scan_date}: ${inserted}/${rows.length} sounds persisted.`,
    result: { scan_date: payload.scan_date, inserted, total: rows.length, mirror_path: MIRROR_PATH, max_billed: true },
  };
};
