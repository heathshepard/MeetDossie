'use strict';

// scripts/swipe-collect-youtube.js
//
// Swipe-file collector #2 — YouTube Data API v3.
//
// WHAT THIS SOURCE ACTUALLY GIVES US (verified 2026-09-18):
//   search.list + videos.list return title, description, tags, publishedAt,
//   and REAL viewCount / likeCount / commentCount. Those are published
//   counters, not estimates, which makes this the only one of our three
//   sources with genuine engagement numbers attached.
//
// WHAT IT DOES NOT GIVE US:
//   Transcripts. captions.download only authorises the OWNER of a video, so
//   there is no supported way to pull a third party's transcript. We work
//   from title + description + tags and say so. Do not add a transcript
//   scraper here — see docs/SWIPE-FILE-PIPELINE.md.
//
// AUTH: needs YOUTUBE_API_KEY (a plain Google API key with YouTube Data API
// v3 enabled — no OAuth, no consent screen). We do NOT have one yet.
// api/_lib/youtube-oauth.js exists but is upload-only scaffolding and the
// user_integrations table has zero google_youtube rows, so there is no
// existing connection to borrow. Without the key this script exits 2 with a
// clear message rather than failing somewhere downstream.
//
// QUOTA: default project quota is 10,000 units/day. search.list costs 100
// units per call, videos.list costs 1. This script makes one search per
// query (about 14 queries) plus one batched videos.list per market = well
// under 2,000 units for a full weekly run.
//
// USAGE
//   node scripts/swipe-collect-youtube.js
//   node scripts/swipe-collect-youtube.js --market fitness_ai --dry-run

const path = require('path');
const { loadEnvLocal } = require('./_lib/load-env-local');
loadEnvLocal(path.join(__dirname, '..'));

const { ingestOne } = require('./_lib/swipe-store');

const API = 'https://www.googleapis.com/youtube/v3';

const MARKET_QUERIES = {
  tx_real_estate: [
    'texas realtor marketing',
    'real estate agent lead generation',
    'how to sell your house fast',
  ],
  tc_saas: [
    'transaction coordinator business',
    'real estate transaction coordinator software',
    'contract to close checklist',
  ],
  fitness_ai: [
    'ai fitness coach app',
    'best workout app review',
    'ai personal trainer',
  ],
};

function parseArgs() {
  const a = process.argv.slice(2);
  const out = { market: null, dryRun: false, perQuery: 8, days: 180 };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--market' && a[i + 1]) { out.market = a[++i]; continue; }
    if (a[i] === '--dry-run') { out.dryRun = true; continue; }
    if (a[i] === '--per-query' && a[i + 1]) { out.perQuery = parseInt(a[++i], 10) || 8; continue; }
    if (a[i] === '--days' && a[i + 1]) { out.days = parseInt(a[++i], 10) || 180; continue; }
  }
  return out;
}

async function yt(endpoint, params) {
  const url = new URL(`${API}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', process.env.YOUTUBE_API_KEY);
  const res = await fetch(url.toString());
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || `HTTP ${res.status}`;
    throw new Error(`${endpoint}: ${msg}`);
  }
  return data;
}

// Sorted by viewCount so we get what's actually working, not what's newest.
// publishedAfter keeps it to material still relevant to the current algorithm.
async function searchMarket(query, perQuery, days) {
  const publishedAfter = new Date(Date.now() - days * 86400000).toISOString();
  const s = await yt('search', {
    part: 'snippet',
    q: query,
    type: 'video',
    order: 'viewCount',
    maxResults: String(Math.min(perQuery, 50)),
    publishedAfter,
    relevanceLanguage: 'en',
    regionCode: 'US',
  });
  return (s.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
}

async function hydrate(videoIds) {
  if (!videoIds.length) return [];
  const out = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const v = await yt('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
      maxResults: '50',
    });
    out.push(...(v.items || []));
  }
  return out;
}

function firstLine(text) {
  if (!text) return null;
  const line = String(text).split('\n').map((s) => s.trim()).find(Boolean);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

// A YouTube video has no "CTA button", so we record the CTA the description
// actually makes — and null when it makes none, rather than guessing one.
function detectCta(description) {
  if (!description) return null;
  const patterns = [
    [/\b(link in (the )?(bio|description))\b/i, 'link in description'],
    [/\b(subscribe)\b/i, 'subscribe'],
    [/\b(book a (call|demo)|schedule a (call|demo))\b/i, 'book a call/demo'],
    [/\b(free (training|guide|download|trial|course))\b/i, 'free resource opt-in'],
    [/\b(join (the|my|our) (waitlist|community|group))\b/i, 'join community/waitlist'],
    [/\b(comment (the word|below))\b/i, 'comment-to-DM'],
  ];
  for (const [re, label] of patterns) if (re.test(description)) return label;
  return null;
}

async function main() {
  const args = parseArgs();
  if (!process.env.YOUTUBE_API_KEY) {
    console.error('[swipe-youtube] YOUTUBE_API_KEY is not set.');
    console.error('  Create one at console.cloud.google.com in the existing project that already');
    console.error('  holds GOOGLE_CLIENT_ID: APIs & Services -> Library -> "YouTube Data API v3" ->');
    console.error('  Enable, then Credentials -> Create credentials -> API key. Add it to Vercel and');
    console.error('  .env.local as YOUTUBE_API_KEY. No OAuth consent screen needed for public search.');
    process.exit(2);
  }

  const markets = args.market ? [args.market] : Object.keys(MARKET_QUERIES);
  let stored = 0; let analysed = 0;

  for (const market of markets) {
    const queries = MARKET_QUERIES[market];
    if (!queries) { console.error(`[swipe-youtube] unknown market "${market}"`); process.exit(1); }

    const ids = new Set();
    for (const q of queries) {
      try {
        const found = await searchMarket(q, args.perQuery, args.days);
        found.forEach((id) => ids.add(id));
        console.log(`[swipe-youtube] ${market} / "${q}": ${found.length} video(s)`);
      } catch (err) {
        console.warn(`[swipe-youtube] "${q}" failed: ${err.message}`);
      }
    }

    const videos = await hydrate([...ids]).catch((err) => {
      console.warn(`[swipe-youtube] hydrate failed: ${err.message}`);
      return [];
    });

    for (const v of videos) {
      const sn = v.snippet || {};
      const st = v.statistics || {};
      const views = Number(st.viewCount) || 0;
      const likes = Number(st.likeCount) || 0;
      const comments = Number(st.commentCount) || 0;

      const row = {
        source: 'youtube',
        source_ref: v.id,
        market,
        advertiser: sn.channelTitle || null,
        advertiser_url: sn.channelId ? `https://www.youtube.com/channel/${sn.channelId}` : null,
        creative_type: 'video',
        // The title IS the hook on YouTube — it is what stops the scroll.
        hook_text: sn.title || null,
        full_copy: [sn.title, '', sn.description || ''].join('\n'),
        cta_text: detectCta(sn.description),
        link: `https://www.youtube.com/watch?v=${v.id}`,
        run_started_on: sn.publishedAt ? sn.publishedAt.slice(0, 10) : null,
        still_active: true,
        evidence: {
          kind: 'youtube_engagement',
          views,
          likes,
          comments,
          published_at: sn.publishedAt || null,
          duration: (v.contentDetails || {}).duration || null,
        },
        evidence_kind: 'youtube_engagement',
        raw: { tags: sn.tags || null, channel_id: sn.channelId || null },
        // Recorded so nobody later assumes we have the spoken content.
        notes: 'Title + description only. YouTube captions.download authorises the video owner only, so no third-party transcript is available.',
      };

      if (args.dryRun) {
        console.log(`  [dry] ${market} · ${row.advertiser} · ${views.toLocaleString()}v/${likes.toLocaleString()}l · ${String(row.hook_text).slice(0, 70)}`);
        continue;
      }
      const res = await ingestOne(row);
      if (!res.ok) { console.warn(`  ! ${v.id}: ${JSON.stringify(res.error).slice(0, 200)}`); continue; }
      stored++;
      if (res.analysed) analysed++;
      console.log(`  ok ${market} · ${row.advertiser} · ${views.toLocaleString()} views`
        + `${res.analysed ? ` · score ${res.evidence_score}` : res.skipped ? ' · already analysed' : ''}`);
    }
  }

  console.log(`[swipe-youtube] done. stored=${stored} newly_analysed=${analysed}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[swipe-youtube] fatal:', err && err.message);
    process.exit(1);
  });
}

module.exports = { detectCta, MARKET_QUERIES };
