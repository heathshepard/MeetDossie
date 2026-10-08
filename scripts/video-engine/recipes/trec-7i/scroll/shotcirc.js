const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1080,height:1920}, deviceScaleFactor:1 });
  const N = 21;
  for (let i = 0; i < N; i++) {
    const prog = Math.min(1, i / (N - 1));
    const eased = 1 - Math.pow(1 - prog, 2);
    await p.goto(`file://${process.argv[2]}?p=${eased}`, { waitUntil: 'load' });
    await p.screenshot({ path: `${process.argv[3]}/c${String(i).padStart(3,'0')}.png`, omitBackground: true });
  }
  await b.close(); console.log('circle frames done');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
