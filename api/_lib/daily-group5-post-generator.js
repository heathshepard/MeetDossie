'use strict';

// api/_lib/daily-group5-post-generator.js
//
// Daily 5-group-post pipeline — Part 1 (generate -> draft -> notify).
// Heath's decision 2026-09-09, verbatim: "people can post more than once a
// day. 5 groups 1 post to each group per day is fine" — drafts ONE post per
// day for EACH of the 5 groups in scripts/comment-hunt-groups.json, pulling
// content formats from docs/GROUP-ENGAGEMENT-PLAN.md and real pain language
// from reddit_pain_language, and sends each to Heath via DossieMarketingBot
// for Approve / Edit / Skip (gp5_* callbacks, api/group5-post-callback.js +
// api/telegram-webhook.js).
//
// Pipeline match:
//   generate (this file, api/cron-daily-group5-posts.js)
//     -> group_posts row, pipeline='daily5', status='draft'
//     -> Telegram Approve/Edit/Skip
//     -> approve -> status='approved'
//     -> scripts/fb-group5-post-queue.js (Windows Task Scheduler tick,
//        appended to the existing "Dossie TC Discovery Harvest" .cmd)
//        posts via scripts/fb-group-poster.js --post-id, one per run,
//        18-24 min varied spacing, 'facebook_group_post' 5/day budget,
//        shares the comment pipeline's circuit breaker (one FB profile).
//     -> comment_watchlist registration (already built into
//        fb-group-poster.js's markPosted path — no separate wiring needed).
//
// Content gating (per-group, code-level, not a prompt suggestion):
//   scripts/_lib/group-post-content-gate.js — dfw_network_collab is
//   hard_no_promo (VERIFIED group rule); every other group defaults to
//   value_only pending a rules recon (Sage's explicit recommendation,
//   2026-09-09). The generated body is checked AFTER generation, not just
//   instructed in the prompt.
//
// Fabrication guard (2026-09-09, after the generator invented five personal
// war stories and nearly posted them under Heath's real name/license):
//   api/_lib/fabrication-guard.js checks EVERY generated body, and the one
//   format allowed to carry a personal anecdote (`verified_anecdote`) draws
//   ONLY from api/_lib/verified-war-stories.json via
//   api/_lib/verified-story-library.js — never free-form generation. If no
//   eligible story is available for a group/run, that format is never a
//   candidate (see group-post5-formats.js pickFormat) and generation falls
//   back to a non-anecdote format instead. See
//   memory/heath-verified-war-stories.md for the incident + the allowlist.
//
// Dedup (per-group, 30-day window):
//   scripts/_lib/group-post-dedup.js — exact-body hash + word-overlap
//   near-duplicate + same-hook-type-reused-in-group all block a re-insert.
//   hook_type for an anecdote post is stored compound
//   ("verified_anecdote:<storyId>") so this also blocks reusing the SAME
//   verified story in the same group within the window. One retry with
//   explicit feedback before giving up on a group for today.
//
// Owner: Carter, 2026-09-09. Fabrication-guard + verified-story wiring:
// Sage, 2026-09-09.

const fs = require('fs');
const path = require('path');

const { FORMATS, pickFormat, pickStory, effectiveHookType, baseHookType, buildPrompt, DRAFT_MODEL } = require('./group-post5-formats');
const { eligibleStories } = require('./verified-story-library');
const { checkFabrication } = require('./fabrication-guard');
const { checkGroupContentGate } = require('../../scripts/_lib/group-post-content-gate');
const { checkDuplicate, withinDedupeWindow } = require('../../scripts/_lib/group-post-dedup');
const { wasSuppressed } = require('./telegram-gate');
const heathVoiceGuard = require('./heath-voice-guard');

const GROUPS_CONFIG_PATH = path.join(__dirname, '..', '..', 'scripts', 'comment-hunt-groups.json');

function loadTargetGroups() {
  const raw = JSON.parse(fs.readFileSync(GROUPS_CONFIG_PATH, 'utf8'));
  return Array.isArray(raw.groups) ? raw.groups : [];
}

function makeSupabaseFetch(url, key) {
  return async function supabaseFetch(urlPath, init = {}) {
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${url}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  };
}

async function callClaude(anthropicKey, prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      max_tokens: 900,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  const raw = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  let s = raw.trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const fb = s.indexOf('{');
  const lb = s.lastIndexOf('}');
  if (fb < 0 || lb <= fb) throw new Error('No JSON object in Claude response: ' + s.slice(0, 200));
  return JSON.parse(s.slice(fb, lb + 1));
}

function buildTelegramMessage(group, format, postBody) {
  return [
    `GROUP POST DRAFT — ${group.name}`,
    `Format: ${format.label}`,
    '',
    postBody,
  ].join('\n').slice(0, 4090);
}

function gp5Keyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `gp5_approve:${rowId}` },
      { text: 'Edit', callback_data: `gp5_edit:${rowId}` },
      { text: 'Skip', callback_data: `gp5_skip:${rowId}` },
    ]],
  };
}

async function telegramSend(token, chatId, text, replyMarkup) {
  const body = { chat_id: chatId, text, disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw };
}

/**
 * Which verified story ids are off the table for THIS pick: any story used
 * elsewhere in today's run, plus any story whose compound hook_type
 * ("verified_anecdote:<id>") shows up in this group's own recent posts
 * (same 30-day dedupe window already loaded by the caller).
 */
function storyIdsRecentlyUsedInGroup(recentPosts) {
  return recentPosts
    .map((r) => r.hook_type)
    .filter((h) => typeof h === 'string' && h.startsWith('verified_anecdote:'))
    .map((h) => h.split(':')[1]);
}

/**
 * Generate one post for one group, with content-gate + dedup + voice +
 * fabrication enforcement and one retry on any failure. Returns null if it
 * can't produce a clean post after the retry (never inserts a
 * blocked/duplicate/off-voice/fabricated row).
 *
 * @param {object} deps { generate, group, recentPosts, painLines, log, recentOpeners, usedFormatsThisRun, usedStoriesThisRun }
 * @returns {Promise<{ post_body: string, format: object, story: object|null, hookType: string } | null>}
 */
async function generateCleanPost({ generate, group, recentPosts, painLines, log, recentOpeners = [], usedFormatsThisRun = [], usedStoriesThisRun = [] }) {
  let lastHookType = recentPosts.length ? baseHookType(recentPosts[0].hook_type) : null;
  // Combine explicit cross-group recentOpeners (passed by the caller) with
  // this group's own recent post bodies — either can produce the "sounds
  // like the last one" failure Heath named.
  const openersForPrompt = [...recentOpeners, ...recentPosts.map((r) => r.post_body)];

  const groupExcludeStoryIds = storyIdsRecentlyUsedInGroup(recentPosts);
  const excludeStoryIds = [...new Set([...usedStoriesThisRun, ...groupExcludeStoryIds])];
  const eligibleStoryIds = eligibleStories({ excludeIds: excludeStoryIds }).map((s) => s.id);

  for (let attempt = 0; attempt < 2; attempt++) {
    const format = pickFormat(lastHookType, usedFormatsThisRun, eligibleStoryIds);
    const story = format.requiresStory ? pickStory(eligibleStoryIds) : null;
    if (format.requiresStory && !story) {
      // Should be unreachable given pickFormat's gate, but never generate
      // an anecdote post without a real story backing it — skip this
      // attempt rather than risk it.
      log(`[daily-group5] "${group.name}" (attempt ${attempt + 1}): verified_anecdote picked with no story available — skipping attempt`);
      continue;
    }
    const promoAllowed = false; // Sage's finding, 2026-09-09: none of the 5 groups are confirmed-safe for product-adjacent content today
    const prompt = buildPrompt({ group, format, painLines, promoAllowed, recentOpeners: openersForPrompt, story });

    let result;
    try {
      result = await generate(prompt);
    } catch (err) {
      log(`[daily-group5] Claude call failed for "${group.name}" (attempt ${attempt + 1}): ${err.message}`);
      continue;
    }
    const postBody = String(result.post_body || '').trim();
    if (!postBody) {
      log(`[daily-group5] Empty post_body for "${group.name}" (attempt ${attempt + 1})`);
      continue;
    }

    const gate = checkGroupContentGate(group.key, postBody, null);
    if (!gate.allowed) {
      log(`[daily-group5] Content gate BLOCKED "${group.name}" (attempt ${attempt + 1}): ${gate.reason}`);
      continue;
    }

    const hookType = effectiveHookType(format, story);
    const dup = checkDuplicate(postBody, hookType, recentPosts);
    if (dup.duplicate) {
      log(`[daily-group5] Dedup BLOCKED "${group.name}" (attempt ${attempt + 1}): ${dup.reason}`);
      lastHookType = format.id; // force a different format on the retry
      continue;
    }

    const voiceCheck = heathVoiceGuard.checkVoiceCompliance(postBody);
    if (!voiceCheck.ok) {
      log(`[daily-group5] Voice guard BLOCKED "${group.name}" (attempt ${attempt + 1}): ${voiceCheck.violations.join(', ')}`);
      continue;
    }

    // Fabrication guard — the fix for the 2026-09-09 incident. Runs on
    // EVERY format, not just verified_anecdote: a non-anecdote format
    // drifting into "I had a client who..." territory must be caught too.
    const fabCheck = checkFabrication(postBody, { formatId: format.id });
    if (!fabCheck.ok) {
      log(`[daily-group5] FABRICATION GUARD BLOCKED "${group.name}" (attempt ${attempt + 1}): ${fabCheck.violations.join(', ')}`);
      continue;
    }

    return { post_body: postBody, format, story, hookType };
  }

  return null;
}

/**
 * Run the daily 5-group-post generation pass.
 *
 * @param {object} opts
 * @param {string} opts.supabaseUrl
 * @param {string} opts.supabaseKey
 * @param {string} opts.anthropicKey
 * @param {string} opts.telegramToken
 * @param {string} opts.telegramChatId
 * @param {Array}  [opts.groups]        override for testing — defaults to comment-hunt-groups.json
 * @param {function} [opts.generate]    override for testing — async (prompt) => {post_body}
 * @param {function} [opts.send]        override for testing — async (text, keyboard) => {ok, data}
 * @param {function} [opts.loadPainLines] override for testing — async (sbFetch) => string[]
 * @param {function} [opts.log]
 * @param {function} [opts.now]
 * @returns {Promise<{ drafted: number, skipped: number, notified: number, results: Array }>}
 */
async function runDailyGroup5PostGeneration(opts) {
  const {
    supabaseUrl, supabaseKey, anthropicKey, telegramToken, telegramChatId,
    groups = loadTargetGroups(),
    generate = (prompt) => callClaude(anthropicKey, prompt),
    send = (text, kb) => telegramSend(telegramToken, telegramChatId, text, kb),
    loadPainLines = defaultLoadPainLines,
    log = console.log,
    now = () => new Date(),
  } = opts;

  const sbFetch = opts.sbFetch || makeSupabaseFetch(supabaseUrl, supabaseKey);
  const out = { drafted: 0, skipped: 0, notified: 0, results: [] };

  // Pull ALL group_posts for the daily5 pipeline in the dedupe window once,
  // then filter per-group in memory — cheaper than 5 separate queries.
  const cutoffIso = new Date(now().getTime() - 30 * 24 * 3600 * 1000).toISOString();
  const { ok: recentOk, data: recentData } = await sbFetch(
    `/rest/v1/group_posts?pipeline=eq.daily5&created_at=gte.${encodeURIComponent(cutoffIso)}`
    + '&select=group_key,post_body,hook_type,created_at&order=created_at.desc',
  );
  const allRecent = recentOk && Array.isArray(recentData) ? recentData : [];

  const painLines = await loadPainLines(sbFetch).catch((err) => {
    log(`[daily-group5] pain-language load failed (non-fatal): ${err.message}`);
    return [];
  });

  // Cross-group opener variety WITHIN this run — the failure Heath named
  // was three drafts in the same session sharing a shape, not necessarily
  // in the same group.
  const runOpeners = [];
  // Cross-group FORMAT variety within this run — with exactly 5 formats and
  // 5 groups, each group should get a different one. Verified against real
  // sample output 2026-09-09: without this, 2 of 5 groups landed on
  // 'resource_giveaway' and 2 landed on 'contrarian' in the same run —
  // "one idea rewritten five ways", the exact thing this pipeline exists to
  // avoid.
  const usedFormatsThisRun = [];
  // Cross-group STORY variety within this run — Heath's explicit rule
  // (2026-09-09): don't put the same verified story in two groups the same
  // day.
  const usedStoriesThisRun = [];

  for (const group of groups) {
    const recentPosts = withinDedupeWindow(allRecent, group.key, now());

    const clean = await generateCleanPost({ generate, group, recentPosts, painLines, log, recentOpeners: runOpeners, usedFormatsThisRun, usedStoriesThisRun });
    if (!clean) {
      log(`[daily-group5] Skipping "${group.name}" — could not produce a clean, non-duplicate, gate-passing, fabrication-free post after retry`);
      out.skipped++;
      out.results.push({ group_key: group.key, group_name: group.name, status: 'skipped' });
      continue;
    }

    const nowIso = now().toISOString();
    const insertRow = {
      group_key: group.key,
      group_name: group.name,
      group_url: group.url,
      pipeline: 'daily5',
      category: 'daily5',
      template_id: clean.format.id,
      hook_type: clean.hookType,
      post_body: clean.post_body,
      first_comment_body: null,
      status: 'draft',
    };
    const { ok: insOk, data: insData } = await sbFetch('/rest/v1/group_posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(insertRow),
    });
    if (!insOk || !Array.isArray(insData) || !insData.length) {
      log(`[daily-group5] Insert failed for "${group.name}": ${JSON.stringify(insData).slice(0, 200)}`);
      out.skipped++;
      out.results.push({ group_key: group.key, group_name: group.name, status: 'insert_failed' });
      continue;
    }
    const post = insData[0];
    out.drafted++;

    // Add to in-memory recent list so a later group in THIS run can't
    // duplicate the format/body/story just picked for an earlier group.
    allRecent.unshift({ group_key: group.key, post_body: clean.post_body, hook_type: clean.hookType, created_at: nowIso });
    runOpeners.unshift(clean.post_body);
    usedFormatsThisRun.push(clean.format.id);
    if (clean.story) usedStoriesThisRun.push(clean.story.id);

    const sendRes = await send(
      buildTelegramMessage(group, clean.format, clean.post_body),
      gp5Keyboard(post.id),
    );
    // NEVER advance state on a suppressed send — Heath did not see it (same
    // suppression-lies contract as cron-comment-opp-approval.js).
    if (sendRes.ok && !wasSuppressed(sendRes.data)) {
      await sbFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          telegram_sent_at: nowIso,
          telegram_message_id: sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null,
        }),
      });
      out.notified++;
      out.results.push({ id: post.id, group_key: group.key, group_name: group.name, format: clean.format.id, story_id: clean.story ? clean.story.id : null, status: 'drafted_and_notified' });
    } else {
      // Suppressed or failed send: row STAYS status='draft' with no
      // telegram_sent_at — never fake-advance (same contract as the
      // comment-opportunity pipeline). Next run's Telegram-retry pass
      // (below) will pick it up.
      log(`[daily-group5] Telegram send failed/suppressed for "${group.name}" post ${post.id} — left as draft for retry`);
      out.results.push({ id: post.id, group_key: group.key, group_name: group.name, format: clean.format.id, story_id: clean.story ? clean.story.id : null, status: 'drafted_send_pending' });
    }
  }

  return out;
}

/**
 * Retry Telegram notification for any 'draft' rows from a PRIOR run that
 * never got delivered (suppressed by telegram-gate or a transient send
 * failure). Never re-generates content — the draft persists exactly as
 * written so a retry never re-bills Claude.
 */
async function retryPendingNotifications(opts) {
  const { telegramToken, telegramChatId, log = console.log, now = () => new Date() } = opts;
  const sbFetch = opts.sbFetch || makeSupabaseFetch(opts.supabaseUrl, opts.supabaseKey);
  const send = opts.send || ((text, kb) => telegramSend(telegramToken, telegramChatId, text, kb));

  const { ok, data } = await sbFetch(
    '/rest/v1/group_posts?pipeline=eq.daily5&status=eq.draft&telegram_sent_at=is.null'
    + '&select=id,group_name,group_key,post_body,template_id',
  );
  if (!ok || !Array.isArray(data)) return { retried: 0, notified: 0 };

  let notified = 0;
  for (const row of data) {
    const format = FORMATS.find((f) => f.id === row.template_id) || { label: row.template_id };
    const sendRes = await send(
      buildTelegramMessage({ name: row.group_name }, format, row.post_body),
      gp5Keyboard(row.id),
    );
    if (sendRes.ok && !wasSuppressed(sendRes.data)) {
      const nowIso = now().toISOString();
      await sbFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          telegram_sent_at: nowIso,
          telegram_message_id: sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null,
        }),
      });
      notified++;
    } else {
      log(`[daily-group5] Retry send still failing for post ${row.id} (${row.group_name})`);
    }
  }
  return { retried: data.length, notified };
}

async function defaultLoadPainLines(sbFetch) {
  const { ok, data } = await sbFetch(
    '/rest/v1/reddit_pain_language?select=snippet&order=rank_score.desc&limit=10',
  );
  if (!ok || !Array.isArray(data)) return [];
  return data.map((r) => r.snippet).filter(Boolean).slice(0, 6);
}

module.exports = {
  loadTargetGroups,
  runDailyGroup5PostGeneration,
  retryPendingNotifications,
  generateCleanPost,
  buildTelegramMessage,
  gp5Keyboard,
  defaultLoadPainLines,
};
