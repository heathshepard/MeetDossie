// api/_lib/youtube-oauth.js
//
// Shared YouTube Data API v3 client: loads the stored google_youtube OAuth
// token for a user, auto-refreshes on expiry/401, and uploads a video via
// the resumable upload protocol (videos.insert).
//
// Auth model matches api/_lib/gmail-oauth.js: one row per (user_id,
// oauth_provider) in public.user_integrations, written by
// /api/youtube-oauth-init + /api/google-oauth-callback. Provider here is
// 'google_youtube', distinct from the 'google_calendar' row that carries
// Gmail/Calendar scopes — a user can hold both independently.
//
// Owner: Atlas (2026-08-25).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const PROVIDER = 'google_youtube';
const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';
const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function sb(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Returns { access_token, refresh_token, expires_at, google_email } or null.
async function loadYouTubeTokensForUser(userId) {
  const { ok, data } = await sb(
    `user_integrations?select=access_token,refresh_token,expires_at,google_email`
    + `&user_id=eq.${encodeURIComponent(userId)}&oauth_provider=eq.${PROVIDER}&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function persistAccessToken(userId, accessToken, expiresAt) {
  await sb(`user_integrations?user_id=eq.${encodeURIComponent(userId)}&oauth_provider=eq.${PROVIDER}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
  }).catch(() => {});
}

async function refreshGoogleToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || `http_${res.status}`;
    const err = new Error(`google_refresh_failed:${detail}`);
    err.isInvalidGrant = data?.error === 'invalid_grant';
    throw err;
  }
  return data;
}

// Ensures a fresh access token for this user, refreshing + persisting if the
// stored one is at or past its recorded expiry. Returns the access token.
async function getValidAccessToken(userId) {
  const tokens = await loadYouTubeTokensForUser(userId);
  if (!tokens || !tokens.refresh_token) {
    const err = new Error('youtube_not_connected');
    err.code = 'not_connected';
    throw err;
  }
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  const skewMs = 60_000; // refresh 60s early
  if (tokens.access_token && expiresAt - skewMs > Date.now()) {
    return tokens.access_token;
  }
  const refreshed = await refreshGoogleToken(tokens.refresh_token);
  const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
  await persistAccessToken(userId, refreshed.access_token, newExpiresAt);
  return refreshed.access_token;
}

// Confirms the connected account and returns the channel snippet
// (id, title) via channels.list?mine=true. Cheap sanity check to run right
// after connecting, or before an upload, to catch a wrong/expired grant
// early instead of failing mid-upload.
async function getMyChannel(userId) {
  const accessToken = await getValidAccessToken(userId);
  const r = await fetch(`${API_BASE}/channels?part=snippet,status&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`youtube_channels_list_failed:${r.status}:${data?.error?.message || ''}`);
  }
  const channel = data?.items?.[0];
  if (!channel) throw new Error('youtube_no_channel_for_account');
  return {
    id: channel.id,
    title: channel.snippet?.title || null,
    uploadsAllowed: channel.status?.longUploadsStatus !== 'disallowed',
  };
}

// Uploads a video via the YouTube resumable upload protocol:
//   1. POST metadata to UPLOAD_ENDPOINT?uploadType=resumable -> get a
//      session Location URL back in the response headers.
//   2. PUT the raw video bytes to that Location URL.
// videoBuffer: Buffer|Uint8Array of the raw video file (mp4 etc).
// meta: { title, description, tags?: string[], categoryId?: string,
//         privacyStatus?: 'private'|'unlisted'|'public' }
// Returns { videoId, url }.
async function uploadVideo(userId, videoBuffer, meta = {}) {
  if (!videoBuffer || !videoBuffer.length) {
    throw new Error('youtube_upload_empty_buffer');
  }
  const accessToken = await getValidAccessToken(userId);

  const body = {
    snippet: {
      title: (meta.title || 'Untitled').slice(0, 100),
      description: (meta.description || '').slice(0, 5000),
      tags: Array.isArray(meta.tags) ? meta.tags.slice(0, 500) : undefined,
      categoryId: meta.categoryId || '22', // 22 = People & Blogs, YouTube's generic default
    },
    status: {
      privacyStatus: meta.privacyStatus || 'private',
      selfDeclaredMadeForKids: false,
    },
  };

  // Step 1: initiate resumable session.
  const initRes = await fetch(`${UPLOAD_ENDPOINT}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': meta.mimeType || 'video/mp4',
      'X-Upload-Content-Length': String(videoBuffer.length),
    },
    body: JSON.stringify(body),
  });
  if (!initRes.ok) {
    const errBody = await initRes.text().catch(() => '');
    throw new Error(`youtube_upload_init_failed:${initRes.status}:${errBody.slice(0, 300)}`);
  }
  const sessionUrl = initRes.headers.get('location');
  if (!sessionUrl) {
    throw new Error('youtube_upload_init_missing_location_header');
  }

  // Step 2: PUT the actual bytes to the session URL.
  const putRes = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': meta.mimeType || 'video/mp4',
      'Content-Length': String(videoBuffer.length),
    },
    body: videoBuffer,
  });
  const putData = await putRes.json().catch(() => null);
  if (!putRes.ok) {
    throw new Error(`youtube_upload_put_failed:${putRes.status}:${JSON.stringify(putData).slice(0, 300)}`);
  }

  const videoId = putData?.id;
  if (!videoId) {
    throw new Error('youtube_upload_no_video_id_in_response');
  }
  return { videoId, url: `https://youtu.be/${videoId}` };
}

// Fetches processing/upload status for a previously-uploaded video —
// useful for polling after uploadVideo() since YouTube processes async.
async function getVideoStatus(userId, videoId) {
  const accessToken = await getValidAccessToken(userId);
  const r = await fetch(
    `${API_BASE}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    throw new Error(`youtube_video_status_failed:${r.status}:${data?.error?.message || ''}`);
  }
  return data?.items?.[0] || null;
}

module.exports = {
  PROVIDER,
  loadYouTubeTokensForUser,
  persistAccessToken,
  refreshGoogleToken,
  getValidAccessToken,
  getMyChannel,
  uploadVideo,
  getVideoStatus,
};
