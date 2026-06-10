'use strict';

// scripts/sage-fb-blitz-burst.js
//
// Runs 4 approved group_posts sequentially via fb-group-poster.js using
// Heath's main Chrome profile. Used by Sage when Heath has closed Chrome
// for the autonomous blitz window. Sends a Telegram ping per successful
// post AND a consolidated summary at the end.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load .env.local
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Force the poster to use Heath's MAIN profile, not DossieBot-Sage
process.env.SAGE_PROFILE_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
process.env.SAGE_PROFILE_NAME = 'Default';

const POST_IDS = [
  // 1. Texas Real Estate Agents — CONTROL / Victor
  'fc1762df-60eb-463f-98c6-5e10eed13e6d',
  // 2. Texas Real Estate Network — COST / Patricia
  '37faa0aa-dce2-4dfe-bced-48e507eb2d2f',
  // 3. Dallas Texas Realtors — VISIBILITY / Brenda
  'd078e368-1738-4bdc-a2f5-fc1f0fe8399c',
  // 4. All about Real Estate Houston — SPEED / Patricia
  'b9add267-e9b1-4f4d-8421-debe19dec9db',
  // 5. Realtors San Antonio Boerne Bulverde New Braunfels — CONTROL / Victor (hyperlocal)
  'b4aa1c2f-924b-4aa6-9330-373d897c1b36',
  // 6. Texas Hill Country Real Estate — COST / Patricia (hyperlocal)
  'd68ce2f6-f3e9-4dbb-99d5-5f053cf4f315',
];

async function sb(p) {
  const r = await fetch(`${SUPABASE_URL}${p}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  return r.json();
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn('[burst] tg failed:', e.message);
  }
}

function runPoster(postId) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [
      path.join(__dirname, 'fb-group-poster.js'),
      '--post-id', postId,
    ], { stdio: 'inherit', env: process.env });
    proc.on('close', (code) => resolve(code === 0));
  });
}

(async () => {
  console.log('[burst] FB blitz burst — 4 posts');
  const results = [];

  for (let i = 0; i < POST_IDS.length; i++) {
    const id = POST_IDS[i];
    const idx = i + 1;
    console.log(`\n[burst] === Post ${idx}/${POST_IDS.length} (${id}) ===`);

    // Fetch row pre-post (group name + preview)
    const pre = await sb(`/rest/v1/group_posts?id=eq.${id}&select=group_name,pillar,post_body`);
    const groupName = pre?.[0]?.group_name || '(unknown)';
    const pillar = pre?.[0]?.pillar || '?';
    const preview = (pre?.[0]?.post_body || '').slice(0, 80).replace(/\n/g, ' ');

    const ok = await runPoster(id);
    const post = await sb(`/rest/v1/group_posts?id=eq.${id}&select=status,post_url`);
    const status = post?.[0]?.status;
    const postUrl = post?.[0]?.post_url;

    if (status === 'posted') {
      results.push({ idx, groupName, pillar, status: 'posted', postUrl, preview });
      await tg(`POSTED ${idx}/${POST_IDS.length} — ${groupName} (${pillar})\n\n"${preview}..."\n\n${postUrl || '(permalink not captured)'}`);
    } else {
      results.push({ idx, groupName, pillar, status: status || 'unknown', preview });
      await tg(`FAILED ${idx}/${POST_IDS.length} — ${groupName} (${pillar})\nReset to ${status || 'unknown'}. Will not re-attempt this run.`);
    }

    // Pause between posts to look human-ish
    if (i < POST_IDS.length - 1) {
      console.log('[burst] sleeping 25s before next post...');
      await new Promise((r) => setTimeout(r, 25000));
    }
  }

  // Final summary
  const posted = results.filter((r) => r.status === 'posted');
  const failed = results.filter((r) => r.status !== 'posted');

  let summary = `FB GROUP BLITZ COMPLETE — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}\n\n`;
  summary += `Posted in ${posted.length} groups:\n`;
  for (const r of posted) summary += `• ${r.groupName} — ${r.pillar}\n`;
  if (failed.length) {
    summary += `\nFailed in ${failed.length} groups (auto-reset to approved for retry):\n`;
    for (const r of failed) summary += `• ${r.groupName} — ${r.pillar}\n`;
  }
  summary += `\nNext blitz: tomorrow's drafts generate at 6 AM CT.`;
  await tg(summary);
  console.log('\n' + summary);
})().catch((e) => {
  console.error('[burst] FATAL:', e.message);
  tg(`FB blitz burst CRASHED: ${e.message}`).finally(() => process.exit(1));
});
