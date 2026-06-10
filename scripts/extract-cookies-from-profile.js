'use strict';

// scripts/extract-cookies-from-profile.js
//
// Extracts cookies from Heath's existing logged-in Chrome profiles WITHOUT
// requiring him to log in fresh. Works by:
//  1. Copying a Chrome profile to a TEMP dir (handles locked files via robocopy).
//  2. Launching Playwright Chromium with launchPersistentContext on the COPY.
//  3. Navigating to each platform and saving storageState as the platform's
//     session file at scripts/sessions/<platform>.json.
//
// Profile map (from User Data\Local State):
//   Default   -> kw.com (Heath's work; Gmail likely here)
//   Profile 1 -> Atlas-ops
//   Profile 2 -> Heath personal (heath.shepard@gmail.com — Reddit / Twitter / IG / LinkedIn likely)
//   Profile 4 -> DossieBot (Facebook)
//
// Usage:
//   node scripts/extract-cookies-from-profile.js <profile-dir> <platform[,platform...]> [--namespace]
//
// --namespace writes to scripts/sessions/<profile-tag>-<platform>.json
// instead of overwriting scripts/sessions/<platform>.json. Use this when
// extracting from multiple profiles before merging.
//
// Examples:
//   node scripts/extract-cookies-from-profile.js "Profile 2" reddit,twitter,instagram,linkedin --namespace
//   node scripts/extract-cookies-from-profile.js "Default" gmail
//   node scripts/extract-cookies-from-profile.js "Profile 4" facebook

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execSync } = require('child_process');

const PLATFORM_URLS = {
  reddit: 'https://www.reddit.com/',
  twitter: 'https://x.com/home',
  instagram: 'https://www.instagram.com/',
  linkedin: 'https://www.linkedin.com/feed/',
  facebook: 'https://www.facebook.com/',
  gmail: 'https://mail.google.com/',
};

const REAL_USER_DATA = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

async function main() {
  const profileDir = process.argv[2];
  const platformsArg = process.argv[3];
  const useNamespace = process.argv.includes('--namespace');
  const profileTag = profileDir.toLowerCase().replace(/\s+/g, '');

  if (!profileDir || !platformsArg) {
    console.error('Usage: node extract-cookies-from-profile.js <profile-dir> <platform[,platform...]> [--namespace]');
    process.exit(1);
  }

  const platforms = platformsArg.split(',').map(s => s.trim()).filter(Boolean);
  for (const p of platforms) {
    if (!PLATFORM_URLS[p]) {
      console.error(`Unknown platform: ${p}. Valid: ${Object.keys(PLATFORM_URLS).join(', ')}`);
      process.exit(1);
    }
  }

  // 1. Make a temp User Data dir and copy the source profile.
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-extract-'));
  const srcProfile = path.join(REAL_USER_DATA, profileDir);
  const dstProfile = path.join(tempUserData, profileDir);

  if (!fs.existsSync(srcProfile)) {
    console.error(`Source profile not found: ${srcProfile}`);
    process.exit(1);
  }

  console.log(`[extract] Copying profile "${profileDir}" to temp...`);
  console.log(`[extract]   src: ${srcProfile}`);
  console.log(`[extract]   dst: ${dstProfile}`);

  // robocopy handles locked files; ignore exit code (it uses 0-7 for success)
  try {
    execSync(`robocopy "${srcProfile}" "${dstProfile}" /E /R:1 /W:1 /XJ /NFL /NDL /NJH /NJS /NC /NS /NP`, {
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (e) {
    // robocopy exit 0-7 are success codes, but execSync sees non-zero as error.
    // Check if files actually copied.
    if (!fs.existsSync(dstProfile)) {
      console.error('[extract] robocopy failed to produce destination profile.');
      console.error(e.message);
      process.exit(1);
    }
  }

  // Also copy Local State (Chrome needs this for the profile to be valid).
  const srcLocalState = path.join(REAL_USER_DATA, 'Local State');
  const dstLocalState = path.join(tempUserData, 'Local State');
  if (fs.existsSync(srcLocalState)) {
    try {
      fs.copyFileSync(srcLocalState, dstLocalState);
    } catch (e) {
      console.warn(`[extract] Could not copy Local State: ${e.message}`);
    }
  }

  console.log('[extract] Profile copied. Launching Playwright Chromium...');

  // 2. Launch Playwright with the temp profile.
  const { chromium } = require('playwright');
  let context;
  try {
    context = await chromium.launchPersistentContext(tempUserData, {
      headless: false, // headed required so cookies decrypt properly
      channel: 'chrome',
      args: [
        '--no-sandbox',
        `--profile-directory=${profileDir}`,
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
    });
  } catch (e) {
    console.error('[extract] Failed to launch Chrome:', e.message);
    process.exit(1);
  }

  let savedCount = 0;
  const results = [];

  // 3. Navigate to each platform and save session.
  for (const platform of platforms) {
    const url = PLATFORM_URLS[platform];
    console.log(`[extract] Navigating to ${platform} (${url})...`);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(4000); // let cookies settle
    } catch (e) {
      console.warn(`[extract]   navigation timeout for ${platform} (continuing)`);
    }

    // Save storageState (Playwright format).
    const fname = useNamespace ? `${profileTag}-${platform}.json` : `${platform}.json`;
    const storageFile = path.join(SESSIONS_DIR, fname);
    try {
      await context.storageState({ path: storageFile });
      // Verify cookie count for this platform.
      const state = JSON.parse(fs.readFileSync(storageFile, 'utf8'));
      const matchingCookies = state.cookies.filter(c => {
        const host = c.domain.replace(/^\./, '');
        if (platform === 'reddit') return host.includes('reddit.com');
        if (platform === 'twitter') return host.includes('twitter.com') || host.includes('x.com');
        if (platform === 'instagram') return host.includes('instagram.com');
        if (platform === 'linkedin') return host.includes('linkedin.com');
        if (platform === 'facebook') return host.includes('facebook.com');
        if (platform === 'gmail') return host.includes('google.com');
        return false;
      });
      console.log(`[extract]   saved ${platform}.json (${matchingCookies.length} platform-specific cookies, ${state.cookies.length} total)`);
      results.push({ platform, cookies: matchingCookies.length, total: state.cookies.length });
      if (matchingCookies.length > 0) savedCount++;
    } catch (e) {
      console.error(`[extract]   FAILED to save ${platform}: ${e.message}`);
      results.push({ platform, error: e.message });
    }

    await page.close();
  }

  await context.close();

  // Cleanup temp profile dir.
  try {
    fs.rmSync(tempUserData, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[extract] Could not clean up temp dir: ${e.message}`);
  }

  console.log('\n[extract] Done. Results:');
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.platform}: ERROR — ${r.error}`);
    } else {
      console.log(`  ${r.platform}: ${r.cookies} platform cookies (${r.total} total)`);
    }
  }
  console.log(`\n[extract] ${savedCount} platforms saved with logged-in cookies.`);
  process.exit(savedCount > 0 ? 0 : 2);
}

main().catch(err => {
  console.error('[extract] Fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
