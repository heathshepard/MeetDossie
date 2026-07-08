'use strict';

// api/cron-trending-audio-scan.js
// =============================================================================
// Daily TikTok trending-audio scanner.
// Fires 5am CDT (10 UTC). Delegates the actual scrape/curation to the Claude
// Code CLI worker (task_type='trending_audio_scan') so we spend zero Anthropic
// API tokens on it. Worker persists top-20 sounds into public.trending_audio
// AND mirrors the JSON to Shepard-Ventures/Marketing/sage/trending-audio-live.json
// for Sage's remix generator.
//
// Cron entry ONLY schedules + enqueues. Actual scraping logic lives in the
// handler (script accesses TikTok's public trending feed / creative-center;
// endpoint TBD by handler — this cron shouldn't care).
//
// Schedule: "0 10 * * *".
// Owner: Atlas 2026-07-08.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;

async function enqueueClaudeCodeTask(host, body) {
  const res = await fetch(`${host}/api/claude-code-enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const dateIso = new Date().toISOString().slice(0, 10);
  const host = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

  const enq = await enqueueClaudeCodeTask(host, {
    task_type: 'trending_audio_scan',
    agent_name: 'sage',
    priority: 3,
    title: `TikTok trending audio ${dateIso}`,
    description: 'Scrape top-20 REALTOR-adjacent trending sounds; write to public.trending_audio + JSON mirror.',
    idempotency_key: `trending_audio_scan:${dateIso}`,
    payload: {
      scan_date: dateIso,
      platform: 'tiktok',
      top_n: 20,
      niche_keywords: [
        'realtor', 'real estate', 'house', 'closing', 'homebuyer',
        'first time home buyer', 'texas', 'new home', 'mortgage',
      ],
    },
  });

  if (!enq.ok) {
    return res.status(502).json({ ok: false, error: 'enqueue_failed', detail: enq.data });
  }

  return res.status(200).json({
    ok: true,
    scan_date: dateIso,
    queue_id: enq.data && enq.data.queue_id,
  });
}

module.exports = withTelemetry('cron-trending-audio-scan', handler);
