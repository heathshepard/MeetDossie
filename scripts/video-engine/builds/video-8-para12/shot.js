// Render the transparent card HTML to PNG with the repo's own Playwright
// chromium. Transparent background so the composite controls what is behind.
const { chromium } = require('playwright');

(async () => {
  const jobs = [
    ['/home/heath/mw/v8/cards/hook8.html', '/home/heath/mw/v8/cards/hook8.png', 1080, 640],
    ['/home/heath/mw/v8/cards/cta8.html', '/home/heath/mw/v8/cards/cta8.png', 1080, 420],
  ];
  const browser = await chromium.launch();
  for (const [src, out, w, h] of jobs) {
    const page = await browser.newPage({
      viewport: { width: w, height: h },
      deviceScaleFactor: 1,
    });
    await page.goto('file://' + src);
    await page.waitForTimeout(400);
    await page.screenshot({ path: out, omitBackground: true });
    await page.close();
    console.log('wrote', out);
  }
  await browser.close();
})();
