// Vercel Serverless Function: /api/youtube-upload
// =========================================================================
// Uploads a video to YouTube on behalf of a connected user, using the
// google_youtube OAuth grant from /api/youtube-oauth-init +
// /api/google-oauth-callback (api/_lib/youtube-oauth.js).
//
// This is an internal/automation endpoint, not a customer-facing one — it's
// the upload half of "Build YouTube Data API upload authorization flow".
// Callers: future crons/scripts that already have a rendered video URL
// (Creatomate output, Supabase Storage, etc) and want it on a connected
// YouTube channel directly, independent of Zernio (see docs/PIPELINE.md —
// Zernio holds a separate OAuth grant against the "Shepard Real Estate
// Solutions" channel; this endpoint is the direct-API path for cases Zernio
// doesn't cover, e.g. a channel with no Zernio connection, or upload
// features Zernio's scheduler doesn't expose).
//
// POST /api/youtube-upload
//   Authorization: Bearer <CRON_SECRET>
//   Body (JSON):
//     {
//       user_id: "<uuid>",       // whose google_youtube grant to use
//       video_url: "https://...",// publicly fetchable video file
//       title: "...",            // required, <=100 chars (YouTube limit)
//       description?: "...",     // <=5000 chars
//       tags?: ["...", ...],
//       privacyStatus?: "private" | "unlisted" | "public",  // default "private"
//       category_id?: "22"
//     }
//
// Behavior:
//   1. Verify Bearer CRON_SECRET (this is a service-to-service call, not a
//      user-facing one — no Supabase user session involved).
//   2. Validate body.
//   3. Fetch video_url into memory (Vercel function memory limits apply —
//      fine for social-length video, not for long-form/large files; a
//      streaming variant is future work if that's ever needed).
//   4. Upload via youtube-oauth.js uploadVideo() (resumable upload).
//   5. Return { ok, video_id, url }.
//
// Defaults privacyStatus to "private" deliberately — an upload landing
// public by accident is a much worse failure mode than a caller having to
// explicitly ask for "public".
//
// Owner: Atlas (2026-08-25).

const { uploadVideo, getMyChannel } = require('./_lib/youtube-oauth.js');

const CRON_SECRET = process.env.CRON_SECRET;

const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200MB — comfortably above social-length video, well under YouTube's own cap

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const body = req.body || {};
  const userId = String(body.user_id || '').trim();
  const videoUrl = String(body.video_url || '').trim();
  const title = String(body.title || '').trim();

  if (!userId) return res.status(400).json({ ok: false, error: 'user_id_required' });
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    return res.status(400).json({ ok: false, error: 'video_url_required' });
  }
  if (!title) return res.status(400).json({ ok: false, error: 'title_required' });

  const privacyStatus = ['private', 'unlisted', 'public'].includes(body.privacy_status)
    ? body.privacy_status
    : 'private';

  // Sanity-check the grant + channel before spending time on the download.
  try {
    const channel = await getMyChannel(userId);
    if (channel.uploadsAllowed === false) {
      return res.status(409).json({ ok: false, error: 'channel_uploads_disallowed', channel });
    }
  } catch (err) {
    const code = err.code === 'not_connected' ? 409 : 502;
    return res.status(code).json({
      ok: false,
      error: err.code === 'not_connected' ? 'youtube_not_connected' : 'channel_check_failed',
      detail: err.message,
      hint: err.code === 'not_connected'
        ? 'User has no google_youtube row in user_integrations — run /api/youtube-oauth-init first.'
        : undefined,
    });
  }

  // Fetch the video bytes.
  let videoBuffer;
  try {
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) {
      return res.status(502).json({ ok: false, error: 'video_url_fetch_failed', status: videoRes.status });
    }
    const contentLength = Number(videoRes.headers.get('content-length') || 0);
    if (contentLength && contentLength > MAX_VIDEO_BYTES) {
      return res.status(413).json({ ok: false, error: 'video_too_large', bytes: contentLength, max: MAX_VIDEO_BYTES });
    }
    const arrayBuffer = await videoRes.arrayBuffer();
    videoBuffer = Buffer.from(arrayBuffer);
    if (videoBuffer.length > MAX_VIDEO_BYTES) {
      return res.status(413).json({ ok: false, error: 'video_too_large', bytes: videoBuffer.length, max: MAX_VIDEO_BYTES });
    }
  } catch (err) {
    console.error('[youtube-upload] video fetch failed:', err.message);
    return res.status(502).json({ ok: false, error: 'video_fetch_error', detail: err.message.slice(0, 200) });
  }

  // Upload.
  try {
    const result = await uploadVideo(userId, videoBuffer, {
      title,
      description: body.description || '',
      tags: body.tags,
      categoryId: body.category_id,
      privacyStatus,
    });
    return res.status(200).json({ ok: true, video_id: result.videoId, url: result.url, privacy_status: privacyStatus });
  } catch (err) {
    console.error('[youtube-upload] upload failed:', err.message);
    return res.status(502).json({ ok: false, error: 'upload_failed', detail: err.message.slice(0, 400) });
  }
};

module.exports.config = { api: { bodyParser: true }, maxDuration: 300 };
