// Verify orb-web.html embed mode is transparent (no dark frame).
// Loads the same file the Electron app does, with ?embed=1, on a magenta
// background. If the orb shell leaks ANY dark color outside the orb, it
// will show against the magenta. Saves a screenshot to scripts/atlas-runs/.

const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const ORB_HTML = "C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\products\\jarvis-cole\\electron\\renderer\\orb-web.html";
const BRIDGE_JS = "C:\\Users\\Heath Shepard\\Desktop\\Shepard-Ventures\\products\\jarvis-cole\\electron\\renderer\\bridge.js";
const OUT_DIR = path.join(__dirname, "atlas-runs");

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 520, height: 520 },
    // Force a bright magenta page background — anything the orb leaks shows.
    colorScheme: "light",
  });

  const page = await ctx.newPage();
  // Wrap the orb in a magenta backdrop so we can see if it's truly transparent.
  await page.addInitScript(() => {
    window.__COLE_EMBED__ = true;
  });

  // Add a magenta backdrop via CSS injected before the orb's own styles take over.
  await page.route("**/*", async (route) => {
    if (route.request().url().endsWith("orb-web.html")) {
      const body = fs.readFileSync(ORB_HTML, "utf-8")
        .replace(/<\/head>/i, `<style id="atlas-test-bg">html{background:#FF00FF !important;}</style></head>`);
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body,
      });
      return;
    }
    route.continue();
  });

  const url = "file://" + ORB_HTML.replace(/\\/g, "/") + "?embed=1";
  console.log("[atlas-verify] loading:", url);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Inject the bridge.js exactly like main.js does
  const bridgeJs = fs.readFileSync(BRIDGE_JS, "utf-8");
  await page.evaluate(`window.__COLE_EMBED__ = true;\n` + bridgeJs);

  // Wait long enough for the video to start (or fail) and the layout to settle
  await page.waitForTimeout(3500);

  // Sample pixels at 4 corners — should all be MAGENTA (#FF00FF) if transparent works
  const corners = await page.evaluate(() => {
    const samples = {};
    const positions = [
      ["topLeft", 4, 4],
      ["topRight", 516, 4],
      ["bottomLeft", 4, 516],
      ["bottomRight", 516, 516],
      ["center", 260, 260],
    ];
    const canvas = document.createElement("canvas");
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const ctx = canvas.getContext("2d");
    // We can't actually screenshot from the DOM — return what we can about body bg.
    const bodyStyle = getComputedStyle(document.body);
    const htmlStyle = getComputedStyle(document.documentElement);
    return {
      bodyBg: bodyStyle.backgroundColor,
      bodyBgImage: bodyStyle.backgroundImage,
      htmlBg: htmlStyle.backgroundColor,
      htmlBgImage: htmlStyle.backgroundImage,
      bgCanvasDisplay: document.getElementById("bg-canvas")
        ? getComputedStyle(document.getElementById("bg-canvas")).display
        : "no-bg-canvas",
      orbVideoSrc: document.getElementById("orb-video")?.getAttribute("src"),
    };
  });
  console.log("[atlas-verify] computed styles:", JSON.stringify(corners, null, 2));

  const ts = Date.now();
  const shotPath = path.join(OUT_DIR, `orb-shell-verify-${ts}.png`);
  await page.screenshot({ path: shotPath, omitBackground: false });
  console.log("[atlas-verify] screenshot:", shotPath);

  await browser.close();
})().catch((e) => {
  console.error("[atlas-verify] FATAL:", e);
  process.exit(1);
});
