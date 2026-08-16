'use strict';

// scripts/carter-verify-provenance-and-asks.js
//
// Real-browser verification, signed in as a real user, of:
//   1. Contract auto-fill — how many required fields actually prefill now,
//      read off the rendered editor, not off the API.
//   2. Provenance badges + the ProvenanceReview gate above the send button.
//   3. Dossie Asks paste-and-file attaching to the right dossier and creating
//      an action item.
//
// SAFETY — read before editing.
// ---------------------------------------------------------------------------
// This script drives the Fill Contract editor, which has a live
// "Send for signature" button that dispatches a real DocuSeal envelope to a
// real person. On 2026-08-XX a Playwright click intended to be intercepted
// bypassed the route hook (a service worker served the fetch first) and hit a
// real endpoint with a live authenticated session.
//
// So: every send/destructive endpoint is blocked by a route handler, service
// workers are killed, AND a throwaway DECOY request is fired through the same
// interception and CONFIRMED blocked before this script touches the app.
// If the decoy is not intercepted the script aborts. Never assume interception
// works — it is verified fresh every run.

const path = require('path');
const fs = require('fs');
// NOT scripts/_lib/quinn-browser.js: that helper hardcodes `channel: 'chrome'`,
// which resolves to a Windows Chrome install and does not exist under WSL
// (/opt/google/chrome/chrome). Playwright's bundled Chromium is present, so
// launch that directly rather than editing a helper other scripts depend on.
const { chromium } = require('playwright');
const os = require('os');

const OUT = path.join(__dirname, 'carter-runs');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// Anything that sends to a human, charges money, or mutates production
// deploy state. The decoy path is included so the check is honest.
const BLOCKED = [
  '**/api/esign-create**',
  '**/api/esign-send-handoff**',
  '**/api/esign-draft-handoff**',
  '**/api/send-email**',
  '**/api/send-via-dossie**',
  '**/api/send-to-compliance**',
  '**/api/merge-to-main**',
  '**/api/__carter_decoy__**',
];

function env(name) {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').replace(/^﻿/, '');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
    if (m && m[1] === name) return m[2].replace(/^["']|["']$/g, '');
  }
  return null;
}

(async () => {
  const BASE = process.argv[2];
  if (!BASE) {
    console.error('usage: node carter-verify-provenance-and-asks.js <baseUrl>');
    process.exit(1);
  }
  const EMAIL = process.argv[3] || 'demo@meetdossie.com';
  const PASSWORD = env('DEMO_PASSWORD');
  if (!PASSWORD) {
    console.error('DEMO_PASSWORD not in .env.local — cannot sign in for real.');
    process.exit(1);
  }

  const profileDir = path.join(os.tmpdir(), 'carter-verify-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: { width: 1920, height: 1080 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  let intercepted = 0;
  const interceptedUrls = [];
  for (const pattern of BLOCKED) {
    await context.route(pattern, async (route) => {
      intercepted += 1;
      interceptedUrls.push(route.request().url());
      await route.fulfill({
        status: 599,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'BLOCKED BY CARTER TEST HARNESS' }),
      });
    });
  }

  const page = await context.newPage();
  const log = (...a) => console.log(...a);

  // Capture the editor-init payload so field counts can be reported from the
  // server's own numbers alongside what actually rendered.
  let initPayload = null;
  page.on('response', async (resp) => {
    if (!resp.url().includes('/api/interactive-editor-init')) return;
    try {
      const j = await resp.json();
      initPayload = {
        totals: j.totals,
        fieldMapVersion: j.fieldMapVersion,
        provenanceSummary: j.provenanceSummary,
      };
    } catch (_e) { /* non-JSON */ }
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200));
  });

  // ---- 0. Kill service workers, then PROVE interception before anything ----
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  const before = intercepted;
  const decoyStatus = await page.evaluate(async () => {
    try {
      const r = await fetch('/api/__carter_decoy__', { method: 'POST', body: '{}' });
      return r.status;
    } catch (e) {
      return `threw:${e.message}`;
    }
  });
  if (intercepted <= before) {
    console.error(`ABORT: decoy request was NOT intercepted (status=${decoyStatus}, count=${intercepted}). `
      + 'Interception is not working — refusing to go near the send button.');
    await context.close();
    process.exit(2);
  }
  log(`[safety] decoy intercepted OK (status=${decoyStatus}, count=${intercepted}). Send endpoints are blocked.`);

  // ---- 1. Sign in for real ----
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  const emailBox = page.locator('input[type="email"]').first();
  await emailBox.waitFor({ timeout: 30000 });
  await emailBox.fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button:has-text("Sign in"), button:has-text("Sign In"), button[type="submit"]').first().click();
  await page.waitForTimeout(9000);
  const signedIn = await page.evaluate(() => document.body.innerText.slice(0, 400));
  log('\n[1] after sign-in, page begins:\n' + signedIn.split('\n').slice(0, 6).join('\n'));
  await page.screenshot({ path: path.join(OUT, 'prov-01-signed-in.png'), fullPage: false });

  // ---- 2. Dossie Asks paste-and-file ----
  const pasteBox = page.locator('[data-testid="dossie-asks-paste"]').first();
  const hasPaste = await pasteBox.count();
  log(`\n[2] Dossie Asks paste box present: ${hasPaste > 0}`);
  if (hasPaste > 0) {
    // Name a dossier explicitly so the matcher has something real to hit.
    await pasteBox.fill('buyer texted that the inspection is moved to Friday at 2pm on 205 Kendall Falls');
    await page.locator('button:has-text("File it")').first().click();
    await page.waitForTimeout(20000);
    const result = await page.locator('[data-testid="dossie-asks-file-result"]').first()
      .textContent().catch(() => null);
    log(`    filing result on screen: ${JSON.stringify(result)}`);
    await page.screenshot({ path: path.join(OUT, 'prov-02-ask-filed.png'), fullPage: false });
  }

  // ---- 3. Open the Phase 1 editor by deep link ----
  // /app?editorV1=<txnId> opens the same editor the "Fill Contract" button
  // does (dossie-app.jsx:1602-1617). Preferred over clicking through the
  // dossier toolbar because that toolbar puts "Generate + Sign" and
  // "Send for sig." one element away from the button under test.
  const TXN = process.env.CARTER_TXN_ID;
  if (TXN) {
    await page.goto(`${BASE}/app?editorV1=${TXN}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(20000);
    const body = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(path.join(OUT, 'prov-editor-body.txt'), body);

    const counts = await page.evaluate(() => {
      const txt = document.body.innerText;
      const count = (re) => (txt.match(re) || []).length;
      return {
        fromDossier: count(/From your dossier · edit/g),
        calculated: count(/Calculated · check/g),
        assumed: count(/Assumed · verify/g),
        provenanceReview: !!document.querySelector('[data-testid="provenance-review"]'),
        requiredLine: (txt.match(/Fill \d+ required fields? to enable send/) || [])[0] || null,
        progress: (txt.match(/\d+\s*\/\s*\d+\s*required/i) || [])[0] || null,
      };
    });
    log('\n[3] editor provenance badges + gate:');
    log('    ' + JSON.stringify(counts, null, 2).replace(/\n/g, '\n    '));
    log(`    init payload: ${JSON.stringify(initPayload)}`);
    await page.screenshot({ path: path.join(OUT, 'prov-04-editor.png'), fullPage: true });
  } else {
    log('\n[3] set CARTER_TXN_ID to open the editor.');
  }

  log(`\n[safety] total intercepted send/destructive requests this run: ${intercepted}`);
  if (interceptedUrls.length) log('         ' + interceptedUrls.join('\n         '));
  await context.close();
})().catch(async (e) => {
  console.error('FAILED:', e && e.message);
  process.exit(1);
});
