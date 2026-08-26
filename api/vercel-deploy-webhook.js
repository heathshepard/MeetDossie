'use strict';

// api/vercel-deploy-webhook.js
// =============================================================================
// Vercel Serverless Function: /api/vercel-deploy-webhook
//
// WHY THIS EXISTS
//   2026-08-25 night: Heath had 7 failed Vercel deployments (mix of
//   production and preview, mostly caused by the vercel.json cron-cap/schema
//   bugs from the same session) pile up silently. Vercel DOES email
//   heath.shepard@kw.com on every failure ("Failed production/preview
//   deployment" from notifications@vercel.com) but nothing actively
//   surfaces it — he only found out by chance checking his inbox.
//
//   This is the real-time fix: a Vercel Account Webhook (Settings ->
//   Webhooks, or `vercel webhooks create`) pushes deployment.error /
//   deployment.canceled events here the moment they happen. No new cron —
//   vercel.json is at the hard 100/100 cap (pre-commit hook enforces it) and
//   this needed zero new cron slots. Webhooks are a separate Vercel
//   account-level mechanism, not a vercel.json entry.
//
//   Why webhook over polling: Vercel's REST API (GET /v6/deployments) could
//   be polled from an existing cron instead, but every existing cron here is
//   already piggybacked (see cron-agent-queue-orphan-reset.js's stale-live-
//   dispatch check, cron-agent-requests-stale-check.js) and none of them run
//   more often than every few minutes -- a poll-based approach would still
//   have a multi-minute detection lag and adds load/complexity to an
//   unrelated cron for a completely unrelated concern. A webhook fires the
//   instant the deployment fails, costs nothing, and needs no schedule.
//
// WHAT IT DOES
//   1. Verifies `x-vercel-signature` (HMAC-SHA1 of the raw body, per
//      https://vercel.com/docs/headers/request-headers#x-vercel-signature)
//      using VERCEL_DEPLOY_WEBHOOK_SECRET -- the secret Vercel showed once
//      when the webhook was created via `vercel webhooks create`.
//   2. On `deployment.error` or `deployment.canceled`: sends one Telegram
//      alert with project name, production-vs-preview target, the deploy
//      URL, the triggering commit message/branch if present in
//      payload.deployment.meta, and a direct link to the Vercel dashboard
//      deployment page (payload.links.deployment, falling back to a
//      constructed https://vercel.com/{team}/{project}/{deploymentId} URL)
//      so Heath can see the actual build error in one click.
//   3. Every other event type is acknowledged with 200 and ignored -- this
//      webhook is registered for deployment.error/deployment.canceled only,
//      but ack-and-ignore on anything unexpected keeps Vercel from retrying.
//
//   NOTE on fetching the error TEXT itself: Vercel's REST API does expose
//   `errorMessage` on GET /v13/deployments/{id}, but reading it requires a
//   Vercel API token, and this Vercel account's OAuth app is currently
//   blocked from minting new tokens ("Cannot create tokens for this app",
//   confirmed via both `vercel tokens add` and a direct
//   POST /v3/user/tokens call, 2026-08-26). Rather than store Heath's
//   full-scope personal CLI login token in a serverless function's env
//   (broad blast radius for a "read one field" need), this alert instead
//   links straight to the Vercel inspector page, which shows the exact same
//   error text in one click. Revisit if a scoped token ever becomes
//   available.
//
// AUTH
//   x-vercel-signature header (HMAC-SHA1 over raw body, verified below).
//   No CRON_SECRET involved -- this is not a cron, Vercel calls it directly.
//
// REGISTERED VIA
//   `vercel webhooks create https://meetdossie.com/api/vercel-deploy-webhook
//     --event deployment.error --event deployment.canceled
//     --project prj_JRIbNoWy9WoWUpIUHlSf0eqNKFbb`   (meet-dossie project only)
//
// OWNER
//   Atlas, 2026-08-26.

require('./_lib/telegram-gate').install('vercel-deploy-webhook');

const crypto = require('crypto');

const VERCEL_DEPLOY_WEBHOOK_SECRET = process.env.VERCEL_DEPLOY_WEBHOOK_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

// Vercel needs the raw body bytes for HMAC verification.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// HMAC-SHA1(rawBody, secret) hex, compared with x-vercel-signature.
// https://vercel.com/docs/headers/request-headers#x-vercel-signature
function verifyVercelSignature(rawBody, headerSig) {
  if (!VERCEL_DEPLOY_WEBHOOK_SECRET) {
    console.error('[vercel-deploy-webhook] VERCEL_DEPLOY_WEBHOOK_SECRET not configured — rejecting');
    return false;
  }
  if (!headerSig || typeof headerSig !== 'string') return false;
  const expected = crypto
    .createHmac('sha1', VERCEL_DEPLOY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  if (headerSig.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(headerSig), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('[vercel-deploy-webhook] TELEGRAM_BOT_TOKEN not configured — cannot alert');
    return { ok: false, error: 'no_token' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) console.error('[vercel-deploy-webhook] Telegram send failed:', JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('[vercel-deploy-webhook] Telegram send threw:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

function formatAlert(eventType, payload) {
  const deployment = (payload && payload.deployment) || {};
  const meta = deployment.meta || {};
  const target = payload && payload.target; // 'production' | 'staging' (preview) | null
  const targetLabel = target === 'production' ? 'PRODUCTION' : (target ? target.toUpperCase() : 'PREVIEW');
  const status = eventType === 'deployment.error' ? 'FAILED' : 'CANCELED';
  const project = deployment.name || (payload && payload.project && payload.project.id) || 'unknown-project';
  const deployUrl = deployment.url ? `https://${deployment.url}` : '(no url on payload)';

  const teamSlug = (payload && payload.team && payload.team.slug) || 'heathshepard-6590s-projects';
  const inspectorLink =
    (payload && payload.links && payload.links.deployment) ||
    (deployment.id ? `https://vercel.com/${teamSlug}/${project}/${deployment.id}` : null);

  const commitMsg = meta.githubCommitMessage ? String(meta.githubCommitMessage).split('\n')[0] : null;
  const branch = meta.githubCommitRef || null;

  const lines = [
    `VERCEL DEPLOY ${status} — ${targetLabel}`,
    `Project: ${project}`,
  ];
  if (branch) lines.push(`Branch: ${branch}`);
  if (commitMsg) lines.push(`Commit: ${commitMsg}`);
  lines.push(`Deployment: ${deployUrl}`);
  if (inspectorLink) lines.push(`Details/logs: ${inspectorLink}`);

  return lines.join('\n');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[vercel-deploy-webhook] Failed to read request body:', err && err.message);
    res.status(400).json({ ok: false, error: 'Could not read request body.' });
    return;
  }

  const sigHeader = req.headers['x-vercel-signature'] || '';
  if (!verifyVercelSignature(rawBody, sigHeader)) {
    console.warn('[vercel-deploy-webhook] Signature verification failed — rejecting.');
    res.status(401).json({ ok: false, error: 'Invalid signature.' });
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('[vercel-deploy-webhook] Failed to parse JSON body:', err && err.message);
    res.status(400).json({ ok: false, error: 'Invalid JSON.' });
    return;
  }

  const eventType = event.type || '';
  const payload = event.payload || {};

  console.log(`[vercel-deploy-webhook] event="${eventType}" project="${(payload.deployment || {}).name}" target="${payload.target}"`);

  if (eventType !== 'deployment.error' && eventType !== 'deployment.canceled') {
    // Registered for these two only, but ack anything else so Vercel
    // doesn't treat an unexpected event type as a delivery failure.
    res.status(200).json({ ok: true, note: `ignored event type ${eventType}` });
    return;
  }

  const text = formatAlert(eventType, payload);
  const tgResult = await tg(text);

  res.status(200).json({ ok: true, alerted: !!tgResult.ok, telegram: tgResult.ok ? { message_id: tgResult.result && tgResult.result.message_id } : tgResult });
};
