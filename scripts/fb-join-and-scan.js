'use strict';

// scripts/fb-join-and-scan.js
//
// Open a Facebook group URL using Heath's persistent Chrome profile.
// 1. If we're not a member, click Join / Request to Join.
// 2. If a "why do you want to join?" question gates the join, fill it.
// 3. If joined immediately, scan the last 48h of posts for a TC-pain target
//    and print structured JSON to stdout (no auto-comment).
// 4. Always save a screenshot + page HTML snapshot for review.
//
// Usage:
//   node scripts/fb-join-and-scan.js --url "https://www.facebook.com/groups/236047010341691/"

const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_PROFILE_PATH = path.join(
  os.homedir(),
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);

// Load .env.local
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
} catch (e) {}

const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const GROUP_URL = urlIdx >= 0 ? args[urlIdx + 1] : null;

if (!GROUP_URL) {
  console.error('Usage: node scripts/fb-join-and-scan.js --url "<group_url>"');
  process.exit(1);
}

const JOIN_ANSWER = "Texas REALTOR based in Boerne, building tools for real estate agents — would love to learn from this community.";

const SCRIPT_DIR = __dirname;
const RUN_DIR = path.join(SCRIPT_DIR, 'atlas-runs', `join-scan-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

function log(...a) {
  console.log('[fb-join-and-scan]', ...a);
}

async function main() {
  const { chromium } = require('playwright');

  log('Launching persistent Chrome profile...');
  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
      channel: 'chrome',
    });
  } catch (err) {
    log('FATAL launch error:', err.message);
    fs.writeFileSync(path.join(RUN_DIR, 'launch-error.txt'), err.stack || err.message);
    process.exit(2);
  }

  const page = await context.newPage();
  const result = {
    url: GROUP_URL,
    timestamp: new Date().toISOString(),
    membership_state: null,
    join_action: null,
    posts_scanned: 0,
    target_post: null,
    notes: [],
  };

  try {
    log(`Navigating to ${GROUP_URL}`);
    await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
      result.membership_state = 'logged_out';
      result.notes.push('Facebook redirected to login. Persistent profile session expired.');
      throw new Error('logged_out');
    }

    // Screenshot initial state
    await page.screenshot({ path: path.join(RUN_DIR, '01-initial.png'), fullPage: false });

    // Grab the group header to detect membership state
    const pageText = await page.evaluate(() => document.body.innerText.slice(0, 5000));
    fs.writeFileSync(path.join(RUN_DIR, 'page-text.txt'), pageText);

    // Detect membership via visible buttons
    // Possible states:
    //   - "Join group" / "Join Group" — not a member, open group
    //   - "Request to join" — not a member, gated group
    //   - "Cancel request" / "Requested" — pending
    //   - "Joined" / "Invite" / "Share" — already a member
    //   - "Visible" / "Public group" with "Write something" — member
    const joinedSignals = await page.evaluate(() => {
      const out = { joined: false, pending: false, canJoin: false, joinButtonText: null };
      const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
      for (const b of buttons) {
        const t = (b.innerText || b.textContent || '').trim();
        if (!t) continue;
        if (/^Joined$/i.test(t)) out.joined = true;
        if (/^Invite$/i.test(t) && b.offsetParent) out.joined = true;
        if (/^Cancel request$/i.test(t) || /^Requested$/i.test(t)) out.pending = true;
        if (/^Join group$/i.test(t) || /^Join Group$/i.test(t)) {
          out.canJoin = true;
          out.joinButtonText = t;
        }
        if (/^Request to Join$/i.test(t) || /^Request to join$/i.test(t)) {
          out.canJoin = true;
          out.joinButtonText = t;
        }
      }
      return out;
    });

    log('Membership signals:', JSON.stringify(joinedSignals));

    if (joinedSignals.pending) {
      result.membership_state = 'pending';
      result.notes.push('Join request already pending admin approval.');
    } else if (joinedSignals.joined) {
      result.membership_state = 'member';
    } else if (joinedSignals.canJoin) {
      result.membership_state = 'not_member';
      log(`Found join button: "${joinedSignals.joinButtonText}". Clicking...`);

      // Click the join button
      const joinBtn = page.locator(`[role="button"]:has-text("${joinedSignals.joinButtonText}"), button:has-text("${joinedSignals.joinButtonText}")`).first();
      try {
        await joinBtn.scrollIntoViewIfNeeded({ timeout: 5000 });
        await joinBtn.click({ timeout: 8000 });
        result.join_action = 'clicked_join';
        await page.waitForTimeout(4000);
        await page.screenshot({ path: path.join(RUN_DIR, '02-after-click.png') });

        // After click, FB may open a dialog with membership questions
        const dialogText = await page.evaluate(() => {
          const dlg = document.querySelector('[role="dialog"]');
          return dlg ? dlg.innerText.slice(0, 4000) : null;
        });
        if (dialogText) {
          fs.writeFileSync(path.join(RUN_DIR, 'join-dialog.txt'), dialogText);
          log('Join dialog appeared. Text length:', dialogText.length);

          // Look for a textarea / contenteditable question
          const questionFilled = await page.evaluate((answer) => {
            const dlg = document.querySelector('[role="dialog"]');
            if (!dlg) return false;
            const ta = dlg.querySelector('textarea');
            if (ta) {
              const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
              nativeInputValueSetter.call(ta, answer);
              ta.dispatchEvent(new Event('input', { bubbles: true }));
              return 'textarea';
            }
            const ce = dlg.querySelector('[contenteditable="true"]');
            if (ce) {
              ce.focus();
              return 'contenteditable';
            }
            return false;
          }, JOIN_ANSWER);

          if (questionFilled === 'contenteditable') {
            await page.keyboard.type(JOIN_ANSWER, { delay: 25 });
          }

          if (questionFilled) {
            log(`Filled join answer via ${questionFilled}.`);
            result.join_action = `clicked_join+filled_${questionFilled}`;
            await page.waitForTimeout(1500);
            await page.screenshot({ path: path.join(RUN_DIR, '03-answer-filled.png') });

            // Click submit
            const submitClicked = await page.evaluate(() => {
              const dlg = document.querySelector('[role="dialog"]');
              if (!dlg) return false;
              const btns = Array.from(dlg.querySelectorAll('[role="button"], button'));
              for (const b of btns) {
                const t = (b.innerText || b.textContent || '').trim();
                if (/^Submit$/i.test(t) || /^Send$/i.test(t) || /^Done$/i.test(t) || /^Request$/i.test(t)) {
                  b.click();
                  return t;
                }
              }
              return false;
            });
            if (submitClicked) {
              log(`Clicked dialog submit button: "${submitClicked}"`);
              result.join_action += `+submit_${submitClicked}`;
              await page.waitForTimeout(5000);
            }
          }
        }

        // Re-check state
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(RUN_DIR, '04-after-submit.png') });

        const postClick = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('[role="button"], button'));
          const out = { joined: false, pending: false };
          for (const b of buttons) {
            const t = (b.innerText || b.textContent || '').trim();
            if (/^Joined$/i.test(t)) out.joined = true;
            if (/^Cancel request$/i.test(t) || /^Requested$/i.test(t)) out.pending = true;
          }
          return out;
        });
        if (postClick.joined) {
          result.membership_state = 'member';
          result.notes.push('Admitted instantly after join.');
        } else if (postClick.pending) {
          result.membership_state = 'pending';
          result.notes.push('Join request submitted; awaiting admin approval.');
        } else {
          result.notes.push('Post-click state unclear — review screenshots.');
        }
      } catch (clickErr) {
        result.notes.push(`Join click failed: ${clickErr.message}`);
      }
    } else {
      result.membership_state = 'unknown';
      result.notes.push('Could not detect join button or membership state. Review screenshot 01.');
    }

    // If we're a member, scan recent posts for TC-pain targets
    if (result.membership_state === 'member') {
      log('Member — scanning recent posts...');
      await page.waitForTimeout(2000);

      // Scroll a few times to load recent posts
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => window.scrollBy(0, 1200));
        await page.waitForTimeout(1500);
      }

      const posts = await page.evaluate(() => {
        // Each feed post on FB is a <div role="article">
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        return articles.slice(0, 20).map((a) => {
          const txt = (a.innerText || '').slice(0, 1500);
          // Try to find permalink
          const links = Array.from(a.querySelectorAll('a[href*="/groups/"][href*="/posts/"], a[href*="/groups/"][href*="/permalink/"]'));
          const permalink = links.length ? links[0].href : null;
          return { text: txt, permalink };
        });
      });

      result.posts_scanned = posts.length;
      fs.writeFileSync(path.join(RUN_DIR, 'posts.json'), JSON.stringify(posts, null, 2));

      // Score for TC / pain / overwhelm signals
      const KEYWORDS = [
        'transaction coordinator', 'tc quit', 'my tc', 'looking for a tc',
        'overwhelmed', 'paperwork', 'drowning', 'need help',
        'deadline', 'option period', 'amendment', 'closing',
        'stressed', 'losing my mind', 'too many deals', 'juggling',
        'compliance', 'follow-up', 'follow up',
      ];

      let best = null;
      for (const p of posts) {
        const lower = (p.text || '').toLowerCase();
        const hits = KEYWORDS.filter((k) => lower.includes(k));
        if (hits.length > 0) {
          const score = hits.length;
          if (!best || score > best.score) {
            best = { ...p, hits, score };
          }
        }
      }

      if (best) {
        result.target_post = best;
        log(`Found target with ${best.score} keyword hits.`);
      } else {
        log('No TC-pain target in recent posts.');
      }
    }
  } catch (err) {
    if (err.message !== 'logged_out') {
      log('ERROR:', err.message);
      result.notes.push(`Error: ${err.message}`);
    }
  } finally {
    fs.writeFileSync(path.join(RUN_DIR, 'result.json'), JSON.stringify(result, null, 2));
    console.log('\n=====RESULT=====');
    console.log(JSON.stringify(result, null, 2));
    console.log('=====END=====');
    console.log('Run dir:', RUN_DIR);
    await context.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
