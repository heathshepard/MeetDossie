#!/usr/bin/env node
// scripts/diagnose-dossie.js
//
// Full-site diagnostic. Goes further than smoke-app-pages.js, which only
// checks that 5 public pages render. This one signs in as a demo user and
// walks every workspace section, clicking through the UI and recording what
// actually breaks.
//
// For every page and every section it captures:
//   - console errors and uncaught exceptions
//   - network responses >= 400 (broken APIs, missing storage assets)
//   - whether the section rendered visible content at all
//   - a screenshot
//
// Runs against the demo account only. Buttons matching DESTRUCTIVE are never
// clicked, so this does not send email, post socially, or delete records.
//
// Usage:
//   set DEMO_EMAIL=... && set DEMO_PASSWORD=... && node scripts/diagnose-dossie.js https://meetdossie.com
//
// Exit 0 = clean. Exit 1 = at least one console error, failed request, or
// section that rendered nothing.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = (process.argv[2] || 'https://meetdossie.com').replace(/\/$/, '');
const EMAIL = process.env.DEMO_EMAIL;
const PASS = process.env.DEMO_PASSWORD;

const PUBLIC_PAGES = [
  '/', '/app', '/founding', '/agents', '/coordinators',
  '/calculator', '/faq', '/guides/', '/answers/', '/workspace',
];

// Nav sections inside the workspace, matched on visible button text.
const SECTIONS = [
  'Morning Brief', 'Pipeline', "What's Coming", 'Emails',
  'Closed Dossiers', 'Support', 'Settings', 'Getting Started',
];

// Never clicked. These either leave the app, mutate real state, or cost money.
const DESTRUCTIVE =
  /sign out|log ?out|delete|remove|cancel|archive|send|post|publish|pay|subscribe|upgrade|talk to dossie|call|share dossie|open new dossier/i;

const runDir = path.join(
  __dirname, '..', '.tmp-diagnostic',
  'run-' + new Date().toISOString().replace(/[:.]/g, '-')
);
fs.mkdirSync(runDir, { recursive: true });

const findings = [];
function note(scope, kind, detail) {
  findings.push({ scope, kind, detail: String(detail).slice(0, 300) });
}

// Noise that is not a Dossie defect: third-party analytics and extensions.
const IGNORE = /posthog|google-analytics|gtag|doubleclick|favicon\.ico|chrome-extension|ERR_BLOCKED_BY_CLIENT/i;

function wire(page, scopeRef) {
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (!IGNORE.test(t)) note(scopeRef.cur, 'console', t);
  });
  page.on('pageerror', e => note(scopeRef.cur, 'exception', e && e.message));
  page.on('response', r => {
    const s = r.status();
    if (s >= 400 && !IGNORE.test(r.url())) note(scopeRef.cur, 'http' + s, r.url());
  });
}

async function visibleCount(page) {
  return page.evaluate(() => {
    const vis = el => el.getClientRects().length > 0;
    return [...document.querySelectorAll('button,a,input,h1,h2,h3,[role=button],table,li')]
      .filter(vis).length;
  });
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const scope = { cur: 'startup' };
  wire(page, scope);

  console.log(`[diag] base ${BASE}`);
  console.log(`[diag] artifacts ${runDir}\n`);

  // ---------- 1. public pages ----------
  console.log('--- public pages ---');
  for (const p of PUBLIC_PAGES) {
    scope.cur = `page ${p}`;
    const before = findings.length;
    let status = '?';
    try {
      const res = await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = res ? res.status() : '?';
      await page.waitForTimeout(1800);
      const n = await visibleCount(page);
      if (n < 3) note(scope.cur, 'blank', `only ${n} visible elements`);
      await page.screenshot({ path: path.join(runDir, 'page' + p.replace(/\W+/g, '_') + '.png') });
      const issues = findings.length - before;
      console.log(`  ${issues ? 'FAIL' : 'ok  '}  ${p.padEnd(14)} ${status}  ${n} elements` +
                  (issues ? `  (${issues} issue${issues > 1 ? 's' : ''})` : ''));
    } catch (e) {
      note(scope.cur, 'navigation', e.message);
      console.log(`  FAIL  ${p.padEnd(14)} ${e.message.slice(0, 60)}`);
    }
  }

  // ---------- 2. sign in ----------
  console.log('\n--- authenticated workspace ---');
  if (!EMAIL || !PASS) {
    console.log('  SKIPPED - DEMO_EMAIL / DEMO_PASSWORD not set');
  } else {
    scope.cur = 'login';
    await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const em = await page.$('input[type=email]');
    const pw = await page.$('input[type=password]');
    if (!em || !pw) {
      note('login', 'missing', 'email/password inputs not found on /app');
      console.log('  FAIL  login form not found');
    } else {
      await em.fill(EMAIL);
      await pw.fill(PASS);
      await page.click('button:has-text("Sign In")');
      await page.waitForTimeout(7000);

      const loggedIn = await page.$('button:has-text("Sign Out")');
      if (!loggedIn) {
        note('login', 'failed', 'no Sign Out control after submitting credentials');
        console.log('  FAIL  sign-in did not complete');
      } else {
        console.log('  ok    signed in as ' + EMAIL);
        await page.screenshot({ path: path.join(runDir, 'workspace-home.png') });

        // ---------- 3. each nav section ----------
        for (const name of SECTIONS) {
          scope.cur = `section ${name}`;
          const before = findings.length;
          try {
            // Reload first. Clicking around a section can leave a modal open,
            // and an overlay makes every later nav click time out - which
            // reads as "the app is broken" when it is only this script.
            await page.goto(BASE + '/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(3500);

            const nav = page.locator(`button:has-text("${name}"), [role=tab]:has-text("${name}")`).first();
            if (!(await nav.count())) {
              note(scope.cur, 'missing', 'nav item not found');
              console.log(`  FAIL  ${name.padEnd(16)} nav item missing`);
              continue;
            }
            await nav.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await nav.click({ timeout: 10000 });
            await page.waitForTimeout(3000);
            const n = await visibleCount(page);
            if (n < 5) note(scope.cur, 'blank', `only ${n} visible elements`);

            // click safe buttons within the section
            const btns = await page.$$('button');
            let clicked = 0;
            for (const b of btns.slice(0, 45)) {
              const label = ((await b.innerText().catch(() => '')) || '').trim();
              if (!label || DESTRUCTIVE.test(label)) continue;
              if (SECTIONS.some(s => label.includes(s))) continue; // don't navigate away
              if (!(await b.isVisible().catch(() => false))) continue;
              if (!(await b.isEnabled().catch(() => false))) continue;
              await b.click({ timeout: 4000 }).catch(() => {});
              clicked++;
              await page.waitForTimeout(350);
              await page.keyboard.press('Escape').catch(() => {});
              if (clicked >= 12) break;
            }

            await page.screenshot({
              path: path.join(runDir, 'section-' + name.replace(/\W+/g, '_') + '.png'),
            });
            const issues = findings.length - before;
            console.log(`  ${issues ? 'FAIL' : 'ok  '}  ${name.padEnd(16)} ${n} elements, ${clicked} buttons clicked` +
                        (issues ? `  (${issues} issue${issues > 1 ? 's' : ''})` : ''));
          } catch (e) {
            note(scope.cur, 'crash', e.message);
            console.log(`  FAIL  ${name.padEnd(16)} ${e.message.slice(0, 60)}`);
          }
        }
      }
    }
  }

  // ---------- report ----------
  console.log('\n================ FINDINGS ================');
  if (!findings.length) {
    console.log('none - everything rendered clean');
  } else {
    const byScope = {};
    for (const f of findings) (byScope[f.scope] ||= []).push(f);
    for (const [s, list] of Object.entries(byScope)) {
      console.log(`\n${s}  (${list.length})`);
      const seen = new Set();
      for (const f of list) {
        const k = f.kind + f.detail;
        if (seen.has(k)) continue;
        seen.add(k);
        console.log(`   [${f.kind}] ${f.detail}`);
      }
    }
  }
  fs.writeFileSync(path.join(runDir, 'findings.json'), JSON.stringify(findings, null, 2));
  console.log(`\n${findings.length} finding(s). Artifacts: ${runDir}`);

  await browser.close();
  process.exit(findings.length ? 1 : 0);
})().catch(e => {
  console.error('[diag] CRASH', e);
  process.exit(1);
});
