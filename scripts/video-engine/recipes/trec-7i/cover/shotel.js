const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport:{width:1080,height:parseInt(process.argv[4]||'640')}, deviceScaleFactor:1 });
  await p.goto('file://'+process.argv[2], { waitUntil:'load' });
  await p.waitForTimeout(700);
  await p.screenshot({ path: process.argv[3], omitBackground:true });
  await b.close(); console.log('ok');
})().catch(e=>{console.error(e.message);process.exit(1)});
