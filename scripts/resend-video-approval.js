// One-off script: resend the stuck amendment video to DossieMarketingBot for approval.
//
// The video_library record id='amendment-demo-desktop-2026-05-27' was manually patched
// to status='pending_approval' but the Telegram message was never sent (telegram_message_id
// is null). cron-video-approval only picks up status='ready', so it will never send this.
//
// Run: node scripts/resend-video-approval.js
// Requires: .env.local in the MeetDossie root (loaded via dotenv).

const fs = require('fs');
const path = require('path');

const envFile = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf-8');
function envVar(name) {
  const m = envFile.match(new RegExp(`^${name}="?(.+?)"?\\s*$`, 'm'));
  return m ? m[1].trim() : undefined;
}

const SUPABASE_URL = envVar('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = envVar('SUPABASE_SERVICE_ROLE_KEY');
const TELEGRAM_BOT_TOKEN = envVar('TELEGRAM_BOT_TOKEN');
const TELEGRAM_CHAT_ID = envVar('TELEGRAM_CHAT_ID') || '7874782923';

const VIDEO_ID = 'amendment-demo-desktop-2026-05-27';

async function supabaseFetch(path2, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path2}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function tgSend(body) {
  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, data };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
    process.exit(1);
  }
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('Missing TELEGRAM_BOT_TOKEN in .env.local');
    process.exit(1);
  }

  // Load the record
  const { ok, data } = await supabaseFetch(
    `/rest/v1/video_library?id=eq.${encodeURIComponent(VIDEO_ID)}&limit=1`,
  );

  if (!ok || !Array.isArray(data) || data.length === 0) {
    console.error('Could not load video_library record:', VIDEO_ID);
    process.exit(1);
  }

  const video = data[0];
  console.log('Loaded video record:');
  console.log('  id:', video.id);
  console.log('  status:', video.status);
  console.log('  telegram_message_id:', video.telegram_message_id);
  console.log('  supabase_url:', video.supabase_url);

  if (video.telegram_message_id) {
    console.log('This video already has a telegram_message_id — it may already have been sent.');
    console.log('Proceeding anyway to re-send.');
  }

  const platformList = Array.isArray(video.platforms) ? video.platforms.join(', ') : 'unknown';
  const messageText = [
    'New video ready for review',
    '',
    `Type: ${video.type || 'unknown'}`,
    `Topic: ${video.topic || 'unknown'}`,
    `Platforms: ${platformList}`,
    `Caption: ${video.caption || '(none)'}`,
    '',
    `ID: ${video.id}`,
    video.supabase_url
      ? `URL: ${video.supabase_url}`
      : '(no URL — upload video first)',
  ].join('\n');

  const tgBody = {
    chat_id: TELEGRAM_CHAT_ID,
    text: messageText,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `video_approve_${video.id}` },
        { text: 'Reject', callback_data: `video_reject_${video.id}` },
      ]],
    },
    disable_web_page_preview: true,
  };

  console.log('\nSending to Telegram (chat_id=%s)...', TELEGRAM_CHAT_ID);
  const { ok: tgOk, data: tgData } = await tgSend(tgBody);

  if (!tgOk) {
    console.error('Telegram send failed:', JSON.stringify(tgData).slice(0, 300));
    process.exit(1);
  }

  const messageId = tgData?.result?.message_id || null;
  console.log('Telegram send OK, message_id:', messageId);

  // Store message_id and ensure status stays pending_approval
  const { ok: patchOk } = await supabaseFetch(
    `/rest/v1/video_library?id=eq.${encodeURIComponent(VIDEO_ID)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending_approval',
        telegram_message_id: messageId,
      }),
    },
  );

  if (!patchOk) {
    console.error('Failed to update telegram_message_id in DB — message was sent but not recorded');
  } else {
    console.log('DB updated: status=pending_approval, telegram_message_id=%s', messageId);
  }

  console.log('\nDone. Check Telegram for the approval message.');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
