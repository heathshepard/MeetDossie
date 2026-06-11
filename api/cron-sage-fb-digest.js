'use strict';

// api/cron-sage-fb-digest.js
//
// Daily 10 AM CDT digest of top FB comment candidates from the
// sage-fb-comment-scanner pipeline.
//
// Reads engagement_candidates where platform='facebook' AND status='pending'
// captured in the last 24h, picks the top 3 by relevance_score, and sends
// Heath ONE Telegram message via Claudy.
//
// Heath replies which one(s) he wants Sage to draft comments for. The
// existing cron-sage-draft-engagements (every 30 min) will pick those up
// when their status flips to drafted via the approval flow -- OR Heath
// can just reply with the candidate number and Cole will spawn Sage to
// draft on the spot.
//
// Schedule: Vercel cron daily 15:00 UTC (= 10 AM CDT).
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Claudy
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const TOP_N = 3;
const LOOKBACK_HOURS = 24;

// ─── Supabase ────────────────────────────────────────────────────────────────

async function sbFetch(urlPath) {
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function fetchTopCandidates() {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const path = `/rest/v1/engagement_candidates`
    + `?platform=eq.facebook`
    + `&status=eq.pending`
    + `&created_at=gte.${encodeURIComponent(since)}`
    + `&order=relevance_score.desc.nullslast,created_at.desc`
    + `&limit=${TOP_N}`;
  const { ok, data } = await sbFetch(path);
  return ok && Array.isArray(data) ? data : [];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function groupNameFromUrl(postUrl) {
  if (!postUrl) return '';
  // Mobile FB group permalinks: /groups/<slug>/permalink/<id>
  // Page posts: /<page-handle>/...
  const m = postUrl.match(/facebook\.com\/groups\/([^\/?#]+)/i);
  if (m) {
    // Slug -> humanized
    return m[1]
      .replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
      .slice(0, 60);
  }
  const p = postUrl.match(/facebook\.com\/([^\/?#]+)/i);
  if (p) return p[1].replace(/-/g, ' ').slice(0, 60);
  return '';
}

function painCategory(matched) {
  if (!Array.isArray(matched) || !matched.length) return 'general agent pain';
  const m = matched.map(x => (x || '').toLowerCase());
  if (m.some(x => x.includes('tc') || x.includes('transaction coordinator') || x.includes('coordinator'))) {
    return 'TC pain';
  }
  if (m.some(x => x.includes('trec') || x.includes('deadline') || x.includes('option period'))) {
    return 'TREC deadlines';
  }
  if (m.some(x => x.includes('compliance') || x.includes('broker'))) {
    return 'Brokerage compliance';
  }
  if (m.some(x => x.includes('drowning') || x.includes('behind') || x.includes('burned'))) {
    return 'Volume burnout';
  }
  if (m.some(x => x.includes('dotloop') || x.includes('skyslope') || x.includes('zipforms') || x.includes('transactiondesk'))) {
    return 'TC software switching cost';
  }
  return matched.slice(0, 2).join(', ');
}

function firstNChars(s, n) {
  if (!s) return '';
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : clean.slice(0, n).trim() + '...';
}

function buildDigest(rows) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  let msg = `🎯 TODAY'S TOP FB COMMENT CANDIDATES (${today})\n\n`;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const author = (r.author_handle || 'someone').replace(/[\n\r]/g, ' ').slice(0, 50);
    const grp = groupNameFromUrl(r.post_url) || 'a Texas RE group';
    const body = firstNChars(r.post_text, 100);
    const pain = painCategory(r.matched_keywords);
    msg += `${i + 1}. ${author} in ${grp} (score ${r.relevance_score})\n`;
    msg += `   "${body}"\n`;
    msg += `   Pain: ${pain}\n`;
    msg += `   Link: ${r.post_url}\n`;
    msg += `   ID: ${r.id}\n\n`;
  }
  msg += `Reply with the candidate number(s) you want Sage to draft.\n`;
  msg += `Example: "1,3" or "draft 1".`;
  return msg;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, reason: 'no_creds' };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const rows = await fetchTopCandidates();
    if (!rows.length) {
      // No-quitting rule: don't ping Heath on empty days. Just log + 200.
      res.status(200).json({ status: 'ok', candidates: 0, sent: false });
      return;
    }

    const msg = buildDigest(rows);
    const tg = await sendTelegram(msg);

    res.status(200).json({
      status: 'ok',
      candidates: rows.length,
      sent: !!tg.ok,
      telegram: tg.ok ? 'sent' : tg.reason || 'failed',
    });
  } catch (e) {
    console.error('cron-sage-fb-digest error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
