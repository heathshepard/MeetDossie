'use strict';

// scripts/fb-group-poster.js
//
// Playwright script: posts approved group_posts content to Facebook groups
// using Heath's persistent Chrome profile. No session-cookie capture needed —
// the profile stays logged in indefinitely as long as Heath uses Chrome.
//
// Usage:
//   node scripts/fb-group-poster.js --post-id [uuid]
//
// Requires an approved group_posts row. Fetches it from Supabase, posts,
// then updates group_posts status='posted' and group_registry last_posted_at.
//
// Migrated 2026-06-10 from sessions/facebook.json to launchPersistentContext
// to eliminate the recurring "renew Facebook session" pings.
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN  (personal Claudy bot, for confirmation)
//   TELEGRAM_CHAT_ID

const path = require('path');
const os = require('os');
const fs = require('fs');

// Use isolated DossieBot-Sage profile so we don't collide with Heath's
// running Chrome (which locks the main User Data dir). Matches the pattern
// used by sage-fb-scan-mission.js, fb-lead-scraper.js, etc.
const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.SAGE_PROFILE_NAME || 'Default';

// Load .env.local when running locally
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
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const postIdIdx = args.indexOf('--post-id');
const POST_ID = postIdIdx >= 0 ? args[postIdIdx + 1] : null;

if (!POST_ID) {
  console.error('[fb-group-poster] Usage: node scripts/fb-group-poster.js --post-id [uuid]');
  process.exit(1);
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchPost(postId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

// status='posted' is written ONLY here, and ONLY when the caller has
// positive evidence (a real permalink, or a feed-text match — see
// scripts/_lib/fb-post-verify-outcome.js). verified_at is stamped alongside
// it as the record of when that evidence was captured.
async function markPosted(postId, groupRegistryId, postUrl) {
  const now = new Date().toISOString();

  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: 'posted', posted_at: now, post_url: postUrl || null, verified_at: now, failure_reason: null,
    }),
  });

  if (groupRegistryId) {
    await supabaseFetch(`/rest/v1/group_registry?id=eq.${encodeURIComponent(groupRegistryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_posted_at: now }),
    });
  }
}

// Pre-submit failure (never reached/clicked the Post button, or Facebook
// showed an explicit rejection before any content could have gone live) --
// safe to reset to 'approved' so the queue can retry, because no submit
// action occurred that could have created a duplicate live post.
async function markFailed(postId, reason) {
  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'approved', failure_reason: reason || null }),
  });
  console.error(`[fb-group-poster] Marked as failed (reset to approved): ${reason}`);
}

// A submit action DID occur (Post button clicked, composer behavior
// observed) but neither a permalink nor a feed match confirms the post
// exists. This is the false-'posted' bug fix (2026-09-16): previously this
// case defaulted to status='posted'. It must NOT auto-reset to 'approved'
// either -- retrying blindly risks a duplicate real post if the original
// submit actually succeeded and we simply failed to verify it (Heath's
// "never retry an unverified send" rule). Status stays 'failed', terminal,
// posted_at stamped (the submit click really happened), pending a manual
// check on Facebook.
async function markUnconfirmed(postId, groupRegistryId, reason) {
  const now = new Date().toISOString();
  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'failed', posted_at: now, post_url: null, failure_reason: reason || null }),
  });
}

// Terminal, non-retryable outcomes: the account/Page can't post here at all
// right now (per-group truth audit, 2026-09-16). No submit was attempted
// (or none could succeed), so posted_at stays null. Auto-retrying without a
// human fixing the underlying access problem (join the group, or switch
// posting identity) would just fail identically every time.
async function markTerminal(postId, status, reason) {
  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status, post_url: null, failure_reason: reason || null }),
  });
}

// The submit genuinely happened -- Facebook accepted the post and queued it
// for a group admin to review before it appears in the feed. This is NOT a
// posting failure and must never trip the shared circuit breaker (2026-09-14
// incident: a44e8758 to "Realtors San Antonio, Boerne, Bulverde, New
// Braunfels" landed in the group's moderation queue, got misread as a
// verify failure, and silently halted comment + reply posting for ~24h).
// posted_at IS stamped (a real submit occurred -- don't let the spacing gate
// or dedupe treat this slot as free) but post_url stays null since there is
// no live permalink to watch/comment on yet.
async function markPendingApproval(postId, groupRegistryId) {
  const now = new Date().toISOString();

  await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'pending_admin_approval', posted_at: now, post_url: null }),
  });

  if (groupRegistryId) {
    await supabaseFetch(`/rest/v1/group_registry?id=eq.${encodeURIComponent(groupRegistryId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_posted_at: now }),
    });
  }
}

// ─── Pending-admin-approval detection ─────────────────────────────────────────
// See scripts/_lib/fb-pending-approval-detect.js for the pattern list and
// rationale (extracted so it's testable without launching a browser).

const { detectPendingApproval } = require('./_lib/fb-pending-approval-detect');

// ─── Identity-rejected / not-a-member detection ───────────────────────────────
// See scripts/_lib/fb-group-access-detect.js. Per-group truth audit,
// 2026-09-16: the acting identity is the Page, not Heath's personal
// profile, and some groups block or never admitted it.

const { detectIdentityRejected, detectNotAMember } = require('./_lib/fb-group-access-detect');

// ─── Post-outcome resolver (pure, unit-tested) ────────────────────────────────
// See scripts/_lib/fb-post-verify-outcome.js. This is where the false-
// 'posted' bug (2026-09-16) is actually closed: status='posted' requires
// positive evidence, full stop.

const { resolvePostStatus } = require('./_lib/fb-post-verify-outcome');

// ─── Telegram confirmation ────────────────────────────────────────────────────

async function sendTelegramConfirmation(groupName, postBody, success, errorMsg, statusLabel) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const preview = String(postBody || '').slice(0, 100);
  const text = success
    ? (statusLabel
      ? `Submitted to ${groupName} (${statusLabel})\n\n${preview}...`
      : `Posted to ${groupName}\n\n${preview}...`)
    : `Failed to post to ${groupName}: ${errorMsg}`;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  }).catch((err) => {
    console.warn('[fb-group-poster] Telegram notification failed:', err.message);
  });
}

// ─── Post first comment (on the same page instance after main post) ────────────

async function postFirstComment(page, firstCommentBody) {
  if (!firstCommentBody) {
    console.log('[fb-group-poster] No first_comment_body — skipping first comment');
    return true;
  }

  console.log('[fb-group-poster] Posting first comment...');

  try {
    await page.waitForTimeout(2000);

    // Find the most recent article (the post we just posted)
    const articles = await page.locator('[role="article"]').all();
    if (!articles.length) {
      console.warn('[fb-group-poster] No articles found on page - first comment skipped');
      return false;
    }

    const firstArticle = articles[0];

    // Look for the comment button within the article
    const commentBtn = firstArticle.locator('button').filter({ hasText: /Comment/ }).first();
    if (await commentBtn.isVisible({ timeout: 3000 })) {
      await commentBtn.click();
      console.log('[fb-group-poster] Clicked Comment button');
      await page.waitForTimeout(1000);
    } else {
      console.warn('[fb-group-poster] Comment button not found');
      return false;
    }

    // Find the comment input box
    const commentInputSelectors = [
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"]',
      'textarea',
    ];

    let commentInput = null;
    for (const selector of commentInputSelectors) {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 3000 }).catch(() => false)) {
        commentInput = el;
        console.log(`[fb-group-poster] Found comment input via: ${selector}`);
        break;
      }
    }

    if (!commentInput) {
      console.warn('[fb-group-poster] Comment input not found');
      return false;
    }

    // Click and type the comment
    await commentInput.click();
    await page.keyboard.type(firstCommentBody, { delay: 20 });
    await page.waitForTimeout(500);

    // Find and click the Post button for the comment
    const commentPostBtnSelectors = [
      'button:has-text("Post")',
      'button[aria-label*="Post"]',
      'button[type="submit"]',
    ];

    let commentPostBtn = null;
    for (const selector of commentPostBtnSelectors) {
      try {
        const btn = page.locator(selector).last();
        if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
          commentPostBtn = btn;
          break;
        }
      } catch {}
    }

    if (!commentPostBtn) {
      console.warn('[fb-group-poster] Comment Post button not found');
      return false;
    }

    await commentPostBtn.click();
    console.log('[fb-group-poster] Comment posted successfully');
    await page.waitForTimeout(1000);
    return true;
  } catch (err) {
    console.warn('[fb-group-poster] Error posting first comment:', err.message);
    return false;
  }
}

// ─── Playwright posting ───────────────────────────────────────────────────────

async function postToGroup(post) {
  const { chromium } = require('playwright');

  console.log('[fb-group-poster] Launching Heath\'s persistent Chrome profile...');

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();

  try {
    console.log(`[fb-group-poster] Navigating to ${post.group_url}`);
    await page.goto(post.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the page to settle
    await page.waitForTimeout(3000);

    // Check if the session has expired — the Chrome profile should always
    // be logged in, but if it isn't, fail loudly without pinging Heath. The
    // keep-alive cron (scripts/fb-session-keepalive.js) and the comment
    // monitor reuse the same profile, so this should not regress in practice.
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      throw new Error('Facebook redirected to login from persistent Chrome profile — open Chrome manually and re-login. Keep-alive cron should prevent this.');
    }

    // Dismiss any auto-opened dialog/overlay (Facebook sometimes opens a
    // Story composer or notification popup on group landing).
    try {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(800);
    } catch {}

    // Identity/membership gate — checked BEFORE hunting for the post box.
    // Per-group truth audit (2026-09-16): the acting identity was the Page
    // "Heath Shepard, Realtor with Keller Williams City View", not Heath's
    // personal profile. Some groups block Pages outright (Founding Files:
    // "Switch to your main profile") or were never actually joined by it
    // (Stone Oak Neighborhood: "Join group" live). Both are real, distinct,
    // non-retryable outcomes -- return early rather than let the composer
    // hunt below fall through to a generic "layout may have changed" error.
    // UPDATE 2026-09-17: DossieBot-Sage is now confirmed on Heath's PERSONAL
    // profile (facebook.com/heath.shepard.75) instead -- see
    // scripts/_lib/fb-group-access-detect.js and scripts/comment-hunt-
    // groups.json for the full correction. These two detectors match
    // Facebook's rejection/join-prompt text, not the identity itself, so they
    // still apply unchanged under either identity.
    if (await detectIdentityRejected(page)) {
      return resolvePostStatus({ identityRejected: true });
    }
    if (await detectNotAMember(page)) {
      return resolvePostStatus({ notAMember: true });
    }

    // Find the "Write something" / "What's on your mind?" post box.
    // Facebook uses multiple selectors; we prefer specific aria-labels and
    // ignore the generic tabindex=0 div fallback because it's nearly always
    // an unrelated wrapper.
    const postBoxSelectors = [
      '[aria-label*="Write something"]',
      '[aria-label*="What\'s on your mind"]',
      '[aria-label="Write something..."]',
      '[aria-label="What\'s on your mind?"]',
      '[data-testid="status-attachment-mentions-input"]',
    ];

    let postBox = null;
    for (const selector of postBoxSelectors) {
      try {
        postBox = await page.waitForSelector(selector, { timeout: 5000 });
        if (postBox) {
          console.log(`[fb-group-poster] Found post box via selector: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    // Fallback: look for text matching common prompts
    if (!postBox) {
      const textMatches = [
        'Write something...',
        "What's on your mind?",
        'Share something with this group',
      ];
      for (const text of textMatches) {
        try {
          const cand = page.getByText(text, { exact: false }).first();
          if (await cand.isVisible({ timeout: 3000 })) {
            postBox = await cand.elementHandle();
            console.log(`[fb-group-poster] Found post box via text: "${text}"`);
            break;
          }
        } catch {
          continue;
        }
      }
    }

    if (!postBox) {
      // Second pass, in case the identity/membership signal only rendered
      // after the box-hunt (e.g. a late-loading banner) rather than on
      // initial page load.
      if (await detectIdentityRejected(page)) return resolvePostStatus({ identityRejected: true });
      if (await detectNotAMember(page)) return resolvePostStatus({ notAMember: true });
      throw new Error('Could not find the post input box on the group page. The group layout may have changed or you may not be a member.');
    }

    // Scroll the post box into view and click. If a transparent overlay
    // intercepts pointer events (Facebook quirk where the inline composer
    // sits behind a backdrop div on Public groups), fall back to a direct
    // dispatchEvent which bypasses pointer-event interception.
    try {
      await postBox.scrollIntoViewIfNeeded();
    } catch {}
    try {
      await postBox.click({ timeout: 10000 });
    } catch (clickErr) {
      console.warn('[fb-group-poster] Normal click intercepted, falling back to force click + dispatchEvent');
      try {
        await postBox.click({ force: true, timeout: 10000 });
      } catch {
        await postBox.evaluate((el) => {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        });
      }
    }
    await page.waitForTimeout(4000);

    // Look for the expanded text input area
    // After clicking, Facebook expands a modal or inline editor
    const editorSelectors = [
      '[role="dialog"] div[contenteditable="true"]',
      '[role="dialog"] [contenteditable="true"]',
      '[role="dialog"] [contenteditable]',
      'div[contenteditable="true"][role="textbox"]',
      '[data-lexical-editor="true"]',
      '[aria-label="Write something..."][contenteditable="true"]',
      '[aria-label="What\'s on your mind?"][contenteditable="true"]',
      'div[contenteditable="true"]',
      '[contenteditable]',
    ];

    let editor = null;
    for (const selector of editorSelectors) {
      try {
        const candidate = await page.waitForSelector(selector, { timeout: 5000 });
        if (candidate) {
          editor = candidate;
          console.log(`[fb-group-poster] Found editor via: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    if (!editor) {
      throw new Error('Could not find the text editor after clicking post box. Facebook layout may have changed.');
    }

    // Click the editor to focus it and wait for cursor to settle
    await editor.click();
    await page.waitForTimeout(1000);

    // Type the post body character by character (natural typing)
    console.log(`[fb-group-poster] Typing post body (${post.post_body.length} chars)...`);
    await page.keyboard.type(post.post_body, { delay: 30 });
    await page.waitForTimeout(1500);

    // Verify text was typed by checking the editor content
    const editorText = await editor.innerText().catch(() => '');
    if (!editorText.trim()) {
      throw new Error('Post body did not appear in the editor after typing. The editor may not have accepted input.');
    }

    // Find and click the Post button
    const postButtonSelectors = [
      '[role="dialog"] div[aria-label="Post"][role="button"]',
      '[role="dialog"] button[type="submit"]',
      'div[aria-label="Post"][role="button"]',
      'button[type="submit"]',
      '[data-testid="react-composer-post-button"]',
    ];

    let postButton = null;
    for (const selector of postButtonSelectors) {
      try {
        const btn = await page.locator(selector).last();
        if (await btn.isVisible({ timeout: 3000 }) && await btn.isEnabled({ timeout: 3000 })) {
          postButton = btn;
          console.log(`[fb-group-poster] Found Post button via: ${selector}`);
          break;
        }
      } catch {
        continue;
      }
    }

    // Fallback: find button with text "Post"
    if (!postButton) {
      try {
        postButton = page.getByRole('button', { name: 'Post' }).last();
        if (await postButton.isVisible({ timeout: 3000 })) {
          console.log('[fb-group-poster] Found Post button via role/name');
        } else {
          postButton = null;
        }
      } catch {
        postButton = null;
      }
    }

    if (!postButton) {
      throw new Error('Could not find the Post button. The composer may not have fully loaded.');
    }

    console.log('[fb-group-poster] Clicking Post button...');
    await postButton.click();

    // Wait up to 30s, watching for the two known non-failure submit
    // outcomes. composerClosed is recorded as a WEAK signal only -- a click
    // happened -- it is deliberately never treated as proof of a live post
    // (that was the 2026-09-16 false-'posted' bug: composer-closed alone,
    // or "no error after 30s" alone, both used to satisfy verification).
    console.log('[fb-group-poster] Waiting for post confirmation...');
    let pendingApproval = false;
    let composerClosed = false;
    let fbErrorText = null;
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(3000);

      // Check for the group's "sent to admins for approval" notice FIRST --
      // this can show up either before or after the composer closes, and it
      // is a successful submit, not a failure. Must not fall through to the
      // generic error-alert check below, which would misread it as one.
      if (await detectPendingApproval(page)) {
        pendingApproval = true;
        console.log('[fb-group-poster] Post submitted but requires group admin approval (pending_admin_approval) -- not a failure');
        break;
      }

      if (!composerClosed) {
        composerClosed = !(await page.locator('div[contenteditable="true"]').isVisible().catch(() => false));
        if (composerClosed) {
          console.log('[fb-group-poster] Composer closed -- a submit occurred, still needs positive evidence before counting as posted');
        }
      }

      // Check for error message
      const errorEl = await page.locator('[data-testid="error-message"], [role="alert"]').first();
      const errorVisible = await errorEl.isVisible().catch(() => false);
      if (errorVisible) {
        fbErrorText = await errorEl.innerText().catch(() => 'unknown error');
        break;
      }
    }

    if (pendingApproval) {
      // No permalink exists yet (post isn't in the feed until a mod
      // approves it) and there's nothing to attach a first comment to.
      return resolvePostStatus({ pendingApproval: true });
    }

    // ── Positive-evidence search ──────────────────────────────────────────
    // Runs regardless of composerClosed/fbErrorText -- an error banner can
    // be stale/unrelated, and a still-open composer doesn't rule out the
    // post having rendered behind it. Only real evidence here can produce
    // status='posted'.

    // 1. Real permalink. Facebook renders a timestamp
    //    <a href="/groups/.../posts/..."> once the post appears.
    let postUrl = null;
    try {
      await page.waitForTimeout(3000);
      const links = await page.$$('a[href*="/posts/"]');
      for (const link of links) {
        const href = await link.getAttribute('href').catch(() => null);
        if (!href) continue;
        const absolute = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
        // Must look like a group post URL: /groups/[id]/posts/[id]
        if (/\/groups\/[^/]+\/posts\/\d+/.test(absolute)) {
          postUrl = absolute.split('?')[0]; // strip query params
          console.log(`[fb-group-poster] Captured post permalink: ${postUrl}`);
          break;
        }
      }
    } catch (err) {
      console.warn('[fb-group-poster] Could not capture post permalink:', err.message);
    }

    // 2. No permalink element found -- fall back to locating the post's own
    //    text in the visible feed (the instructions' "or the post located
    //    in the group feed afterward" case). NEVER falls back to the bare
    //    group_url as a stand-in postUrl (2026-09-16 fix) -- that string
    //    used to satisfy the old "posted && postUrl" truthy check in main()
    //    with zero evidence anything published.
    let feedConfirmed = false;
    if (!postUrl) {
      feedConfirmed = await confirmPostInFeed(page, post.post_body);
      if (feedConfirmed) {
        console.log('[fb-group-poster] No permalink element, but post text located in the group feed -- counting as posted (unharvestable for comments, no /posts/ link)');
      }
    }

    const outcome = resolvePostStatus({
      errorShown: !!fbErrorText,
      errorText: fbErrorText,
      permalinkFound: !!postUrl,
      feedConfirmed,
    });

    if (outcome.status !== 'posted') {
      return { ...outcome, postUrl: null };
    }

    // Post first comment if needed (keeps page open) -- only for a
    // confirmed-posted outcome; nothing to comment on otherwise.
    if (post.first_comment_body) {
      console.log('[fb-group-poster] Posting first comment...');
      const firstCommentSuccess = await postFirstComment(page, post.first_comment_body);
      if (firstCommentSuccess) {
        // Update DB to mark first comment as posted
        await supabaseFetch(`/rest/v1/group_posts?id=eq.${encodeURIComponent(post.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ first_comment_posted_at: new Date().toISOString() }),
        });
        console.log('[fb-group-poster] First comment posted and DB updated');
      } else {
        console.warn('[fb-group-poster] First comment posting failed - continuing anyway');
      }
    }

    return { status: 'posted', postUrl, permalinkCaptured: !!postUrl, reason: null };
  } finally {
    await context.close();
  }
}

// Secondary positive-evidence check: search the visible feed for a
// distinctive snippet of the post body we just submitted. Used only when no
// permalink element could be found. Deliberately requires a reasonably long,
// low-collision snippet (first 40 non-trivial chars) rather than a single
// word, to avoid a false match against someone else's unrelated post.
async function confirmPostInFeed(page, postBody) {
  const snippet = String(postBody || '').trim().slice(0, 40);
  if (snippet.length < 15) return false; // too short to be a reliable signal
  try {
    const match = page.getByText(snippet, { exact: false }).first();
    return await match.isVisible({ timeout: 5000 }).catch(() => false);
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[fb-group-poster] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }

  // Preflight: close any facebook.com tabs in Heath's main Chrome so they
  // don't race with the DossieBot-Sage automation profile.
  try {
    const { preflight } = require('./_lib/fb-tab-preflight');
    const pre = await preflight({ reason: 'fb-group-poster' });
    console.log(`[fb-group-poster] preflight: closed=${pre.closed} skipped_dossiebot=${pre.skipped_dossiebot}`);
  } catch (e) {
    console.warn(`[fb-group-poster] preflight non-fatal error: ${e.message}`);
  }

  // Profile unlock: kill any stale chrome.exe still holding a lock on the
  // DossieBot-Sage user-data-dir. Addresses Sage's "Chrome-lock failures"
  // (2 of 7 group posts 2026-06-11) where a prior launchPersistentContext
  // didn't exit cleanly and left Singleton* lockfiles in place. Waits 2s
  // after kill so the kernel releases handles before we launch.
  try {
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    const unlocked = await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'fb-group-poster' });
    if (unlocked.killed > 0) {
      console.log(`[fb-group-poster] profile-unlock: killed ${unlocked.killed} stale chrome process(es) for ${CHROME_PROFILE_PATH}`);
    }
  } catch (e) {
    console.warn(`[fb-group-poster] profile-unlock non-fatal error: ${e.message}`);
  }

  console.log(`[fb-group-poster] Fetching post ${POST_ID}`);
  const post = await fetchPost(POST_ID);

  if (!post) {
    console.error(`[fb-group-poster] Post ${POST_ID} not found in group_posts`);
    process.exit(1);
  }

  if (post.status !== 'approved') {
    console.error(`[fb-group-poster] Post ${POST_ID} has status="${post.status}", expected "approved". Aborting.`);
    process.exit(1);
  }

  if (!post.group_url || post.group_url.includes('PLACEHOLDER')) {
    console.error(`[fb-group-poster] Group URL for "${post.group_name}" is still a placeholder: ${post.group_url}`);
    console.error('[fb-group-poster] Update the group_url in the group_registry table first.');
    process.exit(1);
  }

  console.log(`[fb-group-poster] Posting to "${post.group_name}" (${post.group_url})`);
  console.log(`[fb-group-poster] Template: ${post.template_id} | Pillar: ${post.pillar}`);

  let result = null;
  let errorMsg = null;

  try {
    result = await postToGroup(post);
  } catch (err) {
    errorMsg = err.message;
    console.error('[fb-group-poster] Playwright error:', err.message);
  }

  if (result && result.status === 'posted') {
    // postUrl may be null here (feed-text-confirmed but no /posts/ link
    // element found) -- status alone is the posted/not-posted decision now,
    // never `&& result.postUrl` (that gate is exactly what let the old
    // group_url fallback masquerade as evidence).
    await markPosted(POST_ID, post.group_registry_id, result.postUrl);
    console.log(`[fb-group-poster] Success - updated status to "posted", post_url: ${result.postUrl || '(none — feed-confirmed only)'}`);
    const statusLabel = !result.postUrl
      ? 'permalink NOT captured — comments on this post cannot be auto-harvested'
      : null;
    await sendTelegramConfirmation(post.group_name, post.post_body, true, null, statusLabel);

    // Part 2 (comment_watchlist, Sage 2026-08-28): "heath_own_post" direction.
    // Fires automatically on a real confirmed post -- fb-group-poster.js is
    // the pre-existing, CLAUDE.md-sanctioned exception that does post
    // autonomously (RULE 4), unlike the comment/reply pipeline this table
    // otherwise only feeds from confirmed-by-Heath actions. Also covers the
    // daily5 pipeline (api/_lib/daily-group5-post-generator.js) -- same
    // markPosted path, no separate wiring needed. Only registered when a
    // real permalink exists -- nothing to watch without one.
    if (result.postUrl) {
      const { registerGroupPostWatch } = require('./_lib/group-post-watchlist');
      await registerGroupPostWatch(supabaseFetch, post, POST_ID, result.postUrl)
        .catch((err) => console.warn('[fb-group-poster] comment_watchlist insert non-fatal:', err && err.message));
    }
  } else if (result && result.status === 'pending_admin_approval') {
    // Genuine submit -- Facebook queued it for a group admin's review. This
    // is a SUCCESSFUL run (exit 0), not a failure: the queue-runner reads
    // this status back and must not treat it as a verify failure / halt the
    // shared circuit breaker. No live post_url yet, so no watchlist entry.
    await markPendingApproval(POST_ID, post.group_registry_id);
    console.log('[fb-group-poster] Submitted - status "pending_admin_approval" (awaiting a group admin, not a failure)');
    await sendTelegramConfirmation(post.group_name, post.post_body, true, null, 'pending admin approval');
  } else if (result && (result.status === 'not_a_member' || result.status === 'identity_rejected')) {
    // Terminal, not retryable without a human fixing access (join the
    // group, or switch posting identity). Per-group truth audit, 2026-09-16.
    await markTerminal(POST_ID, result.status, result.reason);
    console.log(`[fb-group-poster] Terminal - status "${result.status}": ${result.reason}`);
    await sendTelegramConfirmation(post.group_name, post.post_body, false, `${result.status.toUpperCase().replace(/_/g, ' ')} — ${result.reason} (will NOT auto-retry; needs a human fix)`);
    process.exit(1);
  } else if (result && result.status === 'failed') {
    // A submit action occurred (composer closed / an error banner appeared
    // after clicking Post) but neither a permalink nor a feed match
    // confirms the post exists. Do NOT reset to 'approved' for auto-retry --
    // if the original submit actually succeeded, retrying would create a
    // duplicate live post (Heath's "never retry an unverified send" rule).
    await markUnconfirmed(POST_ID, post.group_registry_id, result.reason);
    console.warn(`[fb-group-poster] UNCONFIRMED - status "failed": ${result.reason}`);
    await sendTelegramConfirmation(post.group_name, post.post_body, false, `UNCONFIRMED — ${result.reason}. Check Facebook manually before retrying.`);
    process.exit(1);
  } else {
    // No result object at all -- an exception was thrown before any submit
    // was attempted (login redirect, post box/editor never found, etc.).
    // Nothing was clicked that could have created a duplicate, so this is
    // still safe to reset to 'approved' for a normal retry.
    await markFailed(POST_ID, errorMsg || 'unknown error');
    await sendTelegramConfirmation(post.group_name, post.post_body, false, errorMsg);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[fb-group-poster] Fatal error:', err.message);
  process.exit(1);
});
