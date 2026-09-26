'use strict';

// api/_lib/docuseal-signing-verify.js
//
// Real, rendered-page proof that a DocuSeal signing link is genuinely live —
// built 2026-09-26 after Heath's sellers spent hours unable to sign a
// packet. Root cause: the DocuSeal account was in Developer Sandbox mode.
// Every API call along the send path returned success (submission created,
// submitters "sent", every URL 200) — nothing in the API response ever says
// "sandbox." The ONLY place that says so is the signing page itself, in
// plain text: "Developer Sandbox. Upgrade to start using in Production."
// `curl -o /dev/null -w "%{http_code}"` proved nothing then, because it
// never reads the body — a HEAD-shaped check on a body-shaped problem.
//
// This module actually launches a headless browser, navigates to the real
// signing URL, and reads what a recipient would actually see — the same
// thing Heath had to do by hand to find this bug. Two distinct failures get
// caught by the same render:
//
//   1. SANDBOX MODE — DocuSeal's own banner. If this is on the page, the
//      account is not in Production, full stop. This is DocuSeal's own
//      words about DocuSeal's own account state — not an env var someone
//      has to remember to set correctly, not an inference.
//
//   2. DEAD LINK — a submission that's archived/expired/invalid still
//      returns HTTP 200, but the page is a bare app shell with none of the
//      real signing UI (no DOWNLOAD/DECLINE buttons, no document content).
//      Verified live 2026-09-26 against a real archived Nopalito submission:
//      200, ~9KB of generic shell, zero form content — vs. a real pending
//      submission's ~160KB page with the full document + SIGN NOW/DOWNLOAD/
//      DECLINE controls actually rendered.
//
// Chromium launch mirrors the existing lambda-aware pattern already used by
// api/cron-ridge-watchdog.js / api/cron-customer-view-digest.js /
// api/cron-dossie-full-diagnostic.js (@sparticuz/chromium-min in prod, local
// `playwright` package in dev). Not refactored into one shared launcher as
// part of this fix — those crons are untouched; duplicating the ~15-line
// launch function matches the precedent already in this repo rather than
// introducing a new cross-cutting dependency under time pressure.
//
// DEPENDENCY INJECTION: verifySigningPageLive(url, { render }) accepts an
// optional `render` override so callers (and this module's own tests, and
// esign-create.js's __testing surface) can prove the sandbox/production
// branches fire without actually launching a browser or hitting the
// network. Production code never passes `render` — it always gets the real
// renderSigningPageText.

const CHROMIUM_REMOTE = 'https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar';

// DocuSeal's own sandbox-mode copy, as rendered live 2026-09-26. Matching
// on either half of the sentence — if DocuSeal ever tweaks the wording,
// losing one half still catches it on the other.
const SANDBOX_MARKERS = [
  'Developer Sandbox',
  'Upgrade to start using in Production',
];

// Controls that only render when a real, fillable/signable submission
// loaded — present on every genuine pending signing page regardless of
// multi-signer turn order (verified live: shown for BOTH the acting and the
// not-yet-acted submitter on the same submission). Absent on the generic
// app-shell response an archived/invalid link returns instead. Require ALL
// of these, not just one, since the shell can occasionally echo one
// isolated word from page chrome.
const GENUINE_SIGNING_PAGE_MARKERS = ['DOWNLOAD', 'DECLINE'];

function textHasAnyMarker(text, markers) {
  if (!text) return false;
  return markers.some((m) => text.includes(m));
}

function textHasAllMarkers(text, markers) {
  if (!text) return false;
  return markers.every((m) => text.includes(m));
}

// Pure, unit-testable without a browser or network — `text` is whatever
// body text a caller extracted (a real render, or in tests, a fixture
// string built from the real captures documented above).
function evaluateSigningPageText(text) {
  if (textHasAnyMarker(text, SANDBOX_MARKERS)) {
    return {
      ok: false,
      sandboxMode: true,
      reason: 'docuseal_sandbox_mode',
      message: 'The DocuSeal account is in Developer Sandbox mode, not Production — signing links do not work for real recipients in this mode. Upgrade the account at https://console.docuseal.com/plans before sending anything for signature.',
    };
  }
  if (!textHasAllMarkers(text, GENUINE_SIGNING_PAGE_MARKERS)) {
    return {
      ok: false,
      sandboxMode: false,
      reason: 'signing_page_not_genuine',
      message: 'That signing link did not render a real, signable document when checked just now — it may be dead, archived, or invalid. Refusing to report this send as complete.',
    };
  }
  return { ok: true, sandboxMode: false, reason: null, message: null };
}

async function launchBrowser() {
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.VERCEL;
  if (isLambda) {
    const chromiumMod = await import('@sparticuz/chromium-min');
    const chromium = chromiumMod.default || chromiumMod;
    const { chromium: pwChromium } = require('playwright-core');
    const execPath = await chromium.executablePath(CHROMIUM_REMOTE);
    return pwChromium.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: true,
    });
  }
  const { chromium: pwChromium } = require('playwright');
  return pwChromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

// Renders `url` in a real headless browser and returns the visible body
// text. Never throws for a page-CONTENT problem (sandbox banner, dead
// shell) — that's evaluateSigningPageText's job on the returned text. Only
// returns { ok: false } here for an actual navigation failure (network
// error, timeout, browser crash) — the caller (verifySigningPageLive) fails
// CLOSED on that, same as a confirmed sandbox hit.
async function renderSigningPageText(url, { timeoutMs = 20000 } = {}) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs });
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: null, error: (err && err.message) || String(err) };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// The one function send paths call. Renders `url` for real (or via an
// injected `render`, tests only) and refuses whenever: the account is in
// Sandbox mode, the link is dead, OR the check itself could not be
// completed. A check we couldn't run is treated exactly like a check that
// failed — this never assumes production just because it couldn't prove
// otherwise. That is the entire failure class this file exists to close:
// a send reporting success while being undeliverable.
async function verifySigningPageLive(url, opts = {}) {
  const { render = renderSigningPageText, timeoutMs } = opts;
  if (!url) {
    return {
      ok: false,
      sandboxMode: false,
      reason: 'no_url',
      message: 'No signing URL was returned to check — refusing to report this send as complete.',
    };
  }
  const rendered = await render(url, { timeoutMs });
  if (!rendered || !rendered.ok) {
    return {
      ok: false,
      sandboxMode: false,
      reason: 'render_failed',
      message: `Could not verify the signing link is actually live (${(rendered && rendered.error) || 'render failed'}). Refusing to report this send as complete.`,
    };
  }
  return evaluateSigningPageText(rendered.text);
}

module.exports = {
  SANDBOX_MARKERS,
  GENUINE_SIGNING_PAGE_MARKERS,
  evaluateSigningPageText,
  renderSigningPageText,
  verifySigningPageLive,
  launchBrowser,
};
