'use strict';

// Vercel Serverless Function: /api/cron-content-pipeline-promote
// Finds content_pipeline_queue rows Heath approved via Telegram
// (status='approved', no promote task assigned yet) and enqueues a REAL
// atlas agent_queue task to do the actual promotion: write json_data into
// marketing/<type>-data/<slug>.json, run the matching build-*.js script, and
// git commit+push to staging. This Vercel function has no git/repo-write
// access itself -- that work happens on Heath's PC via
// scripts/agent-queue-poller.js, same as every other real file/git change in
// this pipeline. See docs/CONTENT-PIPELINE.md.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json -- "*/20 * * * *"
//
// Owner: Atlas, 2026-08-11 (SV-ENG-NIGHTLY-CONTENT-PIPELINE)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_PER_RUN = 5;

const BUILD_SCRIPT_BY_TYPE = {
  guide: 'scripts/build-guides.js',
  feature: 'scripts/build-features.js',
  answer: 'scripts/build-answers.js',
};
const DATA_DIR_BY_TYPE = {
  guide: 'marketing/guides-data',
  feature: 'marketing/features-data',
  answer: 'marketing/answers-data',
};

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function buildPromoteBrief(row) {
  const dataDir = DATA_DIR_BY_TYPE[row.page_type];
  const buildScript = BUILD_SCRIPT_BY_TYPE[row.page_type];
  const filePath = `${dataDir}/${row.slug}.json`;

  return [
    `# Nightly Content Pipeline -- PROMOTE ${row.page_type}: ${row.slug}`,
    '',
    `Heath approved this page via Telegram. Your job is ONLY to land it -- do not re-review content quality (that already happened in the review Telegram message).`,
    '',
    `**CONTENT_PIPELINE_ID:** ${row.id}`,
    '',
    `## Steps`,
    '',
    `1. Write the exact JSON below to \`${filePath}\` (create the file, pretty-printed).`,
    `2. Run \`node ${buildScript}\` from the repo root -- this regenerates the static HTML page(s), the hub index, and sitemap.xml.`,
    `3. \`git add\` the new JSON file, the generated HTML output, and sitemap.xml. Commit with a message like \`feat(${row.page_type === 'guide' ? 'guides' : row.page_type === 'feature' ? 'features' : 'answers'}): add ${row.slug} (nightly content pipeline)\`.`,
    `4. Push to \`staging\` (you should already be on staging or can checkout/switch -- do not push to main).`,
    `5. Confirm via:`,
    '',
    '```',
    'curl -X POST "https://meetdossie.com/api/content-pipeline-submit" \\',
    '  -H "Authorization: Bearer $CRON_SECRET" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"content_pipeline_id":"${row.id}","status":"promoted","commit_sha":"<the commit sha you just pushed>"}'`,
    '```',
    '',
    'If ANY step fails (file write, build script error, git push rejected), do NOT leave the repo in a broken state -- fix it or revert your local changes, then submit `{"content_pipeline_id":"' + row.id + '","status":"failed","error":"<what broke>"}` instead. Never push a broken build.',
    '',
    `## The JSON to write`,
    '',
    '```json',
    JSON.stringify(row.json_data, null, 2),
    '```',
    '',
    `## Reporting`,
    '',
    'End your final message with `RESULT_SUMMARY: Promoted <slug> to staging, commit <sha>.` or `RESULT_SUMMARY: BLOCKED: <reason>` if you had to submit status=failed.',
  ].join('\n');
}

module.exports = withTelemetry('cron-content-pipeline-promote', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const { data: rows, ok: loadOk } = await sb(
    `content_pipeline_queue?status=eq.approved&promote_task_id=is.null&order=reviewed_at.asc&limit=${MAX_PER_RUN}`
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load content_pipeline_queue' });
  }
  const items = Array.isArray(rows) ? rows : [];

  const promoted = [];
  const errors = [];

  for (const row of items) {
    if (!row.slug || !row.json_data) {
      console.error('[cron-content-pipeline-promote] row', row.id, 'missing slug or json_data — marking failed');
      await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed', error: 'approved_row_missing_slug_or_json_data' }),
      }).catch(() => {});
      errors.push({ id: row.id, error: 'missing_slug_or_json_data' });
      continue;
    }

    const brief = buildPromoteBrief(row);
    const insertTask = await sb('agent_queue', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_name: 'atlas',
        task_subject: `Nightly content pipeline: PROMOTE ${row.page_type} ${row.slug}`.slice(0, 280),
        task_brief: brief,
        priority: 3,
        venture: 'dossie',
        status: 'pending',
        metadata: {
          source: 'cron-content-pipeline-promote',
          content_pipeline_id: row.id,
          page_type: row.page_type,
          slug: row.slug,
          enqueued_at: new Date().toISOString(),
        },
      }),
    });
    if (!insertTask.ok || !Array.isArray(insertTask.data) || !insertTask.data[0]) {
      console.error('[cron-content-pipeline-promote] agent_queue insert failed for', row.id, insertTask.status);
      errors.push({ id: row.id, error: 'agent_queue_insert_failed' });
      continue;
    }
    const taskRow = insertTask.data[0];

    await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ promote_task_id: taskRow.id }),
    }).catch((err) => console.warn('[cron-content-pipeline-promote] link patch failed (non-fatal):', err && err.message));

    promoted.push({ content_pipeline_id: row.id, agent_queue_id: taskRow.id, slug: row.slug, page_type: row.page_type });
  }

  console.log('[cron-content-pipeline-promote] done — queued', promoted.length, 'of', items.length, 'errors:', errors.length);
  return res.status(200).json({ ok: true, queued: promoted, total: items.length, errors });
});
