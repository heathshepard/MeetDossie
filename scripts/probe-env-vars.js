// Probe env vars as loaded by the same loadEnv routine the atlas script uses.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env.local');
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

const items = ['REDDIT_USERNAME', 'REDDIT_PASSWORD'];
for (const k of items) {
  const v = process.env[k] || '';
  console.log(`${k}: length=${v.length}, first_char_code=${v.charCodeAt(0)}, last_char_code=${v.charCodeAt(v.length - 1)}, first_4='${v.slice(0, 4)}', last_2='${v.slice(-2)}'`);
}
