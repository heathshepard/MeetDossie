'use strict';

// Step 4: Wait the 10-min veto window (or detect early rejection via DB), then
// post the approved comment via Playwright + saved Reddit session.

const path = require('path');
const fs = require('fs');

// Load env
try {
  const envPath = path.join(__dirname, '..', '..', '..', '.env.local');
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
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Claudy
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const queueState = JSON.parse(fs.readFileSync(path.join(__dirname, 'queue-result.json'), 'utf8'));
const fixState = JSON.parse(fs.readFileSync(path.join(__dirname, 'fix-result.json'), 'utf8'));
const DRAFT_ID = queueState.draft_id;
const COMMENT_TEXT = fixState.final_draft;
const POST_URL = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';
const POST_FULLNAME = 't3_1u0piq6';

const VETO_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 30 * 1000;     // 30 seconds

async function getRowStatus() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/reddit_engagements?id=eq.${encodeURIComponent(DRAFT_ID)}&select=status`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] && rows[0].status;
}

async function patchRow(patch) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/reddit_engagements?id=eq.${encodeURIComponent(DRAFT_ID)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }
  );
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
}

async function postComment() {
  const { chromium } = require('playwright');
  const sessionPath = path.join(__dirname, '..', '..', 'sessions', 'reddit.json');
  const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    storageState: state,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();

  console.log('[post] Navigating to post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  await page.screenshot({ path: path.join(__dirname, 'post-step1-loaded.png'), fullPage: false });

  // Find the comment input box.
  // shreddit-composer or simple <textarea> on new Reddit.
  // Click "Join the conversation" / comment box first.
  const editorFound = await page.evaluate(() => {
    // Try several selectors
    const candidates = [
      'shreddit-composer',
      '[name="text"]',
      'textarea[placeholder*="Join the conversation"]',
      'textarea[placeholder*="What are your thoughts"]',
      '[contenteditable="true"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        return { sel, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, visible: r.width > 0 };
      }
    }
    return null;
  });
  console.log('[post] Editor probe:', JSON.stringify(editorFound));

  if (!editorFound) {
    await page.screenshot({ path: path.join(__dirname, 'post-fail-no-editor.png'), fullPage: true });
    await browser.close();
    return { ok: false, reason: 'no editor element' };
  }

  // Click the editor to activate
  await page.mouse.click(
    editorFound.rect.x + editorFound.rect.w / 2,
    editorFound.rect.y + editorFound.rect.h / 2
  );
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, 'post-step2-editor-active.png'), fullPage: false });

  // Find the contenteditable that just appeared (often after activation)
  const activeEditor = await page.evaluate(() => {
    // The expanded editor is typically a contenteditable inside shreddit-composer
    function find(root, depth = 0) {
      if (depth > 6 || !root) return null;
      const ce = root.querySelector ? root.querySelector('[contenteditable="true"]') : null;
      if (ce) {
        const r = ce.getBoundingClientRect();
        if (r.width > 100 && r.height > 30) {
          return { rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
        }
      }
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) {
          const f = find(el.shadowRoot, depth + 1);
          if (f) return f;
        }
      }
      return null;
    }
    return find(document);
  });
  console.log('[post] Active editor:', JSON.stringify(activeEditor));

  if (activeEditor) {
    // Focus and clear, then type
    await page.mouse.click(
      activeEditor.rect.x + activeEditor.rect.w / 2,
      activeEditor.rect.y + activeEditor.rect.h / 2
    );
    await page.waitForTimeout(700);
  }

  // Type the comment — preserve paragraph breaks
  // contenteditable: type literal text + Shift+Enter for soft line breaks where needed
  // For Reddit, plain Enter creates new paragraphs in the rich-text editor (Markdown mode)
  console.log('[post] Typing comment...');
  const paragraphs = COMMENT_TEXT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 8 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, 'post-step3-typed.png'), fullPage: false });

  // Find and click "Comment" submit button
  const submitResult = await page.evaluate(() => {
    const out = [];
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'button' || tag === 'faceplate-button' || el.getAttribute && el.getAttribute('role') === 'button') {
            const t = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && /^comment$|^post$|^reply$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              out.push({ tag, txt: t, disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        } catch {}
      }
    }
    walk(document);
    return out;
  });
  console.log('[post] Submit candidates:', JSON.stringify(submitResult));

  const enabled = submitResult.find(b => !b.disabled);
  if (!enabled) {
    await page.screenshot({ path: path.join(__dirname, 'post-fail-no-submit.png'), fullPage: true });
    await browser.close();
    return { ok: false, reason: 'no enabled submit button', candidates: submitResult };
  }

  await page.mouse.click(
    enabled.rect.x + enabled.rect.w / 2,
    enabled.rect.y + enabled.rect.h / 2
  );
  console.log('[post] Submit clicked');
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(__dirname, 'post-step4-submitted.png'), fullPage: false });

  // After post, the new comment should appear at top of comments.
  // Find the most recent comment authored by Icy_Response3978.
  const newComment = await page.evaluate(() => {
    const comments = document.querySelectorAll('shreddit-comment[author="Icy_Response3978"]');
    let newest = null;
    let newestTs = 0;
    for (const c of comments) {
      const ts = parseInt(c.getAttribute('created-timestamp-ms') || c.getAttribute('created-ts') || '0', 10);
      if (ts > newestTs) {
        newestTs = ts;
        newest = c;
      }
    }
    if (!newest) {
      // Fall back to first one
      if (comments.length > 0) newest = comments[0];
    }
    if (!newest) return null;
    return {
      thingid: newest.getAttribute('thingid'),
      permalink: newest.getAttribute('permalink'),
      created: newest.getAttribute('created-timestamp') || newest.getAttribute('created'),
      body_snippet: (newest.innerText || '').slice(0, 200),
    };
  });
  console.log('[post] New comment found:', JSON.stringify(newComment));

  await browser.close();

  if (!newComment || !newComment.thingid) {
    return { ok: false, reason: 'submitted but no new comment detected' };
  }

  const permalink = newComment.permalink
    ? (newComment.permalink.startsWith('http') ? newComment.permalink : `https://www.reddit.com${newComment.permalink}`)
    : POST_URL;

  return { ok: true, thingid: newComment.thingid, permalink, body_snippet: newComment.body_snippet };
}

async function main() {
  const startTs = Date.now();
  console.log(`[wait] Veto window: ${VETO_WINDOW_MS / 60000} minutes. Polling every ${POLL_INTERVAL_MS / 1000}s.`);

  while (Date.now() - startTs < VETO_WINDOW_MS) {
    const status = await getRowStatus();
    console.log(`[wait] t+${Math.round((Date.now() - startTs) / 1000)}s — status: ${status}`);

    if (status === 'approved') {
      console.log('[wait] Approved early. Posting now.');
      break;
    }
    if (status === 'stopped' || status === 'rejected') {
      console.log('[wait] Rejected/stopped. Aborting.');
      fs.writeFileSync(path.join(__dirname, 'final-result.json'), JSON.stringify({
        outcome: 'rejected', status, ts: new Date().toISOString(),
      }, null, 2));
      // Telegram Heath ONE message (Claudy bot)
      await sendTelegram(`Reddit repost aborted - Heath rejected via DossieMarketingBot.`);
      process.exit(0);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Veto expired or approved — post it
  console.log('[wait] Veto window passed (or approved). Posting now.');

  // Update status to 'approved' if still pending
  const finalStatus = await getRowStatus();
  if (finalStatus === 'pending') {
    await patchRow({ status: 'approved' });
  }

  const result = await postComment();

  if (!result.ok) {
    console.error('[wait] Post failed:', result.reason);
    await patchRow({ status: 'failed' });
    fs.writeFileSync(path.join(__dirname, 'final-result.json'), JSON.stringify({
      outcome: 'post_failed', reason: result.reason, candidates: result.candidates,
      ts: new Date().toISOString(),
    }, null, 2));
    await sendTelegram(`Reddit repost FAILED at post step: ${result.reason}`);
    process.exit(2);
  }

  // Update DB with new comment URL
  await patchRow({
    status: 'posted',
    posted_at: new Date().toISOString(),
    permalink: result.permalink,
  });

  fs.writeFileSync(path.join(__dirname, 'final-result.json'), JSON.stringify({
    outcome: 'posted',
    permalink: result.permalink,
    thingid: result.thingid,
    posted_at: new Date().toISOString(),
  }, null, 2));

  // Telegram ONE confirmation via Claudy
  await sendTelegram(`Reposted via Sage: ${result.permalink}`);

  console.log('[wait] DONE. Permalink:', result.permalink);
}

main().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
