// Updates REDDIT_PASSWORD in .env.local and pushes to Vercel.
// Usage: REDDIT_PASSWORD_NEW='<value>' node scripts/atlas-update-reddit-password.js
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const newPass = process.env.REDDIT_PASSWORD_NEW;
if (!newPass) {
  console.error('Usage: set REDDIT_PASSWORD_NEW env var then run.');
  process.exit(2);
}

const envPath = path.join(__dirname, '..', '.env.local');
const text = fs.readFileSync(envPath, 'utf8');
const lines = text.split('\n');
let found = false;
const out = lines.map((line) => {
  if (line.startsWith('REDDIT_PASSWORD=')) {
    found = true;
    return `REDDIT_PASSWORD=${newPass}`;
  }
  return line;
});
if (!found) out.push(`REDDIT_PASSWORD=${newPass}`);
fs.writeFileSync(envPath, out.join('\n'), 'utf8');
console.log(`Updated .env.local REDDIT_PASSWORD (length=${newPass.length}).`);

// Push to Vercel
function pushVercel(key, value, target) {
  spawnSync('npx', ['--no-install', 'vercel', 'env', 'rm', key, target, '--yes'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'pipe', shell: true, timeout: 30000,
  });
  const r = spawnSync('npx', ['--no-install', 'vercel', 'env', 'add', key, target], {
    cwd: path.join(__dirname, '..'),
    input: value + '\n', stdio: ['pipe', 'pipe', 'pipe'], shell: true, timeout: 30000,
  });
  console.log(`Vercel env add ${key} ${target}: status=${r.status}`);
  if (r.status !== 0) console.log((r.stderr || r.stdout || '').toString().slice(0, 300));
}
pushVercel('REDDIT_PASSWORD', newPass, 'production');
console.log('Done.');
