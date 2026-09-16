#!/usr/bin/env node
/**
 * record-dossie-shortform-frames.js
 *
 * Captures REAL screen-recording frames of the live Dossie app as a vertical
 * (1170x2532) JPEG frame sequence, for short-form marketing video.
 *
 * WHY THIS SCRIPT EXISTS
 * ----------------------
 * A previous capture attempt filmed the LOGIN PAGE for 35 seconds because
 * sign-in silently failed and nobody checked. This script makes that
 * impossible: assertSignedIn() runs BEFORE a single frame is written and
 * hard-exits non-zero if the app is not genuinely signed in AND showing real
 * seeded data. Do not remove those assertions.
 *
 * USAGE
 *   node scripts/record-dossie-shortform-frames.js \
 *     --out /mnt/c/Users/Heath/dossie-capture-2026-09-16 \
 *     --flow pipeline-to-dossier \
 *     [--url https://meetdossie.com/app] \
 *     [--fps 10] [--quality 90] [--headed]
 *
 * FLOWS
 *   pipeline-to-dossier  (default) Morning Brief -> Pipeline Dashboard ->
 *                        open a dossier -> TREC deadlines + compliance gaps.
 *   pipeline-only        Pipeline Dashboard scroll only.
 *   brief-only           Today / Morning Brief scroll only.
 *   ask-dossie           D1. Opens the Talk-to-Dossie panel, types --question,
 *                        waits for the REAL text answer, asserts it is on
 *                        screen, and holds on it. Also writes <out>/answer.json
 *                        with the verbatim answer. TYPED question + TEXT answer
 *                        only (capability #11 WORKS); never imply voice (#12 is
 *                        PARTIAL/UNVERIFIED).
 *
 * OUTPUT
 *   <out>/frames/NNNNN.jpg     zero-padded JPEG frames
 *   <out>/frames.json          {"frames":[{"ts":<ms>,"f":"<abs path>"}, ...]}
 *   <out>/timeline.md          plain-language log of what is on screen when
 *   <out>/verify-signed-in.png proof screenshot taken before capture started
 *
 * CREDENTIALS
 *   Read from MeetDossie/.env.local (DEMO_PASSWORD) for demo@meetdossie.com.
 *   The password is NEVER printed, logged, or written to any output file.
 *   Only the demo account may ever be filmed - never a real customer login.
 */

const fs = require('fs');
const path = require('path');

const REPO = '/mnt/c/Users/Heath/Projects/MeetDossie';
const { chromium } = require(path.join(REPO, 'node_modules/playwright'));

// ---------------------------------------------------------------- args ----
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const flag = (name) => process.argv.includes('--' + name);

const OUT_DIR = arg('out', '/mnt/c/Users/Heath/dossie-capture-' + new Date().toISOString().slice(0, 10));
const FLOW = arg('flow', 'pipeline-to-dossier');
// captureMode=1 is the marketing-capture-only flag the app checks before
// calling /api/speak / showing the "Speaking..." pill (dossie-app.jsx,
// isCaptureMode()). Every recording made with this script is marketing
// footage, so the flag is always forced onto the URL here - not left to the
// caller to remember - regardless of what --url is passed.
function withCaptureMode(url) {
  const u = new URL(url);
  u.searchParams.set('captureMode', '1');
  return u.toString();
}
const APP_URL = withCaptureMode(arg('url', 'https://meetdossie.com/app'));
const FPS = Number(arg('fps', 10));
const QUALITY = Number(arg('quality', 90));
const DOSSIER = arg('dossier', '29046 Wrenfield Way');
// --question is only read by the `ask-dossie` flow (D1). It must be a question
// selected by scripts/generate-ask-dossie-video.js from a real sourced quote
// mapped to a verified-WORKS capability - never typed in by hand here.
const QUESTION = arg('question', "What's urgent today?");
const FRAME_DIR = path.join(OUT_DIR, 'frames');

// Mobile capture geometry. 390x844 @ dsf 3 => 1170x2532 real pixels.
const VIEWPORT = { width: 390, height: 844 };
const DSF = 3;

// ----------------------------------------------------------- env secret ----
function readEnvLocal(key) {
  const p = path.join(REPO, '.env.local');
  if (!fs.existsSync(p)) throw new Error('.env.local not found at ' + p);
  // Strip a UTF-8 BOM - it silently corrupts the first variable.
  const txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  const m = txt.match(new RegExp('^' + key + '=(.*)$', 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

// -------------------------------------------------------------- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function die(msg) {
  console.error('\n=========================================');
  console.error('ABORT: ' + msg);
  console.error('=========================================\n');
  process.exit(1);
}

/** Visible-only locator - the app renders hidden desktop duplicates of the tab bar. */
const vis = (page, sel) => page.locator(sel).locator('visible=true');

async function tapTab(page, emoji) {
  await vis(page, 'button').filter({ hasText: emoji }).first().click();
}

/**
 * Smooth scroll by `delta` px over `durationMs`, in small steps, so that a
 * concurrent frame capture sees real motion between consecutive frames.
 */
async function smoothScroll(page, delta, durationMs) {
  const stepMs = 40;
  const steps = Math.max(1, Math.round(durationMs / stepMs));
  const per = delta / steps;
  for (let i = 0; i < steps; i++) {
    await page.evaluate((d) => window.scrollBy(0, d), per);
    await sleep(stepMs);
  }
}

/**
 * Scroll to an absolute Y, defensively.
 *
 * A non-finite target used to pass straight through to window.scrollBy(),
 * which the CSSOM spec silently ignores for non-finite values - so a null
 * anchor turned into a scroll that never happened and several "different"
 * beats filmed the identical screen. Bail loudly instead, and clamp to the
 * document's real max scroll so we never ask for a position that cannot exist.
 */
async function scrollToY(page, targetY, durationMs) {
  if (!Number.isFinite(targetY)) {
    console.warn('   ! scrollToY got a non-finite target - skipping this beat');
    return;
  }
  const { cur, max } = await page.evaluate(() => ({
    cur: window.scrollY,
    max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  }));
  await smoothScroll(page, Math.max(0, Math.min(targetY, max)) - cur, durationMs);
}

/** Page-absolute Y of the first element whose text matches `re`. */
async function anchorY(page, reSource) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    let best = null;
    document.querySelectorAll('*').forEach((e) => {
      if (best !== null || e.children.length > 3) return;
      const t = (e.innerText || '').trim();
      if (t && t.length < 120 && re.test(t)) {
        best = Math.round(e.getBoundingClientRect().top + window.scrollY);
      }
    });
    return best;
  }, reSource);
}

/**
 * What is ACTUALLY inside the viewport right now, read off the DOM.
 * The timeline is built from this rather than from hand-written guesses -
 * a hand-written label drifts the moment the scroll maths changes, and an
 * inaccurate timeline drives inaccurate on-screen claims in the final edit.
 */
async function visibleText(page) {
  return page.evaluate(() => {
    const seen = [];
    const vh = window.innerHeight;
    document.querySelectorAll('*').forEach((e) => {
      if (e.children.length > 0) return;
      const t = (e.innerText || '').trim().replace(/\s+/g, ' ');
      if (!t || t.length > 90) return;
      const r = e.getBoundingClientRect();
      // Skip the fixed header (top ~120px) and the fixed tab bar (bottom ~90px).
      if (r.bottom < 125 || r.top > vh - 95) return;
      if (r.height === 0 || r.width === 0) return;
      if (!seen.includes(t)) seen.push(t);
    });
    return seen.join(' · ');
  });
}

// ================================================================ MAIN ====
(async () => {
  const PW = readEnvLocal('DEMO_PASSWORD');
  if (!PW || PW.length < 12) die('DEMO_PASSWORD missing or implausibly short in .env.local');

  fs.mkdirSync(FRAME_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: !flag('headed') });
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DSF,
    isMobile: true,
    hasTouch: true,
    reducedMotion: 'no-preference',
  });
  const page = await ctx.newPage();

  // Belt-and-suspenders for the "Speaking..." pill (dossie-app.jsx sets it
  // only after /api/speak returns 200 and the audio decodes - see
  // isCaptureMode()/speakConfirmation). captureMode=1 on APP_URL already
  // makes the app skip the call outright once that fix is deployed; aborting
  // the request here at the network layer means this recorder produces a
  // clean take TODAY even before that build ships, and keeps working as a
  // second guard afterward. Real users are never routed through Playwright,
  // so this changes nothing about what they see.
  await page.route('**/api/speak', (route) => route.abort());

  // ------------------------------------------------------------ sign in ----
  console.log('-> ' + APP_URL);
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 60000 });

  const emailBox = vis(page, "input[type='email']").first();
  if (await emailBox.count()) {
    console.log('-> signing in as demo@meetdossie.com');
    await emailBox.fill('demo@meetdossie.com');
    await vis(page, "input[type='password']").first().fill(PW);
    await vis(page, "button[type='submit']").first().click();
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  }
  // Give the SPA time to hydrate + fetch the dossiers.
  await page.waitForTimeout(7000);

  // ============================================================= GATE =====
  // NON-NEGOTIABLE. Never film until every one of these passes.
  await assertSignedIn(page);

  // ------------------------------------------------- capture machinery ----
  const frames = [];
  const marks = [];
  let capturing = false;
  let t0 = 0;
  /** Record a beat: a short human note PLUS the text actually on screen. */
  const mark = async (note) => {
    const ts = Date.now() - t0;
    marks.push({ ts, note, onScreen: await visibleText(page) });
  };

  async function captureLoop() {
    const interval = Math.round(1000 / FPS);
    let n = 0;
    while (capturing) {
      const tick = Date.now();
      const ts = tick - t0;
      const f = path.join(FRAME_DIR, String(n).padStart(5, '0') + '.jpg');
      try {
        await page.screenshot({ path: f, type: 'jpeg', quality: QUALITY });
        frames.push({ ts, f });
        n++;
      } catch (e) {
        if (!capturing) break;
      }
      const spent = Date.now() - tick;
      if (spent < interval) await sleep(interval - spent);
    }
  }

  // ------------------------------------------------------------- flows ----
  async function flowBrief() {
    await tapTab(page, '☀️'); // sun / Today
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await mark('Today tab, top. Hero + the DOSSIE ASKS summary card.');
    await sleep(1700);
    // Straight to "First things first" - the hero has already read, and the
    // urgent list is the part that proves she is actually tracking deadlines.
    await smoothScroll(page, 1150, 2400);
    await mark('Morning Brief: counters and the start of the urgent list.');
    await sleep(2000);
  }

  async function flowPipeline() {
    await tapTab(page, '🗂️'); // card index / Pipeline
    await page.waitForTimeout(1800);
    await page.evaluate(() => window.scrollTo(0, 0));
    await mark('Pipeline tab opens at the top: "Pipeline Dashboard".');
    await sleep(1500);

    // FLICK, do not crawl, through the empty early stages. Seven of the ten
    // stages sit at 0 on the demo account and dwelling on "No files in this
    // stage" is the worst thing we could put in a marketing cut.
    const ucY = await anchorY(page, 'Under Contract');
    // Hard ceiling: never let the empty "Option Period" stage (the one that
    // follows Under Contract) enter the viewport. NOTE the anchor text is
    // "🔎 Option Period" - the emoji lives in the same text node, so
    // this must NOT be anchored with a leading ^.
    const optY = await anchorY(page, 'Option Period$');
    const cap = optY != null ? optY - VIEWPORT.height : (ucY || 1269) + 40;

    // The whole Under Contract column is only ~780px tall, so it very nearly
    // fills one 844px screen. This section wants a fast flick and a settle,
    // not a long crawl - the motion is the empty stages whipping past.
    await scrollToY(page, Math.min((ucY || 1269) - 90, cap), 850);
    await mark('Flicked down to the populated stage; the empty stages pass by too fast to read.');
    await sleep(2200);

    await scrollToY(page, cap, 1600);
    await mark('Settled on the full Under Contract column, last cards brought up.');
    await sleep(1600);
  }

  async function flowDossier() {
    const card = page.getByText(new RegExp(DOSSIER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
    await card.scrollIntoViewIfNeeded();
    await sleep(800);
    await mark('Card for ' + DOSSIER + ' centered, about to be tapped.');
    await card.click();
    await sleep(500);
    await page.waitForTimeout(3000);

    // Skip the long action-button stack at the top of the detail view and
    // land on the dossier identity block.
    const noY = await anchorY(page, 'DOSSIER NO');
    if (noY != null) await scrollToY(page, noY - 140, 900);
    await sleep(700);
    await mark('Dossier detail header: dossier number, address, agent, side + stage badges.');
    await sleep(1600);

    await smoothScroll(page, 460, 1800);
    await mark('STAGE PROGRESSION rail.');
    await sleep(1100);

    const trecY = await anchorY(page, 'TREC deadlines');
    if (trecY != null) await scrollToY(page, trecY - 130, 2000);
    else await smoothScroll(page, 700, 2000);
    await mark('"TREC deadlines" header lands on screen.');
    await sleep(1300);

    // Walk the deadline list, then STOP on the compliance warnings.
    //
    // HARD RULE: never scroll into "Deal details". Those demo rows carry
    // placeholder contact values (buyer@example.com, (555) 555-5555) and
    // filming them would put obviously-fake data in a marketing asset.
    // `cap` keeps the top of Deal details below the bottom of the viewport.
    const dealY = await anchorY(page, 'Deal details');
    const cap = dealY != null ? dealY - VIEWPORT.height : Infinity;
    const trecTop = trecY != null ? trecY - 130 : await page.evaluate(() => window.scrollY);

    // The TREC block + compliance warnings together are only ~860px, so they
    // essentially fill one screen - there is nothing to gain from crawling
    // through them. One drift down to the compliance gaps, then move on.
    await scrollToY(page, cap, 1800);
    await mark('Deadline rows plus the compliance gaps Dossie is flagging.');
    await sleep(2200);

    // Close on the Documents section. Reached via the in-page anchor link,
    // which JUMPS the viewport there - deliberately skipping over the
    // "Deal details" placeholder contact fields rather than scrolling past
    // them. The list loads asynchronously, so wait for real filenames before
    // holding on it; never film the "Loading documents..." state.
    const docsLink = page.getByText(/^Documents$/).locator('visible=true').first();
    if (await docsLink.count()) {
      await docsLink.click();
      await sleep(900);
      await page.waitForFunction(
        () => /ON FILE \(\d+\)/.test(document.body.innerText),
        null, { timeout: 15000 },
      ).catch(() => console.warn('   ! documents list did not finish loading'));
      await sleep(900);
      await mark('Documents section: the real files on this dossier.');
      await sleep(1600);
      await smoothScroll(page, 300, 1500);
      await mark('Scrolling the document list - filenames, sizes, dates, per-file actions.');
      await sleep(2200);
    }
  }

  // ------------------------------------------------- D1 "Ask Dossie" ----
  //
  // Types a REAL question into the real Talk-to-Dossie command box and waits
  // for the REAL answer to render, then holds on it long enough to read.
  //
  // Scope note, and it is the whole honesty of this format: verified
  // capability #11 is the TEXT command path - "typed a question, got a real,
  // data-grounded text answer". Capability #12 (spoken voice I/O) is
  // PARTIAL/UNVERIFIED. This flow therefore only ever TYPES and only ever
  // shows a TEXT answer. Nothing here may be edited to imply Dossie spoke.
  //
  // The verbatim answer is read off the DOM and written to <out>/answer.json.
  // Captions and any voiceover must use that string word for word.
  let askAnswer = null;
  let askGeom = null;

  async function flowAskDossie() {
    await tapTab(page, '☀️');
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await mark('Signed-in Today tab, top of the Morning Brief.');
    await sleep(1400);

    // The Talk-to-Dossie panel is a slide-in. On a 390px viewport its textarea
    // sits at x=411 until the header button opens it - so this is genuine
    // motion, and it is also the check that the panel really opened.
    await page.getByRole('button', { name: 'Talk to Dossie' }).first().click();
    await sleep(1500);
    const ta = page.locator('textarea').first();
    const box = await ta.boundingBox();
    if (!box || box.x < 0 || box.x > VIEWPORT.width) {
      die('Talk to Dossie panel did not open - command textarea is at x=' + (box && box.x));
    }
    await mark('Talk to Dossie command panel open, empty command box.');
    await sleep(900);

    // Type the question character by character - real typing, not a paste.
    await ta.click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(QUESTION, { delay: 55 });
    // The Send button is disabled until React sees the input event; waiting on
    // it is what proves the text actually landed in component state.
    await page.waitForFunction(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /^send$/i.test((x.innerText || '').trim()));
      return b && !b.disabled;
    }, null, { timeout: 15000 });
    await mark('Question typed in full: "' + QUESTION + '"');
    await sleep(1300);

    const bodyLines = () => page.evaluate(() =>
      (document.body.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean));
    const askedAt = Date.now() - t0;
    await page.getByRole('button', { name: /^send$/i }).first().click();
    await mark('Send tapped - the question is now in the thread.');

    // Wait for the REAL answer. The thread grows the page rather than an inner
    // scroller, so keep the newest bubble in view while we wait.
    let answer = '';
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await sleep(800);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const now = await bodyLines();
      const qi = now.lastIndexOf(QUESTION);
      const cand = qi > -1 ? now[qi + 1] : null;
      if (cand && cand.length > 25
        && !/^(Send|🎤 Voice call|\?)$/.test(cand)
        && !/thinking|working on it|one sec/i.test(cand)) { answer = cand; break; }
    }
    const answeredAt = Date.now() - t0;
    if (!answer) die('no answer rendered within 90s - refusing to ship a take with no payoff.');

    // transactions is multi-tenant: an address on screen that is not a seeded
    // demo address would mean we are filming another customer's client data.
    // '29046 Pfeiffers Gate' - a copy of Heath's real, live listing - was
    // scrubbed out of the demo account by scripts/carter-scrub-demo-pii.js
    // (2026-09-16); its dossier is now '29046 Windmere Ln'. Do not re-add
    // Pfeiffers Gate here even if it resurfaces in a future seed - fix the
    // seed/DB, not this allowlist.
    const addrRe = /\b\d{2,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+(?:Rd|Road|St|Street|Dr|Drive|Ln|Lane|Way|Ave|Avenue|Ct|Court|Blvd|Falls|Gate|Trail|Trl|Cir|Circle)\b/g;
    const demo = ['29046 Wrenfield Way', '789 Ranch Rd', '321 Oak St', '311 Copperfield Dr',
      '742 Lakeview Drive', '29046 Windmere Ln', '205 Kendall Falls'];
    const strays = [...new Set(answer.match(addrRe) || [])]
      .filter((a) => !demo.some((d) => d.toLowerCase() === a.toLowerCase().trim()));
    if (strays.length) die('NON-DEMO ADDRESS in the answer: ' + strays.join(', '));

    // Bring the whole answer bubble into view, then HOLD. Playbook 5 item 4a:
    // anything a claim cites must be shown, readably, BEFORE it is said.
    //
    // This is NOT optional plumbing. The newest bubble lands BELOW the fold,
    // behind the pinned composer, and the panel's scroller does not exist yet
    // when the panel first opens - so a plain window.scrollTo() does nothing
    // and the take ends up filming a thread whose answer is off-screen. Scroll
    // the bubble itself into view, then ASSERT it is really in the viewport.
    const inView = async () => page.evaluate((txt) => {
      const hits = [...document.querySelectorAll('div,p,span,li')]
        .filter((e) => (e.innerText || '').trim() === txt);
      const el = hits[hits.length - 1];
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return {
        found: true, top: Math.round(r.top), bottom: Math.round(r.bottom),
        h: Math.round(r.height), vh: window.innerHeight,
      };
    }, answer);

    let pos = await inView();
    await sleep(600);
    pos = await inView();
    await sleep(500);
    if (!pos.found) die('answer bubble not locatable in the DOM - cannot prove it was on screen.');
    // Allow the bubble to be taller than the viewport, but its TOP must be
    // visible and at least 60% of it must sit inside the frame.
    const visiblePx = Math.min(pos.bottom, pos.vh) - Math.max(pos.top, 0);
    if (pos.top < -20 || visiblePx < Math.min(pos.h, pos.vh) * 0.6) {
      die('answer bubble is not adequately on screen (top=' + pos.top + ', visible='
        + visiblePx + 'px of ' + pos.h + 'px, viewport=' + pos.vh + ') - refusing to '
        + 'ship a take whose payoff never renders.');
    }
    console.log('ANSWER ON SCREEN: top=' + pos.top + 'px, ' + visiblePx + '/' + pos.h + 'px visible.');

    await mark("Dossie's answer rendered and fully in view.");
    await sleep(3400);
    await mark('Readable hold on the answer (caption / VO sync window).');
    await sleep(2600);

    // Record the answer bubble's geometry in CSS px so the compositor can pick
    // a crop_y that keeps the burned caption band off real message text
    // (playbook 5a check 14). Multiply by DSF (3) for capture pixels.
    askGeom = { top_css: pos.top, bottom_css: pos.bottom, height_css: pos.h, viewport_css: pos.vh };

    askAnswer = {
      question_asked: QUESTION,
      answer_verbatim: answer,
      asked_at_ms: askedAt,
      answered_at_ms: answeredAt,
      answer_latency_ms: answeredAt - askedAt,
      capability: '#11 Talk to Dossie (typed command, text answer) - WORKS',
      scope_warning: 'TEXT path only. Capability #12 (spoken voice I/O) is '
        + 'PARTIAL/UNVERIFIED - the edit must never imply Dossie spoke back.',
      account: 'demo@meetdossie.com (Sarah Whitley demo profile - no real customer data)',
      caption_rule: 'answer_verbatim is exactly what the app rendered. Captions and '
        + 'voiceover must use it verbatim; trailing sentences may be CUT to fit '
        + 'runtime, but rewording, re-ordering or paraphrasing is not allowed.',
      answer_bubble_geometry: askGeom,
      captured_at: new Date().toISOString(),
    };
  }

  const FLOWS = {
    'pipeline-to-dossier': async () => { await flowBrief(); await flowPipeline(); await flowDossier(); },
    'pipeline-only': flowPipeline,
    'brief-only': flowBrief,
    'ask-dossie': flowAskDossie,
  };
  const run = FLOWS[FLOW];
  if (!run) die('unknown --flow "' + FLOW + '". Known: ' + Object.keys(FLOWS).join(', '));

  // -------------------------------------------------------- record it ----
  console.log('-> capturing flow "' + FLOW + '" at ' + FPS + 'fps');
  capturing = true;
  t0 = Date.now();
  const loop = captureLoop();
  try {
    await run();
  } finally {
    capturing = false;
    await loop;
  }
  const durationMs = frames.length ? frames[frames.length - 1].ts : 0;

  // ---------------------------------------------------------- manifest ----
  fs.writeFileSync(path.join(OUT_DIR, 'frames.json'), JSON.stringify({ frames }));

  // ---------------------------------------------------------- timeline ----
  const lines = [
    '# Dossie short-form capture - timeline',
    '',
    '- Flow: `' + FLOW + '`  Dossier: ' + DOSSIER,
    '- Captured: ' + new Date().toISOString(),
    '- Account: demo@meetdossie.com (Sarah Whitley demo profile - no real customer data)',
    '- Frames: ' + frames.length + ' @ ~' + FPS + 'fps, ' + (durationMs / 1000).toFixed(1) + 's, ' +
      (VIEWPORT.width * DSF) + 'x' + (VIEWPORT.height * DSF) + ' JPEG q' + QUALITY,
    '',
    'The "on screen" column is read straight off the DOM at that moment, not',
    'written by hand - every on-screen claim in the edit can be checked against it.',
    '',
  ];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].ts : durationMs;
    lines.push('### ' + m.ts + '-' + end + 'ms - ' + m.note);
    lines.push('');
    lines.push('> ' + (m.onScreen || '(nothing captured)'));
    lines.push('');
  });
  fs.writeFileSync(path.join(OUT_DIR, 'timeline.md'), lines.join('\n'));

  // The ask-dossie flow additionally emits the verbatim text the app rendered.
  // Captions/VO are built from this file, so it must never be hand-edited.
  if (askAnswer) {
    fs.writeFileSync(path.join(OUT_DIR, 'answer.json'), JSON.stringify(askAnswer, null, 2));
    console.log('    ' + path.join(OUT_DIR, 'answer.json'));
    console.log('\nANSWER (verbatim): ' + askAnswer.answer_verbatim);
  }

  await browser.close();

  console.log('\nOK  ' + frames.length + ' frames, ' + (durationMs / 1000).toFixed(1) + 's');
  console.log('    ' + FRAME_DIR);
  console.log('    ' + path.join(OUT_DIR, 'frames.json'));
  console.log('    ' + path.join(OUT_DIR, 'timeline.md'));
})().catch((e) => die(e && e.stack ? e.stack : String(e)));

// ======================================================== THE GATE ========
/**
 * Hard gate. Every check must pass or we exit non-zero WITHOUT capturing.
 * This is the specific defence against filming a login page for 35 seconds.
 */
async function assertSignedIn(page) {
  const url = page.url();

  // 1. Not parked on a login / sign-in route.
  if (/\/(signin|sign-in|login|set-password|forgot-password)\b/i.test(url)) {
    die('still on an auth route after sign-in: ' + url);
  }

  // 2. No password input anywhere in the DOM - the single most reliable
  //    "we are still on the login screen" tell.
  const pwCount = await page.locator("input[type='password']").count();
  if (pwCount > 0) die(pwCount + ' password input(s) still in the DOM - sign-in did not take. URL: ' + url);

  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ');

  // 3. Signed-in-only chrome.
  if (!/Open New Dossier/i.test(body)) die('"Open New Dossier" not found - not on the signed-in app shell. URL: ' + url);

  // 4. REAL SEEDED DATA, not an empty state or a skeleton. The demo profile
  //    carries 6+ transactions, so we require several concrete addresses.
  const addresses = [
    '29046 Wrenfield Way', '789 Ranch Rd', '321 Oak St', '311 Copperfield Dr',
    '742 Lakeview Drive', '29046 Windmere Ln', '205 Kendall Falls',
  ];
  const seen = addresses.filter((a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(body));
  if (seen.length < 4) {
    die('only ' + seen.length + ' known demo addresses rendered (' + seen.join(', ') +
      ') - looks like an empty state or a spinner, not populated data.');
  }

  // 5. Loading / empty-state tells.
  if (/Loading your dossiers|No dossiers yet|Something went wrong/i.test(body)) {
    die('page is showing a loading or empty state.');
  }
  if (body.length < 800) die('body text is only ' + body.length + ' chars - page has not rendered.');

  // 6. Proof screenshot on disk for a human (or the agent) to actually look at.
  const proof = path.join(OUT_DIR, 'verify-signed-in.png');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: proof });

  console.log('GATE PASSED: signed in, 0 password inputs, ' + seen.length + ' demo addresses rendered.');
  console.log('             proof -> ' + proof);
}
