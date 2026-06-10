'use strict';

// scripts/reddit-comment-cookie.js
//
// Cookie-based Reddit comment poster. Bypasses the dead OAuth path.
// Uses session captured at scripts/sessions/reddit.json.
//
// Usage:
//   node scripts/reddit-comment-cookie.js --parent=t3_1u0piq6 --text-file=/path/to/draft.txt
//   node scripts/reddit-comment-cookie.js --parent=t3_1u0piq6 --text="literal text"
//
// On success, prints JSON: { ok: true, comment_id, permalink, url }

const path = require('path');
const fs = require('fs');

const SESSION_FILE = path.join(__dirname, 'sessions', 'reddit.json');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

function loadCookies() {
  const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
  return data.cookies.filter(c => c.domain.includes('reddit.com'));
}

function cookieHeader(cookies) {
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

async function getBearerToken(cookies) {
  // Reddit's web client embeds a JWT in the HTML at window.___r.config.accessToken.
  // The "token_v2" cookie is the refresh token; we need to extract the bearer.
  const res = await fetch('https://www.reddit.com/', {
    headers: {
      'User-Agent': USER_AGENT,
      'Cookie': cookieHeader(cookies),
      'Accept': 'text/html',
    },
    redirect: 'follow',
  });
  const html = await res.text();
  // Search for "accessToken": "eyJ..." in the HTML
  const m = html.match(/"accessToken":"([^"]+)"/);
  if (m) return { token: m[1], source: 'html' };
  return { token: null, source: 'not_found', htmlSample: html.slice(0, 500) };
}

async function postCommentViaGQL(bearerToken, cookies, parentFullname, text) {
  // Reddit's GraphQL endpoint. The web client uses this for comments.
  // Operation: CreateComment / mutation. We POST a simple comment.
  // Newer Reddit (sh.reddit) uses Apollo. Use the documented JSON API instead.
  // Easiest: POST https://oauth.reddit.com/api/comment with bearer token.
  const url = 'https://oauth.reddit.com/api/comment';
  const body = new URLSearchParams({
    api_type: 'json',
    thing_id: parentFullname,
    text,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${bearerToken}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookieHeader(cookies),
    },
    body: body.toString(),
  });
  const responseText = await res.text();
  let json = null;
  try { json = JSON.parse(responseText); } catch {}
  return { status: res.status, json, raw: responseText };
}

async function main() {
  const args = process.argv.slice(2);
  let parent = null, text = null, textFile = null;
  for (const a of args) {
    if (a.startsWith('--parent=')) parent = a.slice('--parent='.length);
    else if (a.startsWith('--text=')) text = a.slice('--text='.length);
    else if (a.startsWith('--text-file=')) textFile = a.slice('--text-file='.length);
  }
  if (textFile) text = fs.readFileSync(textFile, 'utf8').trim();

  if (!parent) {
    console.error('Missing --parent=t3_XXXX (post fullname)');
    process.exit(1);
  }
  if (!text) {
    console.error('Missing --text=... or --text-file=...');
    process.exit(1);
  }

  const cookies = loadCookies();
  console.error(`[reddit-comment-cookie] loaded ${cookies.length} cookies`);

  const { token, source, htmlSample } = await getBearerToken(cookies);
  if (!token) {
    console.error(`[reddit-comment-cookie] no bearer token found in HTML (source=${source})`);
    console.error(`[reddit-comment-cookie] htmlSample=${htmlSample}`);
    process.exit(1);
  }
  console.error(`[reddit-comment-cookie] bearer token captured (${token.length} chars, source=${source})`);

  const result = await postCommentViaGQL(token, cookies, parent, text);
  console.error(`[reddit-comment-cookie] POST status=${result.status}`);

  if (result.status === 200 && result.json) {
    const things = result.json?.json?.data?.things || [];
    const commentData = things[0]?.data;
    if (commentData) {
      const out = {
        ok: true,
        comment_id: commentData.id,
        fullname: commentData.name,
        permalink: commentData.permalink,
        url: `https://www.reddit.com${commentData.permalink}`,
      };
      process.stdout.write(JSON.stringify(out));
      return;
    }
    // Errors come back as result.json.json.errors
    const errs = result.json?.json?.errors || [];
    process.stdout.write(JSON.stringify({ ok: false, status: result.status, errors: errs, raw: result.raw.slice(0, 500) }));
    process.exit(1);
  }

  process.stdout.write(JSON.stringify({ ok: false, status: result.status, raw: result.raw.slice(0, 500) }));
  process.exit(1);
}

main().catch(err => {
  console.error('[reddit-comment-cookie] fatal:', err && err.message);
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
