const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await p.goto('file://' + process.argv[2], { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: process.argv[3] });
  await b.close();
  console.log('shot ok');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
