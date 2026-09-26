'use strict';

// api/_lib/video-comment-automations.js
// =============================================================================
// THE KEYWORD LIFECYCLE. Comment-to-DM automations, derived from the video
// records, so nobody has to maintain them.
//
// Heath, on why this has to be automatic:
//   "as we create videos and want these keywords we have to constantly be
//    updating our keywords for the next relevant video."
//
// ─── THE DESIGN RULE ─────────────────────────────────────────────────────────
// The keyword is a PROPERTY OF THE CONTENT, not a separate chore. It is
// declared on the video_library row -- the thing a human already touches when
// producing content -- as two fields:
//
//     video_library.dm_keyword    'TREC'
//     video_library.dm_asset_url  the one-pager to deliver
//
// Everything after that is derived. This module reconciles declared state
// against Zernio's actual state on every run:
//
//     declared + published + not retracted   -> automation exists, armed
//     declared + not yet published           -> nothing (waits for publish)
//     retracted / superseded / keyword gone  -> automation DELETED at Zernio
//     keyword collides with another video    -> REFUSED, loudly, never silently
//
// Because it reconciles rather than fires on an event, a missed publish
// webhook, a failed run, or a manual change at Zernio all self-heal on the
// next pass. Nobody has to remember to clean anything up.
//
// ─── WHY KEYWORDS ARE UNIQUE FOREVER ─────────────────────────────────────────
// A keyword is an attribution token: it is the ONLY thing tying a lead back to
// the video that earned it. If 'TREC' could be recycled onto a second video,
// every lead it ever produced becomes ambiguous retroactively. So uniqueness
// is enforced case-insensitively in the DB (unique indexes on
// video_library.dm_keyword and video_comment_automations.keyword) AND checked
// here before any write, and a collision is REFUSED rather than overwritten.
//
// ─── THE SAFETY MODEL ────────────────────────────────────────────────────────
// Creating a live comment-automation DMs strangers. That is a publish-class
// action, so there are two flags and creation alone is not enough to fire one:
//
//   ops_flags.zernio_comment_automations       OFF -> report only, creates
//                                              NOTHING at Zernio.
//                                              ON  -> creates automations in a
//                                              PAUSED state (isActive:false).
//   ops_flags.zernio_comment_automations_live  OFF -> automations stay paused.
//                                              ON  -> they are armed and will
//                                              DM real people.
//
// This split exists because of a verified API behaviour, not paranoia: POST
// /v1/comment-automations SILENTLY IGNORES isActive:false and returns
// isActive:true (probed 2026-09-25). An automation is LIVE the instant it is
// created. api/_lib/zernio-comments.js createAutomation() closes that window
// and deletes the automation outright if it cannot CONFIRM it went paused.
//
// Owner: Atlas, 2026-09-25.
// =============================================================================

const {
  makeBudget, zernio, listAutomations, createAutomation,
  deleteAutomation, setAutomationActive, updateAutomation,
  DM_AUTOMATION_PLATFORMS,
} = require('./zernio-comments.js');

const FLAG_CREATE = 'zernio_comment_automations';
const FLAG_LIVE = 'zernio_comment_automations_live';

// Everything this module creates is named with this prefix so an automation
// made by hand in the Zernio UI is never mistaken for ours and never deleted.
const NAME_PREFIX = 'dossie-video:';

// video_library statuses that mean "this is live on a platform right now".
const PUBLISHED_STATUSES = new Set(['posted', 'published']);

function sbFactory(supabaseUrl, serviceKey) {
  return async function sb(path, init = {}) {
    const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 400) : '' };
  };
}

async function readFlag(sb, key) {
  const r = await sb(`ops_flags?key=eq.${encodeURIComponent(key)}&select=enabled`);
  return r.ok && Array.isArray(r.data) && r.data.length > 0 && r.data[0].enabled === true;
}

/**
 * Turn an explicit target declaration into the same shape resolvePostTargets
 * returns, WITHOUT a Zernio post record.
 *
 * WHY THIS ESCAPE HATCH EXISTS. The automatic path needs
 * video_library.zernio_deliveries[].zernio_post_id, and two separate pieces of
 * bookkeeping are currently not writing it:
 *   - social_posts.zernio_post_id is NULL on every recent posted row, even
 *     ones verified live on the platform. (This is the same broken column that
 *     made the old comment monitor scan zero posts for 79 days. Ingestion no
 *     longer depends on it; arming still would.)
 *   - zernio_deliveries only started being recorded on 2026-09-25, so anything
 *     published before that has an empty array.
 * Neither is this module's bug to fix, but neither can be allowed to make the
 * first real keyword impossible to arm either.
 *
 * So a target can be stated outright: video_library.dm_target_posts =
 *   [{ "platform": "instagram", "platformPostId": "...", "accountId": "...", "profileId": "..." }]
 * Set once, by the CLI, for a post the automatic path cannot see. New videos
 * going forward resolve on their own and never need this.
 */
function explicitTargets(video) {
  const raw = video && video.dm_target_posts;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!t || !DM_AUTOMATION_PLATFORMS.has(t.platform)) continue;
    if (!t.platformPostId || !t.accountId || !t.profileId) continue;
    out.push({
      platform: t.platform,
      accountId: String(t.accountId),
      profileId: String(t.profileId),
      platformPostId: String(t.platformPostId),
      platformPostUrl: t.platformPostUrl || null,
      source: 'explicit',
    });
  }
  return out;
}

async function resolvePostTargets({ zernioPostId, budget }) {
  const r = await zernio(`/posts/${encodeURIComponent(zernioPostId)}`, {}, budget);
  if (!r.ok) return { ok: false, error: `posts_lookup_${r.status}: ${r.error}`, targets: [] };
  const post = (r.data && (r.data.post || r.data)) || {};
  const targets = [];
  for (const p of Array.isArray(post.platforms) ? post.platforms : []) {
    if (!DM_AUTOMATION_PLATFORMS.has(p.platform)) continue;   // IG/FB only
    if (p.status !== 'published') continue;                    // not live yet
    if (!p.platformPostId) continue;                           // nothing to bind to
    const accountId = typeof p.accountId === 'object' ? p.accountId._id : p.accountId;
    const profileId = (typeof p.accountId === 'object' && p.accountId.profileId) || p.profileId;
    if (!accountId || !profileId) continue;
    targets.push({
      platform: p.platform,
      accountId: String(accountId),
      profileId: String(profileId),
      platformPostId: String(p.platformPostId),
      platformPostUrl: p.platformPostUrl || null,
    });
  }
  return { ok: true, targets, postContent: String(post.content || '').slice(0, 120) };
}

/**
 * The asset has to actually exist before we promise it to anyone.
 *
 * The TREC 20-19 one-pager is being produced by another agent in parallel
 * (Media/lead-magnets/trec-20-19-six-changes.pdf as of 2026-09-25 12:48, not
 * yet uploaded anywhere public). Rather than assume a URL, the keyword simply
 * cannot arm until dm_asset_url resolves 200. A DM promising a link that 404s
 * is worse than no DM.
 */
async function assetReachable(url) {
  if (!url) return { ok: false, reason: 'no_asset_url' };
  try {
    let res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    // Some CDNs (and Supabase Storage on certain paths) refuse HEAD.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-64' } });
    }
    if (res.ok || res.status === 206) return { ok: true, status: res.status };
    return { ok: false, reason: `asset_http_${res.status}` };
  } catch (err) {
    return { ok: false, reason: `asset_unreachable: ${String(err.message).slice(0, 120)}` };
  }
}

function defaultDmMessage(keyword, video) {
  const topic = (video.topic || '').replace(/_/g, ' ').trim();
  return [
    `Here you go. You commented "${keyword}"${topic ? ` on the ${topic} video` : ''}, so here is the one-pager.`,
    '',
    'Questions on it, just reply here.',
  ].join('\n');
}

/**
 * THE RECONCILER.
 *
 * @returns {{
 *   plan: Array<object>,   every intended action, with a reason
 *   applied: Array<object>, what actually happened (empty on dryRun)
 *   collisions: Array<object>,
 *   orphans: Array<object>,
 *   counts: object
 * }}
 */
async function syncVideoAutomations({
  supabaseUrl, serviceKey, dryRun = true, onlyVideoId = null, budget = null,
}) {
  const sb = sbFactory(supabaseUrl, serviceKey);
  budget = budget || makeBudget(150);

  const canCreate = await readFlag(sb, FLAG_CREATE);
  const canArm = await readFlag(sb, FLAG_LIVE);
  const effectiveDryRun = dryRun || !canCreate;

  const plan = [];
  const applied = [];
  const collisions = [];
  const errors = [];

  // ── Declared state ──────────────────────────────────────────────────────
  const vq = onlyVideoId
    ? `video_library?id=eq.${encodeURIComponent(onlyVideoId)}&select=*`
    : 'video_library?dm_keyword=not.is.null&select=id,status,topic,caption,dm_keyword,dm_asset_url,dm_message,dm_target_posts,zernio_deliveries,retracted_at,posted_date';
  const videosR = await sb(vq);
  if (!videosR.ok) return { error: `video_library read failed ${videosR.status}`, plan, applied, collisions, errors };
  const videos = (Array.isArray(videosR.data) ? videosR.data : []).filter((v) => v.dm_keyword);

  // ── Current ledger ──────────────────────────────────────────────────────
  const ledgerR = await sb('video_comment_automations?select=*');
  const ledger = Array.isArray(ledgerR.data) ? ledgerR.data : [];
  const ledgerByVideoAccount = new Map();
  for (const row of ledger) ledgerByVideoAccount.set(`${row.video_library_id}::${row.account_id}`, row);

  // ── Collision detection, before ANY write ───────────────────────────────
  // Refuse, never overwrite. Two videos claiming one keyword makes every lead
  // it produced unattributable, and silently letting the newer one win
  // destroys the older one's attribution retroactively.
  const byKeyword = new Map();
  for (const v of videos) {
    const k = String(v.dm_keyword).trim().toLowerCase();
    if (!byKeyword.has(k)) byKeyword.set(k, []);
    byKeyword.get(k).push(v.id);
  }
  const collidingKeywords = new Set();
  for (const [k, ids] of byKeyword) {
    if (ids.length > 1) {
      collidingKeywords.add(k);
      collisions.push({ keyword: k, videos: ids, action: 'refused - keyword claimed by more than one video' });
    }
  }
  for (const row of ledger) {
    const k = String(row.keyword).toLowerCase();
    const claimant = byKeyword.get(k);
    if (claimant && !claimant.includes(row.video_library_id) && row.status !== 'retired') {
      collidingKeywords.add(k);
      collisions.push({
        keyword: k,
        videos: claimant,
        existing_owner: row.video_library_id,
        action: 'refused - keyword already owned by a different video',
      });
    }
  }

  // ── Per-video reconciliation ────────────────────────────────────────────
  for (const video of videos) {
    const keyword = String(video.dm_keyword).trim();
    const kLower = keyword.toLowerCase();

    if (collidingKeywords.has(kLower)) {
      plan.push({ video: video.id, keyword, action: 'skip', reason: 'keyword_collision' });
      continue;
    }

    const retracted = !!video.retracted_at;
    const live = PUBLISHED_STATUSES.has(String(video.status)) && !retracted;

    // ── Retire path. A retracted or superseded video must not leave an
    //    automation DMing people about content that is gone.
    if (!live) {
      for (const [key, row] of ledgerByVideoAccount) {
        if (!key.startsWith(`${video.id}::`)) continue;
        if (row.status === 'retired') continue;
        const reason = retracted ? 'video_retracted' : `video_status_${video.status}`;
        plan.push({ video: video.id, keyword, action: 'retire', reason, automationId: row.zernio_automation_id });
        if (effectiveDryRun) continue;
        if (row.zernio_automation_id) {
          const del = await deleteAutomation({ automationId: row.zernio_automation_id, budget });
          if (!del.ok) { errors.push({ video: video.id, stage: 'delete', error: del.error }); continue; }
        }
        await sb(`video_comment_automations?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            status: 'retired', retired_at: new Date().toISOString(),
            retire_reason: reason, zernio_automation_id: null, updated_at: new Date().toISOString(),
          }),
        });
        applied.push({ video: video.id, action: 'retired', reason });
      }
      continue;
    }

    // ── Arm path. Resolve where this video actually lives.
    const deliveries = Array.isArray(video.zernio_deliveries) ? video.zernio_deliveries : [];
    const zernioPostIds = [...new Set(deliveries.map((d) => d && d.zernio_post_id).filter(Boolean))];
    const stated = explicitTargets(video);
    if (zernioPostIds.length === 0 && stated.length === 0) {
      plan.push({ video: video.id, keyword, action: 'skip', reason: 'no_zernio_delivery_recorded' });
      continue;
    }

    const asset = await assetReachable(video.dm_asset_url);
    if (!asset.ok) {
      plan.push({ video: video.id, keyword, action: 'skip', reason: asset.reason, asset_url: video.dm_asset_url || null });
      continue;
    }

    const targets = [...stated];
    for (const zid of zernioPostIds) {
      const r = await resolvePostTargets({ zernioPostId: zid, budget });
      if (!r.ok) { errors.push({ video: video.id, stage: 'resolve', error: r.error }); continue; }
      for (const t of r.targets) {
        // An explicit declaration wins over a resolved one for the same
        // account, so a stated target is never quietly shadowed.
        if (!targets.some((x) => x.accountId === t.accountId)) targets.push(t);
      }
    }
    if (targets.length === 0) {
      // Not an error. Comment-to-DM exists on Instagram and Facebook only, so
      // a LinkedIn/YouTube/TikTok-only video legitimately has nowhere to arm.
      plan.push({ video: video.id, keyword, action: 'skip', reason: 'no_instagram_or_facebook_delivery' });
      continue;
    }

    const dmMessage = video.dm_message || defaultDmMessage(keyword, video);

    for (const t of targets) {
      const existing = ledgerByVideoAccount.get(`${video.id}::${t.accountId}`);
      const desiredActive = canArm;

      if (existing && existing.zernio_automation_id && existing.status !== 'retired') {
        const needsKeywordChange = String(existing.keyword).toLowerCase() !== kLower;
        const needsActiveChange = (existing.status === 'armed') !== desiredActive;
        if (!needsKeywordChange && !needsActiveChange) {
          plan.push({ video: video.id, keyword, account: t.accountId, action: 'noop', reason: 'already_in_desired_state' });
          continue;
        }
        plan.push({
          video: video.id, keyword, account: t.accountId, action: 'update',
          reason: [needsKeywordChange ? 'keyword_changed' : null, needsActiveChange ? `active->${desiredActive}` : null].filter(Boolean).join(','),
        });
        if (effectiveDryRun) continue;
        if (needsKeywordChange) {
          await updateAutomation({ automationId: existing.zernio_automation_id, patch: { keywords: [keyword], dmMessage }, budget });
        }
        if (needsActiveChange) {
          await setAutomationActive({ automationId: existing.zernio_automation_id, active: desiredActive, budget });
        }
        await sb(`video_comment_automations?id=eq.${existing.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            keyword, dm_message: dmMessage, asset_url: video.dm_asset_url,
            status: desiredActive ? 'armed' : 'paused',
            armed_at: desiredActive ? new Date().toISOString() : existing.armed_at,
            paused_at: desiredActive ? existing.paused_at : new Date().toISOString(),
            last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }),
        });
        applied.push({ video: video.id, action: 'updated', account: t.accountId });
        continue;
      }

      plan.push({
        video: video.id, keyword, account: t.accountId, platform: t.platform,
        platformPostId: t.platformPostId, action: 'create',
        reason: canArm ? 'create_and_arm' : 'create_paused',
        dm_message: dmMessage, asset_url: video.dm_asset_url,
      });
      if (effectiveDryRun) continue;

      const created = await createAutomation({
        profileId: t.profileId,
        accountId: t.accountId,
        platformPostId: t.platformPostId,
        name: `${NAME_PREFIX}${video.id}`,
        keywords: [keyword],
        // 'word' + typoTolerance, never the 'contains' default: 'contains'
        // would fire TREC inside unrelated words and on every passing mention.
        matchMode: 'word',
        typoTolerance: true,
        dmMessage,
        buttons: video.dm_asset_url
          ? [{ type: 'url', title: 'Get the one-pager', url: video.dm_asset_url }]
          : null,
        activate: canArm,
        budget,
      });

      if (!created.ok) {
        errors.push({ video: video.id, stage: 'create', account: t.accountId, error: created.error });
        await sb('video_comment_automations?on_conflict=video_library_id,account_id', {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            video_library_id: video.id, keyword, platform: t.platform, account_id: t.accountId,
            platform_post_id: t.platformPostId, dm_message: dmMessage, asset_url: video.dm_asset_url,
            status: 'error', last_error: String(created.error).slice(0, 400),
            last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }),
        });
        continue;
      }

      await sb('video_comment_automations?on_conflict=video_library_id,account_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({
          video_library_id: video.id, keyword, platform: t.platform, account_id: t.accountId,
          platform_post_id: t.platformPostId, zernio_automation_id: created.automation.id,
          dm_message: dmMessage, asset_url: video.dm_asset_url,
          status: canArm ? 'armed' : 'paused',
          armed_at: canArm ? new Date().toISOString() : null,
          paused_at: canArm ? null : new Date().toISOString(),
          last_error: null, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }),
      });
      applied.push({
        video: video.id, action: canArm ? 'created_armed' : 'created_paused',
        account: t.accountId, automationId: created.automation.id,
      });
    }
  }

  // ── Orphan sweep ────────────────────────────────────────────────────────
  // An automation that exists at Zernio, carries our name prefix, and is in no
  // ledger row is a leak: it will keep DMing people about a video nobody is
  // tracking. Reported always; deleted only when we are allowed to write.
  const orphans = [];
  const remote = await listAutomations({ budget });
  if (remote.ok) {
    const known = new Set(ledger.map((r) => r.zernio_automation_id).filter(Boolean));
    for (const a of remote.automations) {
      if (!String(a.name || '').startsWith(NAME_PREFIX)) continue; // not ours, never touch
      if (known.has(a.id)) continue;
      orphans.push({ automationId: a.id, name: a.name, keywords: a.keywords, isActive: a.isActive });
      if (effectiveDryRun) continue;
      await deleteAutomation({ automationId: a.id, budget });
      applied.push({ action: 'deleted_orphan', automationId: a.id, name: a.name });
    }
  } else {
    errors.push({ stage: 'orphan_sweep', error: remote.error });
  }

  return {
    plan,
    applied,
    collisions,
    orphans,
    errors,
    flags: { [FLAG_CREATE]: canCreate, [FLAG_LIVE]: canArm },
    dry_run: effectiveDryRun,
    requests_used: budget.used,
    counts: {
      videos_declaring_a_keyword: videos.length,
      planned_creates: plan.filter((p) => p.action === 'create').length,
      planned_updates: plan.filter((p) => p.action === 'update').length,
      planned_retires: plan.filter((p) => p.action === 'retire').length,
      skipped: plan.filter((p) => p.action === 'skip').length,
      collisions: collisions.length,
      orphans: orphans.length,
      applied: applied.length,
    },
  };
}

module.exports = {
  FLAG_CREATE,
  explicitTargets,
  FLAG_LIVE,
  NAME_PREFIX,
  PUBLISHED_STATUSES,
  sbFactory,
  readFlag,
  resolvePostTargets,
  assetReachable,
  defaultDmMessage,
  syncVideoAutomations,
};
