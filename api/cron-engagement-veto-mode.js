'use strict';

const { recordCronRun } = require('./_lib/cron-telemetry.js');

// api/cron-engagement-veto-mode.js
//
// SV-FB-VETO-001 (Atlas, 2026-06-11)
//
// Three-phase autonomous comment pipeline -- one cron run does all three:
//
//   PHASE A: AUTO-DRAFT
//     - Pull engagement_candidates with status='pending' AND relevance_score >= 6.
//     - Draft a Heath-voice reply via Claude Haiku (same SAGE_COMMENT_PROMPT
//       used by cron-sage-draft-engagements).
//     - PERSIST comment_draft to the row IMMEDIATELY (today's loss was caused
//       by drafts living in memory only -- never trust in-flight state).
//     - Flip status to 'auto_drafted', stamp auto_drafted_at.
//
//   PHASE B: SHIP VETO MESSAGE
//     - Pull rows with status='auto_drafted' (just-drafted + carryovers).
//     - Send a single Telegram veto-mode message with STOP / EDIT buttons.
//     - Set status='veto_pending', veto_window_ends_at = now + VETO_MINUTES.
//     - Respect daily + per-group caps (see CAPS section).
//
//   PHASE C: AUTO-POST EXPIRED VETOS
//     - Pull rows with status='veto_pending' AND veto_window_ends_at <= now.
//     - Flip to status='approved'. The existing PyAutoGUI poster
//       (scripts/unified-scanner/post_via_chrome.py) picks it up on its next
//       run and posts the comment. The poster sends the "POSTED in <group>"
//       Telegram confirmation when the post lands.
//
// CAPS (Sage's old cadence rules):
//   - DAILY_POST_CAP = 5: no more than 5 comments AUTO-APPROVED for posting
//     per UTC day (counted as status flips to 'approved' or 'posted' on or
//     after today 00:00 UTC).
//   - PER_GROUP_DAYS = 7: a group with a successful 'posted' row in the last
//     7 days will not get another candidate auto-veto-shipped from this cron.
//     Lower-scored candidates in that group simply wait or get rejected by
//     the existing engagement-cleanup cron.
//
// Schedule: every 5 minutes via cron-job.org. The cron is idempotent --
// PHASE C only flips when veto_window_ends_at is already in the past, so a
// 5-min cadence gives ~5-min granularity on the 10-min countdown. We
// intentionally run more often than the legacy draft cron because a delayed
// flip means a delayed post.
//
// Auth: Bearer ${CRON_SECRET}.

const ANTHROPIC_API_KEY        = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN       = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID         = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET              = process.env.CRON_SECRET;

// Heath-approved per-platform caps 2026-06-10 (FB 12 / IG 8 / LI 6 / RD 5 / TW 15).
// PLUS the TIGHTER per-Heath-2026-06-11 ceiling of DAILY_POST_CAP=5 TOTAL comments
// auto-shipped through veto mode in a UTC day. The lib also enforces per-author
// cooldown + substance floor. Both gates apply -- whichever is tighter wins.
const {
  canComment,
  recordComment,
  getTodayCounts,
  meetsSubstanceFloor,
  TOTAL_DAILY_CAP,
  PLATFORM_DAILY_CAPS,
  SUBSTANCE_MIN_CHARS,
} = require('../scripts/_lib/comment-caps');

const HAIKU_MODEL            = 'claude-haiku-4-5-20251001';
const VETO_MINUTES           = 10;
const AUTO_DRAFT_MIN_SCORE   = 6;
const MAX_DRAFTS_PER_RUN     = 6;
const MAX_VETO_SENDS_PER_RUN = 4;
const MAX_POSTS_PER_RUN      = 5;
const DAILY_POST_CAP         = 5;  // Heath's hard ceiling on veto-mode auto-posts/day
const PER_GROUP_DAYS         = 7;

// Sage's voice. Lifted from cron-sage-draft-engagements.js -- DO NOT diverge
// without coordinating Sage. If we drift, Heath will get two voices in his
// own comments.
const SAGE_COMMENT_PROMPT = `You are Sage, Head of Social Media for Shepard Ventures. You're drafting a comment Heath Shepard (licensed Texas REALTOR who built Dossie, an AI transaction coordinator) will leave on someone else's post.

Heath's voice when commenting on other people's posts:
- Warm, casual, genuine, first-person
- Sounds like a working agent on his phone between showings
- Short sentences. Self-deprecating when appropriate.
- Never corporate. Never use "excited", "thrilled", "game-changer", "leverage", "solution", "ecosystem"
- He acknowledges their pain FIRST before mentioning anything he built

Rules for this comment:
- Be genuinely helpful -- answer the question or empathize with the pain
- Mention Dossie ONE time max, as something Heath built, with a relevant beat (cost, control, deadlines)
- meetdossie.com/founding only if the post is clearly a TC/software pain point AND it would be natural
- If the post has no genuine opening for Dossie (off-topic, already solved, location outside US, just sharing a win), reply with ONLY the word SKIP
- Platform fit:
  * Facebook groups: 2-4 sentences, no hashtags
  * Instagram: 1-2 short sentences, no link (IG kills comment reach with links)
  * LinkedIn: 2-3 sentences, professional but human
- Plain ASCII only -- no em dashes (use hyphens), no curly quotes
- Never fabricate specifics (member counts, ratings, customer names beyond ones in the system prompt)`;

// ---- Supabase ---------------------------------------------------------------

async function sbFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function patchRow(id, fields) {
  await sbFetch(`/rest/v1/engagement_candidates?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(fields),
  });
}

// ---- Group name extraction --------------------------------------------------
// FB post URLs look like:
//   https://m.facebook.com/groups/<slug>/permalink/<id>
//   https://m.facebook.com/groups/<slug>/posts/<id>
//   https://m.facebook.com/groups/<slug>/#post-<hash>   (synthetic)
//   https://m.facebook.com/<page-slug>/                 (RE coach pages)
// We pull the segment after /groups/ when present, else the first path segment.
function extractGroupKey(postUrl) {
  if (!postUrl) return null;
  try {
    const u = new URL(postUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const gi = parts.indexOf('groups');
    if (gi >= 0 && parts[gi + 1]) return `groups/${parts[gi + 1]}`;
    if (parts[0]) return parts[0];
  } catch {}
  return null;
}

// ---- Caps -------------------------------------------------------------------

async function postedTodayCount() {
  // Anything that's been auto-approved or already posted in the current UTC day
  // counts against the daily cap. We deliberately don't subtract 'rejected'
  // because rejected never reached the poster.
  const startUtc = new Date();
  startUtc.setUTCHours(0, 0, 0, 0);
  const iso = startUtc.toISOString();
  const path = `/rest/v1/engagement_candidates?or=(status.eq.approved,status.eq.posted,status.eq.posting)&approved_at=gte.${encodeURIComponent(iso)}&select=id`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data)) return 0;
  return data.length;
}

async function groupRecentlyPosted(groupKey) {
  if (!groupKey) return false;
  const cutoff = new Date(Date.now() - PER_GROUP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Match by exact group_name OR by post_url substring -- belt + suspenders
  // because older rows won't have group_name backfilled.
  const path = `/rest/v1/engagement_candidates?status=eq.posted&posted_at=gte.${encodeURIComponent(cutoff)}&or=(group_name.eq.${encodeURIComponent(groupKey)},post_url.ilike.*${encodeURIComponent(groupKey)}*)&select=id`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data)) return false;
  return data.length > 0;
}

// ---- Claude -----------------------------------------------------------------

async function draftFor(row) {
  if (!ANTHROPIC_API_KEY) return { draft: null, raw: 'no ANTHROPIC_API_KEY' };

  const userMsg = [
    `Platform: ${row.platform}`,
    `Author: ${row.author_handle || 'unknown'}`,
    `Matched keywords: ${(row.matched_keywords || []).join(', ') || 'n/a'}`,
    `Relevance score: ${row.relevance_score ?? 'n/a'}`,
    `Post URL: ${row.post_url}`,
    '',
    'Post text:',
    `"""${(row.post_text || '').slice(0, 2200)}"""`,
    '',
    'Draft a Heath-voice comment for this post. Reply with ONLY the comment text, or the literal word SKIP if there is no genuine opening for Dossie.',
  ].join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 320,
        system: SAGE_COMMENT_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { draft: null, raw: `claude ${res.status}: ${err.slice(0, 200)}` };
    }
    const json = await res.json();
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const txt = ((json?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    if (!txt || txt.toUpperCase().startsWith('SKIP')) {
      return { draft: null, raw: 'SKIP' };
    }
    const cleaned = txt
      .replace(/[—–]/g, '-')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .trim()
      .slice(0, 1000);
    return { draft: cleaned, raw: 'ok' };
  } catch (e) {
    return { draft: null, raw: `exception: ${(e && e.message) || e}` };
  }
}

// ---- Telegram ---------------------------------------------------------------

async function tgSend(text, replyMarkup) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        disable_web_page_preview: true,
        reply_markup: replyMarkup || undefined,
      }),
    });
    const data = await res.json().catch(() => null);
    return data?.result?.message_id || null;
  } catch {
    return null;
  }
}

function buildVetoMessage(row, groupKey) {
  const groupLabel = row.group_name || groupKey || 'unknown group';
  const postSnippet = (row.post_text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const score = row.relevance_score != null ? ` (score ${row.relevance_score})` : '';
  return [
    `🚨 VETO MODE -- auto-posts in ${VETO_MINUTES} min unless you stop`,
    `Group: ${groupLabel}${score}`,
    `Post: ${postSnippet}`,
    `Draft:`,
    `---`,
    row.comment_draft || '(empty draft)',
    `---`,
    `Reply STOP, EDIT, or do nothing.`,
  ].join('\n');
}

// ---- Phase A: Auto-draft ----------------------------------------------------

async function phaseAutoDraft() {
  const path = `/rest/v1/engagement_candidates?status=eq.pending&relevance_score=gte.${AUTO_DRAFT_MIN_SCORE}&order=relevance_score.desc.nullslast,created_at.asc&limit=${MAX_DRAFTS_PER_RUN}`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return { drafted: 0, skipped: 0, failed: 0, sampled: 0 };
  }

  let drafted = 0, skipped = 0, failed = 0, capDeferred = 0, substanceRejected = 0;
  const nowIso = new Date().toISOString();

  for (const row of data) {
    const groupKey = extractGroupKey(row.post_url);
    // Per-platform cap gate (Heath-approved 2026-06-10).
    const cap = await canComment(row.platform, sbFetch);
    if (!cap.allowed) {
      // Leave row in 'pending' so it gets retried tomorrow once the
      // platform cap resets. Stamp the reason so the digest cron can show it.
      await patchRow(row.id, {
        last_error: `cap_blocked:${cap.reason || 'platform_cap'}`,
        group_name: groupKey,
      });
      capDeferred++;
      continue;
    }
    const { draft, raw } = await draftFor(row);

    if (draft) {
      // Substance floor: 80+ chars referencing specifics from the source post.
      const keywords = Array.isArray(row.matched_keywords) ? row.matched_keywords : [];
      const sub = meetsSubstanceFloor(draft, keywords);
      if (!sub.ok) {
        await patchRow(row.id, {
          status: 'rejected',
          rejection_reason: `substance_floor:${sub.reason}`,
          group_name: groupKey,
        });
        substanceRejected++;
        continue;
      }
      // PERSISTENCE FIX -- save draft IMMEDIATELY.
      await patchRow(row.id, {
        comment_draft: draft,
        status: 'auto_drafted',
        auto_drafted_at: nowIso,
        group_name: groupKey,
      });
      drafted++;
    } else if (raw === 'SKIP') {
      await patchRow(row.id, {
        status: 'rejected',
        rejection_reason: 'sage_skip_no_fit',
        group_name: groupKey,
      });
      skipped++;
    } else {
      await patchRow(row.id, {
        last_error: raw.slice(0, 500),
        post_attempt_count: (row.post_attempt_count || 0) + 1,
        group_name: groupKey,
      });
      failed++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return { drafted, skipped, failed, capDeferred, substanceRejected, sampled: data.length };
}

// ---- Phase B: Ship veto message --------------------------------------------

async function phaseShipVeto() {
  // Two ceilings, whichever is tighter wins:
  //   (1) per-platform + total caps via shared comment-caps lib
  //   (2) Heath's 2026-06-11 hard ceiling of DAILY_POST_CAP=5 veto-mode posts/day
  const counts = await getTodayCounts(sbFetch);
  const vetoUsed = await postedTodayCount();
  if (counts.total >= TOTAL_DAILY_CAP || vetoUsed >= DAILY_POST_CAP) {
    return { sent: 0, blocked_cap: true, counts, veto_used: vetoUsed, daily_cap: DAILY_POST_CAP };
  }

  const limit = MAX_VETO_SENDS_PER_RUN;
  const path = `/rest/v1/engagement_candidates?status=eq.auto_drafted&order=relevance_score.desc.nullslast,auto_drafted_at.asc&limit=${limit * 3}`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return { sent: 0, considered: 0, counts };
  }

  let sent = 0;
  let groupBlocked = 0;
  let capBlocked = 0;
  let dailyRemaining = DAILY_POST_CAP - vetoUsed;
  for (const row of data) {
    if (sent >= limit) break;
    if (dailyRemaining <= 0) break;  // Heath's tight 5/day ceiling
    // Per-platform cap gate.
    const cap = await canComment(row.platform, sbFetch);
    if (!cap.allowed) {
      capBlocked++;
      continue;
    }
    const groupKey = extractGroupKey(row.post_url) || row.group_name;
    if (await groupRecentlyPosted(groupKey)) {
      // Park the row -- mark it rejected with a clear reason so the
      // engagement-cleanup cron drops it eventually instead of looping.
      await patchRow(row.id, {
        status: 'rejected',
        rejection_reason: `group_cap_${PER_GROUP_DAYS}d`,
      });
      groupBlocked++;
      continue;
    }

    const text = buildVetoMessage(row, groupKey);
    const keyboard = {
      inline_keyboard: [[
        { text: 'STOP', callback_data: `eng_stop:${row.id}` },
        { text: 'EDIT', callback_data: `eng_edit:${row.id}` },
      ]],
    };
    const messageId = await tgSend(text, keyboard);

    const veto_window_ends_at = new Date(Date.now() + VETO_MINUTES * 60 * 1000).toISOString();
    await patchRow(row.id, {
      status: 'veto_pending',
      veto_window_ends_at,
      telegram_sent_at: new Date().toISOString(),
      telegram_message_id: messageId || null,
      group_name: groupKey,
    });
    sent++;
    dailyRemaining--;
    await new Promise((r) => setTimeout(r, 700));
  }

  return { sent, considered: data.length, group_blocked: groupBlocked, cap_blocked: capBlocked, counts, veto_used: vetoUsed };
}

// ---- Phase C: Auto-post expired vetos --------------------------------------

async function phaseAutoApprove() {
  const counts = await getTodayCounts(sbFetch);
  const vetoUsed = await postedTodayCount();
  if (counts.total >= TOTAL_DAILY_CAP || vetoUsed >= DAILY_POST_CAP) {
    return { approved: 0, blocked_cap: true, counts, veto_used: vetoUsed, daily_cap: DAILY_POST_CAP };
  }

  const nowIso = new Date().toISOString();
  const path = `/rest/v1/engagement_candidates?status=eq.veto_pending&veto_window_ends_at=lte.${encodeURIComponent(nowIso)}&order=relevance_score.desc.nullslast,veto_window_ends_at.asc&limit=${MAX_POSTS_PER_RUN}`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return { approved: 0, considered: 0, counts };
  }

  let approved = 0;
  let capBlocked = 0;
  let dailyRemaining = DAILY_POST_CAP - vetoUsed;
  for (const row of data) {
    if (dailyRemaining <= 0) break;  // Heath's tight 5/day ceiling
    // Per-platform cap gate. If FB is at 12 but Twitter has room, skip this
    // row and let Twitter rows through.
    const cap = await canComment(row.platform, sbFetch);
    if (!cap.allowed) {
      capBlocked++;
      continue;
    }
    await patchRow(row.id, {
      status: 'approved',
      approved_at: nowIso,
      approved_by: 'veto_mode_timeout',
    });
    // Increment the per-platform counter atomically so the next row sees it.
    await recordComment(row.platform, sbFetch);
    approved++;
    dailyRemaining--;
  }

  return { approved, considered: data.length, cap_blocked: capBlocked };
}

// ---- Handler ----------------------------------------------------------------

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const phaseA = await phaseAutoDraft();
    const phaseB = await phaseShipVeto();
    const phaseC = await phaseAutoApprove();

    await recordCronRun('cron-engagement-veto-mode', 'ok', {
      phase_a_drafted: phaseA.drafted,
      phase_b_veto_sent: phaseB.sent,
      phase_c_approved: phaseC.approved,
    });

    return res.status(200).json({
      ok: true,
      phase_a_auto_draft: phaseA,
      phase_b_ship_veto: phaseB,
      phase_c_auto_approve: phaseC,
      veto_minutes: VETO_MINUTES,
      auto_draft_min_score: AUTO_DRAFT_MIN_SCORE,
      platform_daily_caps: PLATFORM_DAILY_CAPS,
      total_daily_cap: TOTAL_DAILY_CAP,
      substance_floor_chars: SUBSTANCE_MIN_CHARS,
      per_group_days: PER_GROUP_DAYS,
    });
  } catch (e) {
    console.error('cron-engagement-veto-mode crashed:', e);
    await recordCronRun('cron-engagement-veto-mode', 'error', { error: e.message });
    return res.status(500).json({ ok: false, error: e.message });
  }
};
