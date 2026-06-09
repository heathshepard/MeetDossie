'use strict';

// api/_lib/reddit-oauth.js
//
// Reddit OAuth helper. Supports script-type apps using either:
//   1) refresh_token grant (preferred — long-lived)
//   2) password grant (fallback — for personal accounts where REDDIT_USERNAME /
//      REDDIT_PASSWORD are available)
//
// Token cached in-memory for 50 minutes (Reddit tokens last 60).
//
// Env vars:
//   REDDIT_CLIENT_ID       (required)
//   REDDIT_CLIENT_SECRET   (required)
//   REDDIT_REFRESH_TOKEN   (optional — use if present)
//   REDDIT_USERNAME        (optional — fallback)
//   REDDIT_PASSWORD        (optional — fallback)
//   REDDIT_USER_AGENT      (optional — defaults to DossieBot/1.0)

const USER_AGENT = process.env.REDDIT_USER_AGENT || 'DossieBot/1.0 (+https://meetdossie.com)';
const TOKEN_TTL_MS = 50 * 60 * 1000;

let cachedToken = null;
let cachedAt = 0;

function authHeader() {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET required');
  }
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

async function getAccessToken({ force = false } = {}) {
  if (!force && cachedToken && (Date.now() - cachedAt) < TOKEN_TTL_MS) {
    return cachedToken;
  }

  const refreshToken = process.env.REDDIT_REFRESH_TOKEN;
  const username = process.env.REDDIT_USERNAME;
  const password = process.env.REDDIT_PASSWORD;

  let body;
  if (refreshToken) {
    body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  } else if (username && password) {
    body = new URLSearchParams({ grant_type: 'password', username, password });
  } else {
    throw new Error('Need REDDIT_REFRESH_TOKEN or REDDIT_USERNAME+REDDIT_PASSWORD');
  }

  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Reddit token fetch failed ${res.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try { data = JSON.parse(text); } catch {
    throw new Error(`Reddit token response not JSON: ${text.slice(0, 200)}`);
  }

  if (!data.access_token) {
    throw new Error(`Reddit token response missing access_token: ${text.slice(0, 200)}`);
  }

  cachedToken = data.access_token;
  cachedAt = Date.now();
  return cachedToken;
}

async function oauthFetch(urlPath, init = {}) {
  const token = await getAccessToken();
  const url = urlPath.startsWith('http') ? urlPath : `https://oauth.reddit.com${urlPath}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': USER_AGENT,
    ...(init.headers || {}),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch {}
  }
  return { ok: res.ok, status: res.status, data, text };
}

// Post a comment as a reply to parentId (a "thing" fullname, e.g. "t3_abc123"
// for a post or "t1_xyz789" for a comment).
// Returns: { permalink, id, fullname }
async function postComment(parentId, text) {
  if (!parentId) throw new Error('parentId required');
  if (!text || !text.trim()) throw new Error('text required');

  const body = new URLSearchParams({
    api_type: 'json',
    thing_id: parentId,
    text,
  });

  const { ok, status, data, text: raw } = await oauthFetch('/api/comment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!ok) {
    throw new Error(`postComment failed ${status}: ${raw.slice(0, 300)}`);
  }

  const errors = data?.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`postComment errors: ${JSON.stringify(errors)}`);
  }

  const thing = data?.json?.data?.things?.[0]?.data;
  if (!thing) {
    throw new Error(`postComment response missing comment: ${raw.slice(0, 300)}`);
  }

  return {
    id: thing.id,
    fullname: thing.name,
    permalink: thing.permalink || null,
  };
}

// Delete a comment by fullname (e.g. "t1_xyz789").
async function deleteThing(fullname) {
  const body = new URLSearchParams({ id: fullname });
  const { ok, status, text } = await oauthFetch('/api/del', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!ok) {
    throw new Error(`deleteThing failed ${status}: ${text.slice(0, 200)}`);
  }
  return true;
}

// Fetch a post by post id (without t3_ prefix) or permalink path.
async function getPost(postIdOrPath) {
  let pathPart;
  if (postIdOrPath.startsWith('/r/')) {
    pathPart = postIdOrPath.replace(/\.json$/, '');
  } else {
    const id = postIdOrPath.replace(/^t3_/, '');
    pathPart = `/comments/${id}`;
  }
  const { ok, status, data, text } = await oauthFetch(`${pathPart}.json?limit=1`);
  if (!ok) {
    throw new Error(`getPost failed ${status}: ${text.slice(0, 200)}`);
  }
  const post = data?.[0]?.data?.children?.[0]?.data;
  if (!post) {
    throw new Error(`getPost: post not found in response`);
  }
  return post;
}

// Fetch /r/<sub>/new — used by the local scanner.
// Returns array of post data objects with permalink, id, etc.
async function fetchSubredditNew(subreddit, limit = 50) {
  const { ok, status, data, text } = await oauthFetch(`/r/${subreddit}/new?limit=${limit}&raw_json=1`);
  if (!ok) {
    throw new Error(`fetchSubredditNew r/${subreddit} failed ${status}: ${text.slice(0, 200)}`);
  }
  const children = data?.data?.children || [];
  return children.map(c => c.data).filter(Boolean);
}

module.exports = {
  getAccessToken,
  postComment,
  deleteThing,
  getPost,
  fetchSubredditNew,
  oauthFetch,
};
