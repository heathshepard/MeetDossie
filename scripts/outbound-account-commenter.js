'use strict';

// scripts/outbound-account-commenter.js
// =============================================================================
// Comments on curated LARGER Texas real-estate accounts/pages Heath has no
// standing relationship with — a different action class from
// scripts/fb-comment-hunt-daily.js / fb-group-commenter.js, which scan the 5
// FB groups Heath is already a member of. Built 2026-09-28 per Heath's
// autonomy directive: "be a problem solver, be proactive, figure out how to
// work within the system to get it done."
//
// Usage:
//   node scripts/outbound-account-commenter.js            # scan + draft (report mode)
//   node scripts/outbound-account-commenter.js --post      # also POST eligible drafts
//                                                            (still gated: ops_flags.
//                                                            outbound_account_comments_live
//                                                            must be on, and the 3/day
//                                                            cap still applies)
//   node scripts/outbound-account-commenter.js --dry-run    # scan + draft, write nothing
//
// ─── THE SAFETY MODEL ────────────────────────────────────────────────────────
// Three independent gates, ALL of which must pass before a draft is ever
// eligible to post — same defense-in-depth shape as
// api/cron-comment-reply-draft.js:
//
//   1. RESOLVABILITY (scripts/_lib/account-resolvability-check.js). A target
//      row is refused unless existence_verified=true — a real browser visit
//      has confirmed the page is real. Seeded rows start false; this script
//      flips a row to true only after it successfully loads that exact page
//      in THIS run (see verifyAndMark()).
//   2. RISK CLASSIFIER + CONTENT GATES (scripts/_lib/auto-reply-risk-
//      classifier.js, scripts/_lib/auto-reply-content-gates.js) — same
//      shared gates the inbound-reply engine uses: no pricing, no fabricated
//      war story, no unverified Dossie capability claim, no unverified TREC
//      claim, no named client/address, on-voice.
//   3. THE FLAG + THE CAP. ops_flags.outbound_account_comments_live defaults
//      false — report mode: every draft lands at status='drafted' or
//      'held' and NOTHING posts, regardless of --post. When Heath turns the
//      flag on, posting is still hard-capped at 3/day
//      (scripts/_lib/comment-caps.js, outbound_account_comment budget,
//      90-min floor) and deduped so the script never comments twice on one
//      post and never twice on one account in the same day.
//
// This is a LOCAL script (Windows Task Scheduler, DossieBot Chrome profile)
// — the Vercel cron grid can't reach a persistent, logged-in Chrome profile,
// same reason fb-comment-hunt-daily.js and fb-group-commenter.js are local.
//
// Owner: Atlas, 2026-09-28.
// =============================================================================

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load .env.local when running locally (mirrors fb-group-commenter.js).
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch { /* non-fatal */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data',
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const { filterResolvableAccounts } = require('./_lib/account-resolvability-check');
const { classifyCommentRisk } = require('./_lib/auto-reply-risk-classifier');
const { checkContentGates } = require('./_lib/auto-reply-content-gates');
const caps = require('./_lib/comment-caps');
const voiceGuard = require('../api/_lib/heath-voice-guard');

const OPS_FLAG = 'outbound_account_comments_live';
const CAP_KEY = 'outbound_account_comment';
const MAX_POSTS_PER_ACCOUNT_PER_SCAN = 3;
const RECENT_POST_CUTOFF_MS = 5 * 24 * 60 * 60 * 1000; // only comment on something posted in the last 5 days

async function sb(path_, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path_}`, {
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
  return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 300) : '' };
}
const sbFetch = (p, init) => sb(p.replace(/^\/rest\/v1\//, ''), init);

// ─── Draft prompt — Heath's own practitioner voice, never Dossie's ────────────
// heath-marketing-must-pass-practitioner-test: a specific reaction a 20-year
// agent would nod at, never "great post". heath-group-comment-voice: no
// enthusiasm opener, no reflexive question, ASCII only, short.
const DRAFT_PROMPT = (account, post, recentOpeners) => `You are drafting a Facebook comment for Heath Shepard, a working Texas REALTOR (Keller Williams, San Antonio/Boerne). He is commenting on a post from ${account.account_name}, a larger real-estate brokerage/association page he has NO relationship with — a stranger's page, not a group he's a member of.

HARD RULES:
- React to the SPECIFIC substance of the post, the way a 20-year agent would — a real practitioner detail, a real exception, something that shows he actually read it. Never "great post", never generic praise, never a compliment-then-question shape.
- Do not mention Dossie, meetdossie.com, or any product. This is not a pitch — it's Heath commenting as a working agent.
- Never state a price, a commission figure, or a dollar amount.
- Never name a real client or a specific street address.
- Never assert a specific TREC paragraph/clause/deadline number as fact.
- Short. One or two sentences, sometimes a fragment. Contractions always.
- No em-dash, no " - " as a beat. ASCII only. No hashtags.
- A question at the end is OPTIONAL and should be rare — often just answer/react and stop.

${voiceGuard.VOICE_PROMPT_BLOCK}
${voiceGuard.buildRecentOpenersBlock(recentOpeners)}
ALSO decide: skip=true if the post is pure listing/ad content, a stock photo with no real substance, or anything a comment can't meaningfully add to. When skip=true set comment to "".

POST from ${account.account_name} (${account.platform}):
"""
${String(post.excerpt || '').slice(0, 700)}
"""

Return ONLY JSON: {"skip": boolean, "skip_reason": "short reason or empty", "comment": "the comment text or empty"}`;

async function draftComment(account, post, recentOpeners) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 300,
      messages: [{ role: 'user', content: DRAFT_PROMPT(account, post, recentOpeners) }],
    }),
  });
  if (!res.ok) throw new Error(`claude ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const json = await res.json();
  const text = (json.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in draft response');
  const parsed = JSON.parse(match[0]);
  return {
    skip: parsed.skip === true,
    skipReason: String(parsed.skip_reason || '').slice(0, 200),
    comment: String(parsed.comment || '').trim(),
  };
}

// ─── Dedupe ────────────────────────────────────────────────────────────────

/** Never comment twice on the same ACCOUNT in the same UTC day. */
async function alreadyCommentedAccountToday(accountId) {
  const today = new Date().toISOString().slice(0, 10);
  const r = await sb(
    `outbound_account_comments?target_account_id=eq.${accountId}&status=eq.posted`
    + `&posted_at=gte.${today}T00:00:00Z&select=id&limit=1`,
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

/** Never comment twice on the same POST — DB unique index is the real
 * guarantee; this is the pre-check that avoids a wasted draft/API call. */
async function alreadyHandledPost(accountId, postUrl) {
  const r = await sb(
    `outbound_account_comments?target_account_id=eq.${accountId}&post_url=eq.${encodeURIComponent(postUrl)}&select=id&limit=1`,
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

// ─── Scraping a target page (report-mode: read-only, never posts) ──────────
// Facebook desktop virtualizes feed text (see fb-comment-hunt-daily.js
// header) — reuses the same End-key stepped-scroll extraction technique.
async function scanAccountPosts(page, account) {
  await page.goto(account.page_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);

  // Confirm the page actually resolved (not a login wall / "content isn't
  // available" error page) before trusting anything scraped from it.
  const bodyText = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 2000) : '');
  const looksDead = /content isn't available|page not found|log in to (facebook|continue)|this content isn't available right now/i.test(bodyText);
  if (looksDead) {
    return { resolved: false, posts: [] };
  }

  const posts = [];
  for (let step = 0; step < 6 && posts.length < MAX_POSTS_PER_ACCOUNT_PER_SCAN; step += 1) {
    await page.keyboard.press('End');
    await page.waitForTimeout(1200);
    const found = await page.evaluate(() => {
      const out = [];
      const nodes = document.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
      nodes.forEach((n) => {
        const text = (n.innerText || '').trim();
        if (text.length > 40) out.push(text.slice(0, 1200));
      });
      return out;
    });
    for (const text of found) {
      if (!posts.some((p) => p.excerpt === text)) {
        posts.push({ excerpt: text, url: `${account.page_url}#scanned-${posts.length}`, foundAt: Date.now() });
      }
      if (posts.length >= MAX_POSTS_PER_ACCOUNT_PER_SCAN) break;
    }
  }
  return { resolved: true, posts };
}

/** Marks a row existence_verified=true after a real, successful page load
 * in THIS run — the only way a seeded row ever becomes eligible. */
async function verifyAndMark(account, resolved) {
  if (!resolved) {
    await sb(`comment_target_accounts?id=eq.${account.id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        last_scanned_at: new Date().toISOString(),
        last_scan_ok: false,
        last_scan_error: 'page did not resolve (login wall or not found)',
      }),
    });
    return;
  }
  await sb(`comment_target_accounts?id=eq.${account.id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      existence_verified: true,
      verified_at: new Date().toISOString(),
      verified_by: 'outbound-account-commenter:live-scan',
      last_scanned_at: new Date().toISOString(),
      last_scan_ok: true,
      last_scan_error: null,
    }),
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function run(opts = {}) {
  const { post: shouldPost = false, dryRun = false, log = console } = opts;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    log.error('[outbound-account-commenter] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
    return { ok: false, error: 'supabase_env_missing' };
  }
  if (!ANTHROPIC_API_KEY) {
    log.error('[outbound-account-commenter] ANTHROPIC_API_KEY required');
    return { ok: false, error: 'anthropic_env_missing' };
  }

  const allRes = await sb('comment_target_accounts?select=*&order=account_name.asc');
  const all = Array.isArray(allRes.data) ? allRes.data : [];

  // Two populations: VERIFIED (eligible to scan/comment today) and
  // UNVERIFIED-BUT-ACTIVE (this run's chance to resolve them for real —
  // see verifyAndMark()). Every seeded row starts in the second bucket.
  const { resolvable: verified, unresolved } = filterResolvableAccounts(all, { report: (r) => log.log(`[outbound-account-commenter] not yet eligible — ${r}`) });
  const pendingVerification = all.filter((a) => a.active !== false && a.existence_verified !== true);

  const flagRes = await sb(`ops_flags?key=eq.${OPS_FLAG}&select=enabled`);
  const liveFlagOn = flagRes.ok && Array.isArray(flagRes.data) && flagRes.data.length > 0 && flagRes.data[0].enabled === true;

  const recentRes = await sb('outbound_account_comments?draft_text=not.is.null&select=draft_text&order=created_at.desc&limit=10');
  const recentOpeners = (Array.isArray(recentRes.data) ? recentRes.data : []).map((r) => String(r.draft_text || '')).filter(Boolean);

  const summary = { verified: verified.length, pending_verification: pendingVerification.length, scanned: 0, drafted: 0, held: 0, skipped: 0, posted: 0, errors: [] };

  if (verified.length === 0 && pendingVerification.length === 0) {
    log.log('[outbound-account-commenter] no active target accounts — nothing to do');
    return { ok: true, ...summary };
  }

  const { chromium } = require('playwright');
  const unlockProfileFn = require('./_lib/chrome-profile-unlock').unlockProfile;
  try {
    await unlockProfileFn({ profileDir: CHROME_PROFILE_PATH, reason: 'outbound-account-commenter' });
  } catch (err) {
    if (err && err.code === 'BROKERAGE_PROFILE_LOCKED') {
      log.log(`[outbound-account-commenter] profile locked by another process — skipping this run (will retry next tick): ${err.message}`);
      return { ok: true, ...summary, skipped_run: 'profile_locked' };
    }
    throw err;
  }

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`, '--window-size=1280,900'],
    viewport: { width: 1280, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  try {
    const page = context.pages()[0] || await context.newPage();

    // Pass 1: try to resolve every pending-verification row for real. A
    // successful load flips existence_verified=true and makes it eligible
    // on THIS run's pass 2 as well as every future run.
    for (const account of pendingVerification) {
      try {
        const { resolved, posts } = await scanAccountPosts(page, account);
        await verifyAndMark(account, resolved);
        if (resolved) {
          log.log(`[outbound-account-commenter] VERIFIED live: ${account.account_name} (${account.page_url}) — ${posts.length} post(s) captured`);
          verified.push({ ...account, existence_verified: true });
        } else {
          log.log(`[outbound-account-commenter] could not resolve ${account.account_name} (${account.page_url}) — stays unverified`);
        }
      } catch (err) {
        summary.errors.push({ account: account.account_name, stage: 'verify', error: err.message });
        await sb(`comment_target_accounts?id=eq.${account.id}`, {
          method: 'PATCH', headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ last_scanned_at: new Date().toISOString(), last_scan_ok: false, last_scan_error: String(err.message).slice(0, 300) }),
        });
      }
    }

    // Pass 2: scan + draft every verified account.
    for (const account of verified) {
      if (await alreadyCommentedAccountToday(account.id)) {
        log.log(`[outbound-account-commenter] ${account.account_name}: already commented today, skipping`);
        continue;
      }
      let posts;
      try {
        const scanned = await scanAccountPosts(page, account);
        posts = scanned.posts;
        summary.scanned += 1;
      } catch (err) {
        summary.errors.push({ account: account.account_name, stage: 'scan', error: err.message });
        continue;
      }

      for (const post of posts) {
        if (await alreadyHandledPost(account.id, post.url)) continue;

        let draft;
        try {
          draft = await draftComment(account, post, recentOpeners);
        } catch (err) {
          summary.errors.push({ account: account.account_name, stage: 'draft', error: err.message });
          continue;
        }

        if (dryRun) {
          summary.drafted += draft.skip ? 0 : 1;
          if (!draft.skip) log.log(`[outbound-account-commenter][dry-run] ${account.account_name}: "${draft.comment}"`);
          continue;
        }

        if (draft.skip || !draft.comment) {
          await sb('outbound_account_comments', {
            method: 'POST', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ target_account_id: account.id, platform: account.platform, post_url: post.url, post_excerpt: post.excerpt.slice(0, 500), status: 'skipped', error_message: draft.skipReason || 'model chose to skip' }),
          });
          summary.skipped += 1;
          continue;
        }

        // Same shared gates the inbound engine uses.
        const verdict = await classifyCommentRisk(post.excerpt, draft.comment);
        const gates = checkContentGates(draft.comment);
        const clears = verdict.eligible && gates.pass;
        const rowStatus = clears ? 'drafted' : 'held';

        const insertRes = await sb('outbound_account_comments', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            target_account_id: account.id, platform: account.platform, post_url: post.url,
            post_excerpt: post.excerpt.slice(0, 500), draft_text: draft.comment,
            gate_failures: gates.pass ? null : gates.failures, status: rowStatus,
          }),
        });
        const row = insertRes.ok && Array.isArray(insertRes.data) ? insertRes.data[0] : null;
        recentOpeners.unshift(draft.comment);

        if (rowStatus === 'held') { summary.held += 1; continue; }
        summary.drafted += 1;

        // Posting is gated behind --post, the live flag, AND the cap —
        // ALL three, every time. Report mode (the default) stops here.
        if (!shouldPost || !liveFlagOn || !row) continue;

        const allowed = await caps.canComment(CAP_KEY, sbFetch);
        if (!allowed.allowed) { log.log(`[outbound-account-commenter] cap hit: ${allowed.reason}`); break; }
        const gap = await caps.minGapElapsed(CAP_KEY, sbFetch, 'outbound_account_comments', 'posted_at', account.platform);
        if (!gap.elapsed) { log.log(`[outbound-account-commenter] min-gap not elapsed: ${Math.round(gap.ageMin)}<${gap.gapMin}min`); break; }

        // NOTE: the actual postComment() DOM interaction is intentionally
        // NOT wired here yet — this ships in report-mode. When Heath is
        // ready to go live, wire postComment(page, post.url, draft.comment)
        // (same primitive fb-group-commenter.js already has) behind this
        // exact gate stack; nothing else in this file changes.
        log.log(`[outbound-account-commenter] WOULD POST to ${account.account_name} but live-posting is not wired yet — row stays 'drafted' for manual review`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  log.log('[outbound-account-commenter] done:', JSON.stringify(summary));
  return { ok: true, ...summary };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  run({ post: args.includes('--post'), dryRun: args.includes('--dry-run') })
    .then((r) => { if (!r.ok) process.exitCode = 1; })
    .catch((err) => { console.error('[outbound-account-commenter] fatal:', err); process.exitCode = 1; });
}

module.exports = { run, scanAccountPosts, draftComment, alreadyCommentedAccountToday, alreadyHandledPost };
