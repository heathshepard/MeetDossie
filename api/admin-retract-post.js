// Vercel Serverless Function: /api/admin-retract-post
//
// THE RETRACTION PATH. Takes an already-published post back down and records
// why, on the row, so nothing re-publishes it.
//
// WHY THIS EXISTS (Atlas 2026-09-25): the pipeline could publish but not
// retract. Heath rejected a live YouTube video and there was no route, no
// column, and no record anywhere that could pull it back. Publishing to a
// public channel without a retraction path is a one-way door — and because
// ops_flags.batch_routine_approvals has been letting videos reach
// pending_heath_review without ever sending an approve card, content can
// reach a real channel without his eyes on it. This is the safety net.
//
// Auth:   Authorization: Bearer ${CRON_SECRET}   (never exposed publicly)
// Method: POST
//
// Body — identify the target one of three ways:
//   { "videoLibraryId": "dossie-...-2026-09-18" }      preferred
//   { "postUrl": "https://www.youtube.com/watch?v=..." }
//   { "zernioPostId": "6ab...", "platform": "youtube" }  raw escape hatch
// Options:
//   reason      string  why it's being pulled (recorded on the row)
//   retractedBy string  who ordered it (default "heath")
//   platforms   array   limit to these platforms (default: all delivered)
//   hardDelete  bool    YouTube only — permanently DELETE instead of
//                       flipping to private. Irreversible, loses analytics.
//   dryRun      bool    resolve + report the plan, change nothing
//
// ─── WHAT ZERNIO ACTUALLY SUPPORTS ────────────────────────────────────────
// Verified 2026-09-25 against docs.zernio.com/llms-full.txt (the rendered
// docs 404 on openapi.json/.yaml — they return HTML; llms-full.txt is the
// real spec dump).
//
//   POST /v1/posts/{postId}/update-metadata
//     YouTube ONLY. Accepts privacyStatus: public|private|unlisted.
//     Reversible, keeps the video and its analytics.
//
//   POST|DELETE /v1/posts/{postId}/unpublish   body { platform }
//     Deletes the published post FROM the platform; the Zernio record
//     survives with status 'cancelled' ('partial' if some platform copies
//     remain). Supported: threads, facebook, twitter, linkedin, youtube,
//     pinterest, reddit, bluesky, googlebusiness, telegram.
//     NOT supported: instagram, tiktok, snapchat.
//     On YouTube this is a PERMANENT DELETE — which is exactly why YouTube
//     defaults to the privacy flip here and only takes this path on
//     hardDelete: true.
//
//   DELETE /v1/posts/{postId}  — refuses a published post with 400. It only
//     removes the Zernio record, so it is never a retraction and is not used.
//
// Instagram / TikTok / Snapchat have NO retraction API. For those this route
// returns manual_steps and reports ok:false for that platform — it never
// reports success for a post that is still live.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const ZERNIO_BASE = 'https://zernio.com/api/v1';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Platforms Zernio's unpublish endpoint accepts.
const UNPUBLISHABLE = new Set([
  'threads', 'facebook', 'twitter', 'linkedin', 'youtube',
  'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'telegram',
]);

// Platforms with no retraction API at all — manual only.
const MANUAL_ONLY = {
  instagram: [
    'Open the Instagram app (the account that published this).',
    'Go to your profile and find the post/Reel.',
    'Tap the ... menu on the post.',
    'Tap Archive to hide it reversibly (preferred — keeps insights), or Delete to remove it permanently.',
  ],
  tiktok: [
    'Open the TikTok app (the account that published this).',
    'Go to your profile and find the video.',
    'Tap the ... menu on the video.',
    'Tap Privacy settings > Only me to hide it reversibly (preferred), or Delete to remove it.',
  ],
  snapchat: [
    'Open Snapchat on the publishing account.',
    'Find the Spotlight/Story post and delete it from the app.',
  ],
};

// The status a retracted row lands on. 'rejected' is an already-established
// video_library value, so no existing consumer has to learn a new one, and
// every publish-path query filters on a positive status=eq.<value>
// ('approved' / 'heath_approved' / 'ready' / 'pending_*') — so this excludes
// the row from all of them. retracted_at is what distinguishes "pulled after
// it went live" from "rejected before it ever shipped".
const RETRACTED_STATUS = 'rejected';

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function zernio(path, init = {}) {
  const res = await fetch(`${ZERNIO_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 600) : '' };
}

async function notifyTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch { /* notification is best-effort, never fails the retraction */ }
}

// Pull the per-platform delivery records off a video_library row.
function deliveriesOf(row) {
  const d = row && row.zernio_deliveries;
  if (!Array.isArray(d)) return [];
  return d.filter((e) => e && e.platform);
}

// Resolve the target row from any of the three input shapes.
async function resolveTarget(body) {
  const select = 'id,status,topic,caption,platforms,posted_date,zernio_deliveries,target_owner';

  if (body.videoLibraryId) {
    const r = await sb(`/rest/v1/video_library?id=eq.${encodeURIComponent(body.videoLibraryId)}&select=${select}`);
    if (!r.ok) return { error: `video_library read failed (${r.status})`, detail: r.data };
    if (!Array.isArray(r.data) || !r.data.length) {
      return { error: `no video_library row with id ${body.videoLibraryId}` };
    }
    return { row: r.data[0] };
  }

  if (body.postUrl) {
    const url = String(body.postUrl);
    // Scan rows that actually carry delivery records. zernio_deliveries is a
    // jsonb array, so match in JS rather than contorting a PostgREST filter.
    const r = await sb(`/rest/v1/video_library?zernio_deliveries=neq.[]&select=${select}&order=posted_date.desc&limit=500`);
    if (!r.ok) return { error: `video_library read failed (${r.status})`, detail: r.data };
    const rows = Array.isArray(r.data) ? r.data : [];
    const hit = rows.find((row) => deliveriesOf(row).some((d) => {
      const pu = d.platform_url || '';
      if (!pu) return false;
      if (pu === url) return true;
      // Tolerate youtu.be vs watch?v= and trailing junk by comparing ids.
      const idOf = (s) => (s.match(/(?:v=|youtu\.be\/|\/shorts\/)([A-Za-z0-9_-]{6,})/) || [])[1];
      const a = idOf(pu); const b = idOf(url);
      return !!a && a === b;
    }));
    if (!hit) return { error: `no video_library row has a delivery matching ${url}` };
    return { row: hit };
  }

  if (body.zernioPostId && body.platform) {
    // Raw escape hatch: act on Zernio directly with no row to update.
    return { row: null, raw: { zernioPostId: String(body.zernioPostId), platform: String(body.platform) } };
  }

  return { error: 'one of videoLibraryId, postUrl, or (zernioPostId + platform) is required' };
}

// Retract a single platform copy. Returns a structured, honest result —
// ok:false whenever the post is still live.
async function retractOne({ platform, zernioPostId, platformUrl, hardDelete }) {
  const base = { platform, zernio_post_id: zernioPostId || null, platform_url: platformUrl || null };

  if (MANUAL_ONLY[platform]) {
    return {
      ...base,
      ok: false,
      method: 'manual',
      retractable_via_api: false,
      still_live: true,
      error: `${platform} has no retraction API (Zernio's unpublish explicitly excludes it)`,
      manual_steps: MANUAL_ONLY[platform],
    };
  }

  if (!zernioPostId) {
    return {
      ...base,
      ok: false,
      method: 'none',
      still_live: true,
      error: 'no zernio_post_id recorded for this platform — cannot retract via API',
      manual_steps: [`Open the ${platform} account and remove the post manually${platformUrl ? `: ${platformUrl}` : ''}.`],
    };
  }

  // YouTube: default to the reversible privacy flip. Zernio's unpublish on
  // YouTube is a PERMANENT delete, so it is opt-in only.
  if (platform === 'youtube' && !hardDelete) {
    const r = await zernio(`/posts/${encodeURIComponent(zernioPostId)}/update-metadata`, {
      method: 'POST',
      body: JSON.stringify({ platform: 'youtube', privacyStatus: 'private' }),
    });
    return {
      ...base,
      ok: r.ok,
      method: 'youtube_privacy_private',
      reversible: true,
      still_live: !r.ok,
      zernio_status: r.status,
      zernio_response: r.data || r.raw,
      note: 'Video set to private: no longer publicly viewable, asset and analytics retained, reversible by setting privacyStatus back to public.',
      ...(r.ok ? {} : { manual_steps: [
        'Open YouTube Studio > Content on the publishing channel.',
        'Find the video, open the Visibility column, set it to Private, and save.',
      ] }),
    };
  }

  if (UNPUBLISHABLE.has(platform)) {
    const r = await zernio(`/posts/${encodeURIComponent(zernioPostId)}/unpublish`, {
      method: 'POST',
      body: JSON.stringify({ platform }),
    });
    return {
      ...base,
      ok: r.ok,
      method: 'zernio_unpublish',
      reversible: false,
      still_live: !r.ok,
      zernio_status: r.status,
      zernio_response: r.data || r.raw,
      note: platform === 'youtube'
        ? 'HARD DELETE: the YouTube video is permanently removed. Not reversible.'
        : 'Post removed from the platform. Zernio keeps its record (status cancelled/partial).',
      ...(r.ok ? {} : { manual_steps: [`Open the ${platform} account and delete the post manually${platformUrl ? `: ${platformUrl}` : ''}.`] }),
    };
  }

  return {
    ...base,
    ok: false,
    method: 'unsupported',
    retractable_via_api: false,
    still_live: true,
    error: `platform "${platform}" is not in Zernio's unpublish list and has no known retraction API`,
    manual_steps: [`Open the ${platform} account and remove the post manually${platformUrl ? `: ${platformUrl}` : ''}.`],
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!ZERNIO_API_KEY || ZERNIO_API_KEY === '[SENSITIVE]') {
    return res.status(500).json({
      ok: false,
      error: 'ZERNIO_API_KEY not usable in this environment (Sensitive var reads back as [SENSITIVE] outside a deployment)',
    });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const {
    reason = null,
    retractedBy = 'heath',
    hardDelete = false,
    dryRun = false,
  } = body;

  const resolved = await resolveTarget(body);
  if (resolved.error) return res.status(400).json({ ok: false, error: resolved.error, detail: resolved.detail });

  const row = resolved.row;

  // Build the list of platform copies to act on.
  let targets;
  if (resolved.raw) {
    targets = [{ platform: resolved.raw.platform, zernioPostId: resolved.raw.zernioPostId, platformUrl: null }];
  } else {
    const delivered = deliveriesOf(row);
    targets = delivered.map((d) => ({
      platform: d.platform,
      zernioPostId: d.zernio_post_id || null,
      platformUrl: d.platform_url || null,
    }));
    // A row can claim platforms it never actually delivered to (capped,
    // skipped, or failed). Only the recorded deliveries are real published
    // copies — surface the rest instead of silently ignoring them.
    const deliveredSet = new Set(targets.map((t) => t.platform));
    const claimedNotDelivered = (row.platforms || []).filter((p) => !deliveredSet.has(p));
    if (Array.isArray(body.platforms) && body.platforms.length) {
      const want = new Set(body.platforms);
      targets = targets.filter((t) => want.has(t.platform));
    }
    resolved.claimedNotDelivered = claimedNotDelivered;
  }

  if (!targets.length) {
    return res.status(400).json({
      ok: false,
      error: 'no delivered platform copies found to retract',
      row_id: row ? row.id : null,
      claimed_platforms: row ? row.platforms : null,
      hint: 'zernio_deliveries is empty for this row — nothing was recorded as actually published. Verify in the Zernio dashboard before assuming it is live.',
    });
  }

  if (dryRun) {
    return res.status(200).json({
      ok: true,
      dry_run: true,
      row_id: row ? row.id : null,
      would_retract: targets.map((t) => ({
        platform: t.platform,
        platform_url: t.platformUrl,
        method: MANUAL_ONLY[t.platform] ? 'manual'
          : (t.platform === 'youtube' && !hardDelete) ? 'youtube_privacy_private'
            : UNPUBLISHABLE.has(t.platform) ? 'zernio_unpublish' : 'unsupported',
      })),
      claimed_not_delivered: resolved.claimedNotDelivered || [],
      would_set_status: RETRACTED_STATUS,
    });
  }

  const results = [];
  for (const t of targets) {
    results.push(await retractOne({ ...t, hardDelete }));
  }

  const allOk = results.every((r) => r.ok);
  const stillLive = results.filter((r) => r.still_live);

  // Record the retraction on the row. Status moves regardless of whether
  // every platform succeeded — the intent is on record either way, and a row
  // that is half-retracted must never re-publish.
  let rowUpdate = null;
  let auditColumnsMissing = false;
  if (row) {
    const nowIso = new Date().toISOString();
    const full = {
      status: RETRACTED_STATUS,
      retracted_at: nowIso,
      retracted_by: retractedBy,
      retraction_reason: reason,
      retraction_detail: results,
    };
    let r = await sb(`/rest/v1/video_library?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(full),
    });
    // Degrade gracefully if 20260925_video_library_retraction.sql has not
    // been applied yet (PostgREST 42703 = undefined column): still move the
    // status so nothing re-publishes, and say plainly that the audit trail
    // could not be written to its own columns.
    if (!r.ok && r.data && r.data.code === '42703') {
      auditColumnsMissing = true;
      r = await sb(`/rest/v1/video_library?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: RETRACTED_STATUS }),
      });
    }
    rowUpdate = { ok: r.ok, status: r.status, error: r.ok ? null : r.data };
  }

  await notifyTelegram(
    [
      `RETRACTED: ${row ? row.id : targets[0].platform}`,
      `By: ${retractedBy}${reason ? ` — ${reason}` : ''}`,
      ...results.map((x) => `${x.platform}: ${x.ok ? `down (${x.method})` : `STILL LIVE — ${x.error || 'failed'}`}`),
      ...(stillLive.length ? ['MANUAL ACTION REQUIRED — see route response.'] : []),
    ].join('\n'),
  );

  return res.status(allOk ? 200 : 207).json({
    ok: allOk,
    row_id: row ? row.id : null,
    status_set_to: row ? RETRACTED_STATUS : null,
    excluded_from_republish: !!(rowUpdate && rowUpdate.ok),
    audit_columns_missing: auditColumnsMissing || undefined,
    audit_columns_hint: auditColumnsMissing
      ? 'Run POST /api/admin-migrate-video-retraction to add the retraction audit columns; status was still moved.'
      : undefined,
    results,
    still_live: stillLive.map((r) => ({ platform: r.platform, platform_url: r.platform_url, manual_steps: r.manual_steps })),
    claimed_not_delivered: resolved.claimedNotDelivered || [],
    row_update: rowUpdate,
  });
};
