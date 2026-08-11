'use strict';

// Vercel Serverless Function: /api/cron-generate-pages
// Nightly kickoff for the content-page pipeline (guides/features/answers).
// Runs once per night inside Heath's 11pm-6am CDT window, picks 2-4 genuinely
// new topics, and enqueues REAL agent_queue tasks (real Claude Code sessions
// via scripts/agent-queue-poller.js, same mechanism verified working for
// Jarvis) to research + write them. This function itself does NOT generate
// any content and NEVER writes to marketing/*-data/ -- see
// docs/CONTENT-PIPELINE.md for the full flow.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json -- "30 5 * * *" (05:30 UTC = 12:30am CDT / 11:30pm CST,
// well inside the 11pm-6am CDT window both sides of the DST boundary).
//
// Owner: Atlas, 2026-08-11 (SV-ENG-NIGHTLY-CONTENT-PIPELINE)

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { loadExistingPages, pickNextCandidate } = require('./_lib/content-pipeline-topics.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Safety cap: modest volume, not a flood. Composition tries one candidate per
// type in this order, capped at MAX_PAGES_PER_NIGHT total inserts.
const MAX_PAGES_PER_NIGHT = Math.max(1, Math.min(4, parseInt(process.env.CONTENT_PIPELINE_MAX_PAGES || '3', 10)));
const TYPE_ORDER = (process.env.CONTENT_PIPELINE_TYPES || 'guide,answer,feature')
  .split(',').map((s) => s.trim()).filter(Boolean);

const AGENT_BY_TYPE = { guide: 'hadley', answer: 'hadley', feature: 'carter' };

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

async function telegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[cron-generate-pages] telegram alert failed:', err && err.message);
  }
}

function buildTaskBrief({ pageType, candidate, contentPipelineId, existingPages, nightBatchId }) {
  const existingList = existingPages.map((p) => `- ${p.slug} -- ${p.title}`).join('\n');
  const schemaNote = pageType === 'feature'
    ? 'Feature JSON schema + the mandatory real-screenshot requirement are in docs/CONTENT-PIPELINE.md ("Feature JSON schema" section).'
    : `${pageType === 'guide' ? 'Guide' : 'Answer'} JSON schema is in docs/CONTENT-PIPELINE.md ("${pageType === 'guide' ? 'Guide' : 'Answer'} JSON schema" section).`;

  return [
    `# Nightly Content Pipeline -- ${pageType} page`,
    '',
    `**CONTENT_PIPELINE_ID:** ${contentPipelineId}`,
    `**Night batch:** ${nightBatchId}`,
    `**Page type:** ${pageType}`,
    '',
    `## Proposed topic`,
    '',
    candidate.topic,
    '',
    `## Research starting point (verify, don't trust)`,
    '',
    candidate.hint,
    '',
    `## Step 1 -- read the contract`,
    '',
    'Read docs/CONTENT-PIPELINE.md in full before doing anything else. ' + schemaNote,
    '',
    `## Step 2 -- verify the topic is real and not already covered`,
    '',
    `Every page already live under this page_type (do NOT produce anything that duplicates or near-duplicates one of these):`,
    '',
    existingList || '(none yet)',
    '',
    'If the proposed topic turns out to be non-existent, not real, already effectively covered by one of the above, or (for a feature) not actually built and live in the real product: STOP. Do not write a page. Instead POST {content_pipeline_id, status:"failed", error:"<why>"} to /api/content-pipeline-submit and end your final message with `RESULT_SUMMARY: BLOCKED: <reason>`.',
    '',
    `## Step 3 -- research with primary sources`,
    '',
    'TREC forms: verify the CURRENT form number and text directly on trec.texas.gov -- forms get renumbered, do not rely on memory. Texas statutes: statutes.capitol.texas.gov. Every specific claim (form number, paragraph number, statute cite, dollar figure, deadline) must trace to something you actually read this session, not recalled from training. This mirrors the Hadley fact-verification pass used on every guide built earlier tonight.',
    '',
    `## Step 4 -- write the page + submit`,
    '',
    'Build the full JSON payload matching the exact schema in docs/CONTENT-PIPELINE.md, collect every source you actually used with real URLs, write a 2-4 sentence plain-text excerpt, then submit:',
    '',
    '```',
    'curl -X POST "https://meetdossie.com/api/content-pipeline-submit" \\',
    '  -H "Authorization: Bearer $CRON_SECRET" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '{"content_pipeline_id":"${contentPipelineId}","status":"pending_review","slug":"<final-slug>","json_data":{...},"sources":[{"label":"...","url":"..."}],"excerpt":"..."}'`,
    '```',
    '',
    'CRON_SECRET is already in your environment -- reference it by name, never print or log the literal value.',
    '',
    `## Reporting`,
    '',
    'After a successful submit, end your final message with: `RESULT_SUMMARY: Generated <page_type> page "<title>" at content_pipeline_id <id>, submitted for review.`',
    'If BLOCKED, end with `RESULT_SUMMARY: BLOCKED: <one-sentence reason>` as described in Step 2.',
  ].join('\n');
}

module.exports = withTelemetry('cron-generate-pages', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const nightBatchId = `nightly-${todayIso}`;

  const generated = [];
  const skipped = [];

  for (const pageType of TYPE_ORDER) {
    if (generated.length >= MAX_PAGES_PER_NIGHT) break;
    if (!AGENT_BY_TYPE[pageType]) { skipped.push({ pageType, reason: 'unknown_page_type' }); continue; }

    let existingPages, claimedRows;
    try {
      existingPages = loadExistingPages(pageType);
    } catch (err) {
      console.error(`[cron-generate-pages] loadExistingPages(${pageType}) failed:`, err && err.message);
      skipped.push({ pageType, reason: 'existing_page_scan_failed' });
      continue;
    }

    const claimed = await sb(`content_pipeline_queue?page_type=eq.${pageType}&select=slug,topic`);
    claimedRows = (claimed.ok && Array.isArray(claimed.data)) ? claimed.data : [];

    const candidate = pickNextCandidate(pageType, claimedRows, existingPages);
    if (!candidate) {
      skipped.push({ pageType, reason: 'no_unclaimed_candidates' });
      continue;
    }

    // 1. Insert the pending-review-zone row.
    const insertQueue = await sb('content_pipeline_queue', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        night_batch_id: nightBatchId,
        page_type: pageType,
        topic: candidate.topic,
        status: 'researching',
      }),
    });
    if (!insertQueue.ok || !Array.isArray(insertQueue.data) || !insertQueue.data[0]) {
      console.error(`[cron-generate-pages] content_pipeline_queue insert failed for ${pageType}:`, insertQueue.status, JSON.stringify(insertQueue.data).slice(0, 300));
      skipped.push({ pageType, reason: 'queue_insert_failed' });
      continue;
    }
    const queueRow = insertQueue.data[0];

    // 2. Insert the real agent_queue task that does the actual research/writing.
    const agentName = AGENT_BY_TYPE[pageType];
    const taskBrief = buildTaskBrief({
      pageType, candidate, contentPipelineId: queueRow.id, existingPages, nightBatchId,
    });
    const insertAgentTask = await sb('agent_queue', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_name: agentName,
        task_subject: `Nightly content pipeline: ${pageType} -- ${candidate.topic}`.slice(0, 280),
        task_brief: taskBrief,
        priority: 4,
        venture: 'dossie',
        status: 'pending',
        metadata: {
          source: 'cron-generate-pages',
          content_pipeline_id: queueRow.id,
          night_batch_id: nightBatchId,
          page_type: pageType,
          enqueued_at: new Date().toISOString(),
        },
      }),
    });
    if (!insertAgentTask.ok || !Array.isArray(insertAgentTask.data) || !insertAgentTask.data[0]) {
      console.error(`[cron-generate-pages] agent_queue insert failed for ${pageType}:`, insertAgentTask.status, JSON.stringify(insertAgentTask.data).slice(0, 300));
      // Roll the queue row to failed so it's not silently stuck in
      // 'researching' forever with no task ever assigned.
      await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(queueRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'failed', error: 'agent_queue_insert_failed' }),
      }).catch(() => {});
      skipped.push({ pageType, reason: 'agent_queue_insert_failed' });
      continue;
    }
    const taskRow = insertAgentTask.data[0];

    // 3. Link the two rows.
    await sb(`content_pipeline_queue?id=eq.${encodeURIComponent(queueRow.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ generation_task_id: taskRow.id }),
    }).catch((err) => console.warn('[cron-generate-pages] link patch failed (non-fatal):', err && err.message));

    generated.push({
      page_type: pageType,
      content_pipeline_id: queueRow.id,
      agent_queue_id: taskRow.id,
      agent: agentName,
      topic: candidate.topic,
      slug_target: candidate.slug,
    });
  }

  if (generated.length === 0) {
    console.warn('[cron-generate-pages] 0 pages generated tonight — sending alert with skip reasons:', JSON.stringify(skipped));
    await telegramAlert(
      `NIGHTLY CONTENT PIPELINE: 0 pages queued for ${nightBatchId}.\n` +
      skipped.map((s) => `- ${s.pageType}: ${s.reason}`).join('\n') +
      '\nCheck api/_lib/content-pipeline-topics.js candidate lists — may need new topics added.'
    );
  } else {
    console.log(`[cron-generate-pages] ${nightBatchId}: enqueued ${generated.length} page(s)`, JSON.stringify(generated.map((g) => `${g.page_type}:${g.slug_target}`)));
  }

  return res.status(200).json({ ok: true, night_batch_id: nightBatchId, generated, skipped });
});
