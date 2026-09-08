'use strict';

// scripts/fb-comment-hunt-daily.js
//
// DAILY comment-opportunity finder — Part 1 (discovery) of the continuous
// engagement pipeline. Productionizes scripts/.sage-comment-hunt-tc.cjs (the
// 2026-09-08 hunt): Facebook desktop virtualizes feed text so aggressively
// that ONLY End-key stepped scrolling with per-step DOM extraction captures
// post text. That script solved it; this file reuses the technique verbatim —
// do not "simplify" the scroll loop, it will silently return empty posts.
//
// READ-ONLY against Facebook. This script never posts, comments, or replies.
// It: (1) re-verifies the most recent posted comments still exist (removed
// comment = halt everything), (2) scans the genuinely active groups from
// scripts/comment-hunt-groups.json, (3) prefilters obvious junk (listing
// spam, recruiting, stale posts), (4) inserts candidates into
// comment_opportunities at status='found'. Scoring, drafting, and the
// Telegram Approve/Edit/Skip loop live in api/cron-comment-opp-approval.js;
// posting lives in scripts/fb-comment-opp-poster.js.
//
// SELECTION BAR (Heath, 2026-09-08): loose, not picky. "We just have to add
// value to people's posts." The prefilter here only drops what could NEVER
// carry a useful comment; the scorer ranks the rest. Volume of candidates is
// supposed to exceed the 8/day post budget — pick the best 8 from a big pool.
//
// Pacing / safety:
//   - Shares the global scan budget (scripts/_lib/scan-caps.js) and self-caps
//     at scan.max_group_visits_per_day visits per UTC day.
//   - Runs ONCE per day (state file .comment-hunt-state.json) even though the
//     Task Scheduler wrapper ticks every 30 min.
//   - Halts (scripts/_lib/comment-hunt-halt.js) and alerts Heath if a posted
//     comment has vanished or FB shows login/checkpoint.
//   - DossieBot-Sage profile, HEADED (headless has twice falsely reported
//     logged-out on this profile), cooperative unlock.
//
// Scheduling: Windows Task Scheduler task "Dossie TC Discovery Harvest"
// (scripts/run-tc-discovery-harvest.cmd) — the Vercel cron grid can't reach
// the local Chrome profile, and cron-process-agent-requests / the PC
// agent-queue poller are both dead.
//
// Owner: Carter, 2026-09-08

const path = require('path');
const fs = require('fs');

// Load .env.local when running locally
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

const { canScan, recordScan, randDelay, SCAN_DWELL_MS } = require('./_lib/scan-caps');
const halt = require('./_lib/comment-hunt-halt');

const PROFILE_DIR = process.env.SAGE_PROFILE_DIR
  || 'C:\\Users\\Heath\\AppData\\Local\\DossieBot-Sage';
const CONFIG_FILE = path.join(__dirname, 'comment-hunt-groups.json');
const STATE_FILE = path.join(__dirname, '.comment-hunt-state.json');
const HEATH_FB_NAMES = ['Heath Shepard'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ─── Supabase ────────────────────────────────────────────────────────────────

function makeSbFetch() {
  return async function sbFetch(urlPath, init = {}) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${process.env.SUPABASE_URL}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  };
}

// Direct send — halt alerts are safety-critical, not cron noise.
async function notifyHeath(text) {
  const token = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4090), disable_web_page_preview: true }),
  }).catch(() => {});
}

// ─── Once-per-day gate ───────────────────────────────────────────────────────

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch { /* start fresh */ }
  return {};
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8'); } catch (e) {
    console.warn('[comment-hunt] could not persist state:', e.message);
  }
}
function todayKey() { return new Date().toISOString().slice(0, 10); }

// ─── Prefilter (exported for the regression test) ────────────────────────────
//
// ONLY drop what could never carry a useful comment. The bar for keeping is
// deliberately loose (Heath 2026-09-08): pricing, comps, negotiation,
// inspections, lenders, title, vendors, rentals, market talk, new-agent
// venting, business-building — all fair game. The scorer ranks; this just
// removes the guaranteed dead weight so we don't pay Claude to score spam.

const SPAM_PATTERNS = [
  /\bjust (listed|sold|closed)\b/i,
  /\bopen house\b/i,
  /\bcoming soon\b/i,
  /\bprice (drop|dropped|reduced|improvement)\b/i,
  /\bnew listing\b/i,
  /\b(we'?re|now) hiring\b/i,
  /\bjoin (my|our) (team|brokerage|office)\b/i,
  /\blooking to hire\b/i,
  /\bdm me for details\b/i,
  /(zillow\.com|realtor\.com|har\.com|homes\.com)/i,
  /\bmls\s*#/i,
];

/** Parse FB's rendered age ("3h", "2d", "45m", "1w", "Yesterday") to hours. */
function parseAgeHours(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  if (/^yesterday/i.test(t)) return 24;
  const m = t.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|hour|hours|d|day|days|w)\b/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2][0].toLowerCase();
  if (unit === 'm') return n / 60;
  if (unit === 'h') return n;
  if (unit === 'd') return n * 24;
  if (unit === 'w') return n * 24 * 7;
  return null;
}

/** Parse "12 comments" / "View all 47 comments" from the post's text blob. */
function parseCommentCount(text) {
  const m = String(text || '').match(/(\d+)\s+comments?\b/i);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * @returns {{keep: boolean, reason?: string}}
 */
function prefilterPost(post, { maxAgeHours = 48 } = {}) {
  const text = String(post.text || '');
  if (!post.postUrl) return { keep: false, reason: 'no_permalink' };
  if (normText(text).length < 30) return { keep: false, reason: 'too_short' };
  if (HEATH_FB_NAMES.some((n) => String(post.authorName || '').toLowerCase().includes(n.toLowerCase()))) {
    return { keep: false, reason: 'own_post' };
  }
  const age = parseAgeHours(post.age);
  if (age !== null && age > maxAgeHours) return { keep: false, reason: `stale:${post.age}` };
  for (const re of SPAM_PATTERNS) {
    if (re.test(text)) return { keep: false, reason: `spam:${re.source.slice(0, 30)}` };
  }
  return { keep: true };
}

// ─── The proven extraction (from .sage-comment-hunt-tc.cjs, v4) ──────────────

async function extractVisible(page) {
  return page.evaluate(() => {
    const out = [];
    for (const u of document.querySelectorAll('div[aria-posinset]')) {
      const text = (u.innerText || '').trim();
      if (text.length < 40) continue;
      let postUrl = null;
      for (const link of u.querySelectorAll('a[href*="/groups/"]')) {
        const href = link.getAttribute('href') || '';
        if (/\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(href)) {
          postUrl = (href.startsWith('http') ? href : 'https://www.facebook.com' + href).split('?')[0];
          break;
        }
      }
      let authorName = '';
      const nameEl = u.querySelector('h3 a, h4 a, strong a, h2 a, b a');
      if (nameEl) authorName = nameEl.innerText.trim();
      if (!authorName) {
        const strong = u.querySelector('strong, h3, h4');
        if (strong) authorName = strong.innerText.trim().split('\n')[0];
      }
      let age = '';
      for (const link of u.querySelectorAll('a')) {
        const t = (link.innerText || '').trim();
        if (/^(\d+\s?[smhdw]$|\d+ (min|mins|hr|hrs|hour|hours|day|days)|Yesterday)/i.test(t) && t.length < 30) { age = t; break; }
      }
      out.push({ text: text.slice(0, 2600), postUrl, authorName, age });
    }
    return out;
  });
}

async function scanGroupFeed(page, group, endKeyRounds) {
  const seen = new Map();
  const add = (p) => {
    const k = p.postUrl || p.text.slice(0, 80);
    if (!seen.has(k) || p.text.length > (seen.get(k).text || '').length) seen.set(k, p);
  };
  await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  recordScan(1);
  if (/\/login|\/checkpoint/i.test(page.url())) {
    throw Object.assign(new Error('redirected to login/checkpoint'), { code: 'CHECKPOINT' });
  }
  await sleep(9000);
  await page.mouse.move(590, 470);
  for (const p of await extractVisible(page)) add(p);
  for (let round = 0; round < endKeyRounds; round++) {
    await page.keyboard.press('End');
    await page.waitForTimeout(2600 + Math.floor(Math.random() * 900));
    for (const p of await extractVisible(page)) add(p);
  }
  return [...seen.values()];
}

// ─── Posted-comment re-verify (removed comment = halt everything) ────────────

async function expandRepliesReadOnly(page) {
  const EXPAND_RE = /^(View (all )?\d+ (more )?(comments|replies)|View more comments|View more replies|Previous comments|\d+ (reply|replies))$/i;
  for (let round = 0; round < 10; round++) {
    const clicked = await page.evaluate((reSrc) => {
      const re = new RegExp(reSrc, 'i');
      const btns = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'));
      for (const b of btns) {
        const t = (b.innerText || '').trim();
        if (t && re.test(t)) { b.click(); return t; }
      }
      return null;
    }, EXPAND_RE.source).catch(() => null);
    if (!clicked) break;
    await sleep(1800);
  }
}

async function verifyPostedCommentStillLive(page, row) {
  await page.goto(row.post_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  recordScan(1);
  if (/\/login|\/checkpoint/i.test(page.url())) {
    throw Object.assign(new Error('redirected to login/checkpoint'), { code: 'CHECKPOINT' });
  }
  await sleep(6000);
  await expandRepliesReadOnly(page);
  const wanted = normText(row.comment_final).slice(0, 80);
  return page.evaluate(({ names, wanted: w }) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const articles = Array.from(document.querySelectorAll('div[role="article"]'));
    for (const art of articles) {
      const label = art.getAttribute('aria-label') || '';
      if (!/^(Comment|Reply) by /i.test(label)) continue;
      const isOwn = names.some((n) => label.toLowerCase().includes(n.toLowerCase()));
      if (!isOwn) continue;
      if (norm(art.innerText).includes(w)) return true;
    }
    return false;
  }, { names: HEATH_FB_NAMES, wanted }).catch(() => false);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[comment-hunt] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
    process.exit(1);
  }

  const haltEntry = halt.getHalt();
  if (haltEntry) {
    console.log(`[comment-hunt] HALTED (${haltEntry.reason} @ ${haltEntry.halted_at}) — doing nothing. Clear with: node scripts/fb-comment-opp-poster.js --clear-halt`);
    return;
  }

  const state = loadState();
  if (state.last_run_date === todayKey()) {
    console.log('[comment-hunt] already ran today — exiting (once/day by design)');
    return;
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const groups = (config.groups || []).filter((g) => g.url && !g.url.includes('PLACEHOLDER'));
  const scanCfg = config.scan || {};
  const maxVisits = scanCfg.max_group_visits_per_day || 8;
  const reverifyN = scanCfg.reverify_recent_posted ?? 3;
  const endKeyRounds = scanCfg.end_key_rounds || 12;
  const maxAgeHours = scanCfg.max_post_age_hours || 48;

  const sbFetch = makeSbFetch();

  // Budget check up front: reverify visits + group visits, bounded by both
  // our own per-day visit cap and the shared global scan cap.
  const { data: postedRows } = await sbFetch(
    '/rest/v1/comment_opportunities?status=eq.posted'
    + `&posted_at=gte.${encodeURIComponent(new Date(Date.now() - 72 * 3600000).toISOString())}`
    + '&select=id,post_url,comment_final,group_name&order=posted_at.desc'
    + `&limit=${reverifyN}`,
  );
  const toReverify = Array.isArray(postedRows) ? postedRows.filter((r) => r.post_url && r.comment_final) : [];
  const visitsWanted = Math.min(maxVisits, toReverify.length + groups.length);
  const gate = canScan(1);
  if (!gate.allowed) {
    console.log(`[comment-hunt] global scan budget spent (${gate.used}/${gate.cap}) — skipping today's hunt`);
    return;
  }
  const visitBudget = Math.min(visitsWanted, gate.remaining);

  const { chromium } = require('playwright');
  const { unlockProfile } = require('./_lib/chrome-profile-unlock');

  // Cooperative unlock with retries — the harvester/poster share this profile.
  let context = null;
  for (let attempt = 1; attempt <= 8 && !context; attempt++) {
    try {
      await unlockProfile({ profileDir: PROFILE_DIR, reason: 'comment-hunt-daily' });
      context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false, // headless has twice falsely reported logged-out on this profile
        channel: 'chrome',
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1180,940', '--no-first-run'],
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
      });
    } catch (e) {
      console.log(`[comment-hunt] attempt ${attempt}: profile busy; waiting 90s`);
      await sleep(90000);
    }
  }
  if (!context) {
    console.error('[comment-hunt] profile never freed — will retry on tomorrow\'s tick');
    process.exit(4);
  }

  let visitsUsed = 0;
  let inserted = 0;
  let filtered = 0;
  const page = context.pages()[0] || await context.newPage();

  try {
    // 1. Re-verify recent posted comments. A removed comment is a moderation
    //    warning sign — halt EVERYTHING and tell Heath.
    for (const row of toReverify) {
      if (visitsUsed >= visitBudget) break;
      visitsUsed++;
      const live = await verifyPostedCommentStillLive(page, row);
      if (!live) {
        halt.setHalt('posted comment no longer present in thread', {
          opportunity_id: row.id, post_url: row.post_url, group: row.group_name,
        });
        await notifyHeath(
          `COMMENT PIPELINE HALTED — a comment you posted in ${row.group_name} is GONE from its thread (removed by a mod or by Facebook).\n${row.post_url}\n\nNothing will scan or post until you check the profile and clear the halt:\nnode scripts/fb-comment-opp-poster.js --clear-halt`,
        );
        console.error('[comment-hunt] HALT: posted comment missing:', row.post_url);
        return;
      }
      await randDelay(SCAN_DWELL_MS);
    }

    // 2. Scan the active groups.
    for (const group of groups) {
      if (visitsUsed >= visitBudget) {
        console.log('[comment-hunt] visit budget reached — remaining groups roll to tomorrow');
        break;
      }
      visitsUsed++;
      let posts = [];
      try {
        posts = await scanGroupFeed(page, group, endKeyRounds);
      } catch (e) {
        if (e.code === 'CHECKPOINT') {
          halt.setHalt('facebook login/checkpoint redirect during scan', { group: group.name });
          await notifyHeath(
            `COMMENT PIPELINE HALTED — Facebook redirected to login/checkpoint while scanning ${group.name}. This can mean a temp block. Check the DossieBot-Sage profile, then clear the halt:\nnode scripts/fb-comment-opp-poster.js --clear-halt`,
          );
          console.error('[comment-hunt] HALT: checkpoint during scan');
          return;
        }
        console.warn(`[comment-hunt] ${group.name}: scan error ${e.message}`);
        continue;
      }

      for (const post of posts) {
        const verdict = prefilterPost(post, { maxAgeHours });
        if (!verdict.keep) { filtered++; continue; }
        const row = {
          group_key: group.key,
          group_name: group.name,
          group_url: group.url,
          post_url: post.postUrl,
          author_name: post.authorName || null,
          post_text: post.text,
          post_age_raw: post.age || null,
          comment_count: parseCommentCount(post.text),
          status: 'found',
        };
        const ins = await sbFetch('/rest/v1/comment_opportunities?on_conflict=post_url', {
          method: 'POST',
          headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
          body: JSON.stringify(row),
        });
        // 409 = duplicate on the (group_url, post_hash) content index — same
        // post under a permalink variant. Not a failure.
        if (ins.ok && Array.isArray(ins.data) && ins.data.length > 0) inserted++;
      }
      console.log(`[comment-hunt] ${group.name}: ${posts.length} posts extracted`);
      await randDelay(SCAN_DWELL_MS);
    }
  } finally {
    await context.close().catch(() => {});
  }

  state.last_run_date = todayKey();
  state.last_run = { at: new Date().toISOString(), visits: visitsUsed, inserted, filtered };
  saveState(state);
  console.log(`[comment-hunt] done: ${visitsUsed} visits, ${inserted} new candidates, ${filtered} prefiltered. Scoring/drafting happens in cron-comment-opp-approval.`);
}

module.exports = { prefilterPost, parseAgeHours, parseCommentCount, SPAM_PATTERNS };

if (require.main === module) {
  main().catch((err) => {
    console.error('[comment-hunt] fatal:', err.message);
    process.exit(1);
  });
}
