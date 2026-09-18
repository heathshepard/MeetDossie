'use strict';

// scripts/swipe-paste.js
//
// "Heath sent a link" — the local end of the manual swipe inbox.
//
// Runs against the LOCAL .env.local so CRON_SECRET never has to cross into a
// browser session or a Telegram message. This is the command Cole runs when
// Heath drops a link in chat, and the command the extension loop's report
// gets turned into when the extension has read a login-walled page for us.
//
// USAGE
//   node scripts/swipe-paste.js <url> [--note "why this one"]
//   node scripts/swipe-paste.js --pending
//   node scripts/swipe-paste.js --supply <inbox_id> --file captured.txt
//   node scripts/swipe-paste.js --supply <inbox_id> --text "caption text..."
//
// A YouTube link or a public web page resolves immediately. An Instagram or
// LinkedIn link comes back as needs_capture — read it in the signed-in
// browser, then --supply the visible text. We never log a server in to a
// walled platform.

const fs = require('fs');
const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local');
loadEnvLocal(path.join(__dirname, '..'));

const HOST = process.env.SWIPE_HOST || 'https://meetdossie.com';
const SECRET = process.env.CRON_SECRET;

async function call(method, body) {
  const url = `${HOST}/api/swipe-ingest${method === 'GET' ? '?pending=1' : ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SECRET}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

async function main() {
  if (!SECRET) {
    console.error('[swipe-paste] CRON_SECRET missing. This must run from the main working tree');
    console.error('  (.env.local is gitignored and does not exist inside .claude/worktrees/).');
    process.exit(2);
  }

  const a = process.argv.slice(2);

  if (a[0] === '--pending') {
    const { data } = await call('GET');
    const rows = (data && data.pending) || [];
    if (!rows.length) { console.log('nothing waiting on a browser capture.'); return; }
    for (const r of rows) {
      console.log(`${r.id}  [${r.platform}]  ${r.submitted_url}`);
      if (r.note) console.log(`    note: ${r.note}`);
    }
    console.log('\nSupply with: node scripts/swipe-paste.js --supply <id> --file <textfile>');
    return;
  }

  if (a[0] === '--supply') {
    const id = a[1];
    const fileIdx = a.indexOf('--file');
    const textIdx = a.indexOf('--text');
    let content = null;
    if (fileIdx > 0 && a[fileIdx + 1]) content = fs.readFileSync(path.resolve(a[fileIdx + 1]), 'utf8');
    else if (textIdx > 0 && a[textIdx + 1]) content = a[textIdx + 1];
    if (!id || !content) {
      console.error('usage: --supply <inbox_id> (--file <path> | --text "...")');
      process.exit(1);
    }
    const ctaIdx = a.indexOf('--cta');
    const advIdx = a.indexOf('--advertiser');
    const { status, data } = await call('PATCH', {
      id,
      content,
      captured_by: 'extension',
      cta_text: ctaIdx > 0 ? a[ctaIdx + 1] : undefined,
      advertiser: advIdx > 0 ? a[advIdx + 1] : undefined,
    });
    console.log(status, JSON.stringify(data, null, 2));
    return;
  }

  const url = a[0];
  if (!url || url.startsWith('--')) {
    console.error('usage: node scripts/swipe-paste.js <url> [--note "..."]');
    process.exit(1);
  }
  const noteIdx = a.indexOf('--note');
  const { status, data } = await call('POST', {
    url,
    note: noteIdx > 0 ? a[noteIdx + 1] : undefined,
  });
  console.log(status, JSON.stringify(data, null, 2));
  if (data && data.status === 'needs_capture') {
    console.log('\n→ Login-walled. Read it in the signed-in browser, then:');
    console.log(`   node scripts/swipe-paste.js --supply ${data.inbox_id} --file captured.txt`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[swipe-paste] fatal:', err && err.message);
    process.exit(1);
  });
}
