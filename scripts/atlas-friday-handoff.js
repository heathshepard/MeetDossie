'use strict';

// scripts/atlas-friday-handoff.js
// Uploads the Friday brief MP4 to Supabase Storage and inserts an approved
// social_posts row for Facebook. cron-publish-approved picks it up on the
// next 30-min tick and pushes to Zernio.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[k]) process.env[k] = v;
  }
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FACEBOOK_ACCOUNT_ID = '69f253c3985e734bf3d8f9bc'; // from CLAUDE.md §22

const MP4_PATH = path.join(__dirname, '..', 'Media', 'screen-recordings', 'pipeline-view-desktop-2026-06-12.mp4');
const STORAGE_PATH = 'videos/lifestyle/pipeline-view-desktop-2026-06-12.mp4';

// Full caption as Heath wrote the hook + body
const caption = [
  "From burned out solo agent to six deals running clean.",
  "",
  "Two years ago I was a burned-out solo agent. Sixty-hour weeks, the showings and the relationships getting squeezed by coordination work, everything else eating my Sundays.",
  "",
  "That was the problem I was building Dossie to solve. Over the last few weeks I have been running my whole pipeline through her — six active files, weekends back, Sundays mine again.",
  "",
  "She did not add a day to my week. She gave one back. The one with my family.",
  "",
  "Texas agents — meetdossie.com/founding",
].join('\n');

async function uploadFile() {
  const url = `${SUPABASE_URL}/storage/v1/object/social-cards/${STORAGE_PATH}`;
  const body = fs.readFileSync(MP4_PATH);
  console.log(`[handoff] Uploading ${body.length} bytes to social-cards/${STORAGE_PATH}...`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Upload ${res.status}: ${t.slice(0, 300)}`);
  }
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/social-cards/${STORAGE_PATH}`;
  console.log(`[handoff] Uploaded → ${publicUrl}`);
  return publicUrl;
}

async function insertPost(mediaUrl) {
  const now = new Date();
  const post_id = `${now.toISOString().slice(0, 10)}-brenda-facebook-friday-pipeline`;
  const row = {
    post_id,
    platform: 'facebook',
    content: caption,
    content_hash: crypto.createHash('md5').update(caption).digest('hex'),
    hook: 'From burned out solo agent to six deals running clean.',
    cta: 'Texas agents — meetdossie.com/founding',
    hashtags: [],
    status: 'approved',
    telegram_sent_at: now.toISOString(), // skip the marketing-bot approval flow
    approved_at: now.toISOString(),
    zernio_account_id: FACEBOOK_ACCOUNT_ID,
    persona: 'brenda',
    topic: 'pipeline_view',
    media_url: mediaUrl,
    video_required: false,
    generated_at: now.toISOString(),
    created_at: now.toISOString(),
    requires_approval: false,
  };

  console.log(`[handoff] Inserting social_posts row ${post_id}...`);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts?on_conflict=post_id`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Insert ${res.status}: ${t.slice(0, 400)}`);
  }
  const data = await res.json();
  console.log(`[handoff] Row inserted:`, Array.isArray(data) ? data[0]?.post_id : data.post_id);
  return data;
}

(async () => {
  const mediaUrl = await uploadFile();
  await insertPost(mediaUrl);
  console.log('[handoff] DONE — Facebook post queued for next cron-publish-approved tick.');
  console.log(`[handoff] Media URL: ${mediaUrl}`);
})().catch((err) => {
  console.error('[handoff] FAILED:', err.message);
  process.exit(1);
});
