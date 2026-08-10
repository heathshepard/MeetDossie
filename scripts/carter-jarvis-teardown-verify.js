'use strict';
// scripts/carter-jarvis-teardown-verify.js
//
// Real-browser verification for the 2026-08-10 Jarvis dashboard teardown
// (Heath's panel-by-panel /myjarvis review). Confirms:
//   - the 9 removed panels are actually gone from the DOM (not display:none)
//   - the 5 kept panels are present
//   - Merge Queue / In-Flight Work / Agents / Work Items render real content
//   - Agents panel's total_blocked count reflects the noise-filtered value
//
// Usage: node scripts/carter-jarvis-teardown-verify.js
// Requires the persistent Quinn Chrome profile to already be signed in
// against the STABLE git-staging alias (per-deployment preview URLs are
// separate origins with no carried-over session).

const { launchQuinnContext, VIEWPORTS } = require('./_lib/quinn-browser');
const path = require('path');
const fs = require('fs');

const BASE = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-teardown-verify');
fs.mkdirSync(OUT, { recursive: true });

const REMOVED_PANEL_IDS = [
  'business-lines-panel', 'future-builds-panel', 'debrief-panel',
  'quick-ask-panel', 'customer-panel', 'projects-panel',
  'activity-panel', 'money-panel', 'analytics-panel',
];
const KEPT_PANEL_IDS = [
  'merge-queue-panel', 'inflight-panel', 'agents-panel',
  'work-items-panel', 'calendar-panel',
];

async function main() {
  const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.desktop, reason: 'carter-teardown-verify' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push('console.error: ' + msg.text()); });
  let throughputBody = null;
  page.on('response', async (res) => {
    if (res.url().includes('/api/jarvis-agent-throughput')) {
      try { throughputBody = await res.json(); } catch (e) {}
    }
  });

  console.log('Navigating to', `${BASE}/myjarvis`);
  await page.goto(`${BASE}/myjarvis`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1500);

  const authGateVisible = await page.locator('#auth-gate').isVisible().catch(() => false);
  console.log('auth-gate visible (not signed in):', authGateVisible);
  if (authGateVisible) {
    console.log('FATAL: not signed in — persistent profile has no session on this origin.');
    await context.close();
    process.exit(1);
  }

  await page.waitForTimeout(3000); // let panels hydrate

  let allPass = true;
  for (const id of REMOVED_PANEL_IDS) {
    const count = await page.locator(`#${id}`).count();
    const ok = count === 0;
    allPass = allPass && ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} REMOVED-check ${id}: count=${count} (expect 0)`);
  }
  for (const id of KEPT_PANEL_IDS) {
    const count = await page.locator(`#${id}`).count();
    const ok = count === 1;
    allPass = allPass && ok;
    console.log(`${ok ? 'PASS' : 'FAIL'} KEPT-check ${id}: count=${count} (expect 1)`);
  }

  const mergeQueueText = await page.locator('#merge-queue-list').innerText().catch(() => 'ERR');
  console.log('--- merge-queue-list text ---\n', mergeQueueText.slice(0, 800));

  const inflightText = await page.locator('#inflight-list').innerText().catch(() => 'ERR');
  console.log('--- inflight-list text ---\n', inflightText.slice(0, 800));

  const instanceListText = await page.locator('#instance-list').innerText().catch(() => 'ERR');
  console.log('--- instance-list text (Agents > Instances) ---\n', instanceListText.slice(0, 800));
  const hasNoiseInInstances = /verify|panel-verify|\d{10,}/i.test(instanceListText);
  console.log(hasNoiseInInstances ? 'FAIL instance-list still shows noise-pattern text' : 'PASS instance-list clean of noise patterns');

  const badge = await page.locator('#agents-blocked-badge').innerText().catch(() => 'ERR');
  console.log('agents-blocked-badge:', badge, '| API total_blocked:', throughputBody && throughputBody.totals && throughputBody.totals.total_blocked);

  const workItemsText = await page.locator('#work-items-panel').innerText().catch(() => 'ERR');
  console.log('--- work-items-panel text ---\n', workItemsText.slice(0, 700));

  await page.screenshot({ path: path.join(OUT, 'full-dashboard.png'), fullPage: true });

  console.log('--- console/page errors captured:', consoleErrors.length, '---');
  consoleErrors.slice(0, 30).forEach((e) => console.log(e));

  console.log(allPass ? '\n=== ALL PANEL PRESENCE CHECKS PASS ===' : '\n=== SOME PANEL CHECKS FAILED ===');
  await context.close();
}
main().catch((e) => { console.error('FATAL', e.stack || e); process.exit(1); });
