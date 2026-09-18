// api/swipe-ingest.js
//
// The manual swipe inbox. Heath sees something good, sends the link, and it
// gets analysed and filed exactly like a collector-found ad — same tables,
// same pattern extraction, same evidence rules.
//
// Doc: docs/SWIPE-FILE-PIPELINE.md
// Tables: swipe_inbox, swipe_ads, swipe_patterns (20260918a_swipe_file_pipeline.sql)
//
// AUTH: Authorization: Bearer ${CRON_SECRET} on every method. This is an
// internal tool; nothing here is customer-facing.
//
// ROUTES
//   POST   /api/swipe-ingest            { url, note?, market? }
//     Files the link. If the platform is server-fetchable we resolve it
//     inline and return { status: 'analyzed' }. If it is login-walled we
//     return { status: 'needs_capture' } and park it for the browser.
//
//   GET    /api/swipe-ingest?pending=1
//     Everything waiting on a browser capture. This is what the Chrome
//     extension session is pointed at.
//
//   PATCH  /api/swipe-ingest            { id, content, captured_by? }
//     Supplies the visible text for a parked item, then analyses it.
//
// WHY INSTAGRAM WORKS THIS WAY
// Instagram serves a login wall to any server-side fetch — the URL returns
// HTTP 200 with no post content in it (verified 2026-09-18). We do not and
// will not log in to scrape it: that is against Instagram's terms and it puts
// a real account at risk. Same for LinkedIn. The supported path is the Chrome
// extension already signed in as Heath in his own browser: it reads the text
// that is on screen for a human and hands it back. A person reading their own
// feed is not scraping. See "What we never do" in the doc.

const crypto = require('crypto');
const {
  sb, classifyMarket, ingestOne,
} = require('../scripts/_lib/swipe-store');

const CRON_SECRET = process.env.CRON_SECRET;

// Platforms whose public content a server can actually retrieve.
const SERVER_FETCHABLE = new Set(['youtube', 'meta_ad_library', 'web']);

function detectPlatform(url) {
  const u = String(url || '').toLowerCase();
  if (/youtube\.com|youtu\.be/.test(u)) return 'youtube';
  if (/facebook\.com\/ads\/library/.test(u)) return 'meta_ad_library';
  if (/instagram\.com/.test(u)) return 'instagram';
  if (/linkedin\.com/.test(u)) return 'linkedin';
  if (/tiktok\.com/.test(u)) return 'tiktok';
  if (/facebook\.com/.test(u)) return 'facebook';
  if (/^https?:\/\//.test(u)) return 'web';
  return 'unknown';
}

function refFor(url) {
  return crypto.createHash('sha256').update(String(url)).digest('hex').slice(0, 32);
}

function youtubeId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Server-side resolvers ──────────────────────────────────────────────────

// YouTube: the Data API gives real view/like/comment counts when
// YOUTUBE_API_KEY is set. Without it, oEmbed still returns title + channel
// with no key at all (verified 2026-09-18) — enough to file the hook, and we
// record evidence_kind 'none' rather than pretending we have numbers.
async function resolveYouTube(url) {
  const id = youtubeId(url);
  if (!id) return null;

  if (process.env.YOUTUBE_API_KEY) {
    const api = new URL('https://www.googleapis.com/youtube/v3/videos');
    api.searchParams.set('part', 'snippet,statistics');
    api.searchParams.set('id', id);
    api.searchParams.set('key', process.env.YOUTUBE_API_KEY);
    const r = await fetch(api.toString());
    const d = await r.json().catch(() => null);
    const item = d && d.items && d.items[0];
    if (item) {
      const sn = item.snippet || {};
      const st = item.statistics || {};
      return {
        source: 'youtube',
        source_ref: id,
        advertiser: sn.channelTitle || null,
        creative_type: 'video',
        hook_text: sn.title || null,
        full_copy: [sn.title, '', sn.description || ''].join('\n'),
        link: `https://www.youtube.com/watch?v=${id}`,
        run_started_on: sn.publishedAt ? sn.publishedAt.slice(0, 10) : null,
        evidence: {
          kind: 'youtube_engagement',
          views: Number(st.viewCount) || 0,
          likes: Number(st.likeCount) || 0,
          comments: Number(st.commentCount) || 0,
          published_at: sn.publishedAt || null,
        },
        evidence_kind: 'youtube_engagement',
      };
    }
  }

  const o = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  if (!o.ok) return null;
  const d = await o.json();
  return {
    source: 'youtube',
    source_ref: id,
    advertiser: d.author_name || null,
    advertiser_url: d.author_url || null,
    creative_type: 'video',
    hook_text: d.title || null,
    full_copy: d.title || null,
    link: `https://www.youtube.com/watch?v=${id}`,
    evidence: { kind: 'none' },
    evidence_kind: 'none',
    notes: 'Resolved via YouTube oEmbed (no API key set) — title and channel only, no view/like counts.',
  };
}

// A plain public web page (a landing page, a blog post, a newsletter archive).
// Meta Ad Library permalinks land here too but render client-side, so they
// come back thin — the Playwright collector is the real path for those.
async function resolveWeb(url, platform) {
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DossieSwipeFile/1.0)' },
    redirect: 'follow',
  });
  if (!r.ok) return null;
  const html = await r.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
  const ogDesc = (html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || [])[1]
    || (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1];
  const body = stripHtml(html).slice(0, 6000);
  if (!title && !ogDesc && body.length < 120) return null;
  return {
    source: platform === 'meta_ad_library' ? 'meta_ad_library' : 'manual',
    source_ref: refFor(url),
    advertiser: null,
    creative_type: 'text',
    hook_text: (title || ogDesc || '').trim() || null,
    full_copy: [title, ogDesc, body].filter(Boolean).join('\n\n'),
    link: url,
    evidence: { kind: 'none' },
    evidence_kind: 'none',
    notes: 'Resolved by server fetch of a public page. No performance data available.',
  };
}

async function updateInbox(id, patch) {
  return sb(`swipe_inbox?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
}

// Shared tail: take a resolved/captured row, run it through the same
// ingest pipe the collectors use, and close out the inbox item.
async function analyseAndClose(inboxId, row, note) {
  const res = await ingestOne(row);
  if (!res.ok) {
    await updateInbox(inboxId, { status: 'failed', error: JSON.stringify(res.error).slice(0, 500) });
    return { ok: false, error: res.error };
  }
  await updateInbox(inboxId, {
    status: 'analyzed',
    swipe_ad_id: res.adId,
    error: res.error ? String(res.error).slice(0, 500) : null,
  });
  return {
    ok: true,
    status: 'analyzed',
    swipe_ad_id: res.adId,
    pattern_id: res.patternId || null,
    evidence_score: res.evidence_score ?? null,
    analysed: !!res.analysed,
    note: note || null,
  };
}

module.exports = async function handler(req, res) {
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // ─── GET: what is waiting on a browser capture ──────────────────────────
    if (req.method === 'GET') {
      const pending = await sb(
        'swipe_inbox?status=eq.needs_capture&select=id,submitted_url,platform,note,created_at&order=created_at.asc',
      );
      return res.status(200).json({
        ok: true,
        pending: pending.data || [],
        how_to_supply:
          'PATCH /api/swipe-ingest with { id, content } where content is the visible post text '
          + '(caption, on-screen text, and the CTA) read from the page in a signed-in browser. '
          + 'Never log a server in to a walled platform — the browser session supplies it.',
      });
    }

    // ─── POST: file a link ──────────────────────────────────────────────────
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const url = (body.url || '').trim();
      if (!url) return res.status(400).json({ ok: false, error: 'url required' });

      const platform = detectPlatform(url);
      const ins = await sb('swipe_inbox', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          submitted_url: url,
          submitted_by: body.submitted_by || 'heath',
          note: body.note || null,
          platform,
          status: 'needs_capture',
        }]),
      });
      if (!ins.ok) return res.status(500).json({ ok: false, error: ins.data });
      const inbox = Array.isArray(ins.data) ? ins.data[0] : ins.data;

      if (!SERVER_FETCHABLE.has(platform)) {
        return res.status(202).json({
          ok: true,
          status: 'needs_capture',
          inbox_id: inbox.id,
          platform,
          reason: platform === 'instagram' || platform === 'linkedin' || platform === 'facebook'
            ? `${platform} serves a login wall to server-side fetches and its terms forbid automated collection. `
              + 'Have the signed-in browser read the visible text and PATCH it back.'
            : `No server-side resolver for ${platform}. Supply the visible text via PATCH.`,
        });
      }

      let resolved = null;
      try {
        resolved = platform === 'youtube'
          ? await resolveYouTube(url)
          : await resolveWeb(url, platform);
      } catch (err) {
        resolved = null;
        console.warn('[swipe-ingest] resolve failed:', err && err.message);
      }

      if (!resolved) {
        await updateInbox(inbox.id, { status: 'needs_capture' });
        return res.status(202).json({
          ok: true,
          status: 'needs_capture',
          inbox_id: inbox.id,
          platform,
          reason: 'Server fetch returned nothing usable. Supply the visible text via PATCH.',
        });
      }

      resolved.market = body.market
        || classifyMarket(resolved.full_copy, resolved.hook_text, resolved.advertiser);
      resolved.notes = [resolved.notes, body.note ? `Heath's note: ${body.note}` : null]
        .filter(Boolean).join(' ');

      await updateInbox(inbox.id, {
        status: 'captured',
        captured_content: (resolved.full_copy || '').slice(0, 20000),
        captured_at: new Date().toISOString(),
        captured_by: 'server_fetch',
      });

      const out = await analyseAndClose(inbox.id, resolved, body.note);
      return res.status(out.ok ? 200 : 500).json({ inbox_id: inbox.id, platform, ...out });
    }

    // ─── PATCH: browser supplies the content ────────────────────────────────
    if (req.method === 'PATCH') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const { id, content } = body;
      if (!id || !content) return res.status(400).json({ ok: false, error: 'id and content required' });

      const got = await sb(`swipe_inbox?id=eq.${id}&select=*&limit=1`);
      const inbox = got.ok && Array.isArray(got.data) ? got.data[0] : null;
      if (!inbox) return res.status(404).json({ ok: false, error: 'inbox item not found' });

      await updateInbox(id, {
        status: 'captured',
        captured_content: String(content).slice(0, 20000),
        captured_at: new Date().toISOString(),
        captured_by: body.captured_by || 'extension',
      });

      const firstLine = String(content).split('\n').map((s) => s.trim()).find(Boolean) || null;
      const row = {
        source: 'manual',
        source_ref: refFor(inbox.submitted_url),
        market: body.market || classifyMarket(content, body.advertiser),
        advertiser: body.advertiser || null,
        creative_type: body.creative_type || 'unknown',
        hook_text: firstLine && firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine,
        full_copy: String(content),
        cta_text: body.cta_text || null,
        link: inbox.submitted_url,
        // A human sent this because it looked good, which is a real reason to
        // study it and NOT a performance number. Anything the browser could
        // actually read off the page (like counts) can be passed as
        // body.evidence with kind 'source_reported'.
        evidence: body.evidence || { kind: 'none' },
        evidence_kind: body.evidence ? 'source_reported' : 'none',
        notes: [
          `Captured by ${body.captured_by || 'extension'} from ${inbox.platform || 'unknown'}.`,
          inbox.note ? `Heath's note: ${inbox.note}` : null,
        ].filter(Boolean).join(' '),
      };

      const out = await analyseAndClose(id, row, inbox.note);
      return res.status(out.ok ? 200 : 500).json({ inbox_id: id, ...out });
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[swipe-ingest] uncaught:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};

module.exports.detectPlatform = detectPlatform;
