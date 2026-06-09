'use strict';

// scripts/set-sage-webhook.js
//
// One-off: registers Telegram webhook for DossieSageBot to point at
//   https://meetdossie.com/api/sage-webhook
// (or a custom URL via --url=).
//
// Run once after creating the bot in BotFather and pasting the token into
// Vercel env vars as TELEGRAM_SAGE_BOT_TOKEN. Also reads optional
// TELEGRAM_SAGE_WEBHOOK_SECRET (auto-set as the secret_token header check
// in api/sage-webhook.js if present).
//
// Usage:
//   node scripts/set-sage-webhook.js
//   node scripts/set-sage-webhook.js --url=https://meet-dossie-XXXX.vercel.app/api/sage-webhook
//   node scripts/set-sage-webhook.js --delete    # unregisters (debugging)
//
// Env vars (read from .env.local if not already set):
//   TELEGRAM_SAGE_BOT_TOKEN      (from BotFather)
//   TELEGRAM_SAGE_WEBHOOK_SECRET (optional but recommended)

const path = require('path');

try {
  const fs = require('fs');
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
} catch {
  // Non-fatal
}

const TOKEN = process.env.TELEGRAM_SAGE_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_SAGE_WEBHOOK_SECRET;

if (!TOKEN) {
  console.error('TELEGRAM_SAGE_BOT_TOKEN is required. Either:');
  console.error('  - paste it into .env.local, or');
  console.error('  - run with TELEGRAM_SAGE_BOT_TOKEN=... node scripts/set-sage-webhook.js');
  process.exit(1);
}

const args = process.argv.slice(2);
const urlArg = args.find((a) => a.startsWith('--url='));
const DELETE = args.includes('--delete');
const WEBHOOK_URL = urlArg
  ? urlArg.slice('--url='.length)
  : 'https://meetdossie.com/api/sage-webhook';

(async () => {
  if (DELETE) {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/deleteWebhook?drop_pending_updates=true`);
    const data = await res.json();
    console.log('deleteWebhook ->', data);
    return;
  }

  const body = {
    url: WEBHOOK_URL,
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: true,
  };
  if (SECRET) body.secret_token = SECRET;

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log('setWebhook ->', data);

  const info = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
  console.log('getWebhookInfo ->', await info.json());
})().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
