'use strict';

// api/feedback-score.js
//
// Session quality feedback endpoint. Heath rates a session 1-5 with an
// optional note. Stores in cole_feedback table. Returns running average.
//
// POST /api/feedback-score
// Body: { score: 1-5, note: "optional text" }
// Auth: CRON_SECRET bearer token
//
// Also triggered by Telegram command handler in telegram-webhook.js:
//   /score 4 good session

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

async function insertFeedback(score, note) {
  const row = {
    scored_at: new Date().toISOString(),
    score: score,
    note: note || null,
    session_date: new Date().toISOString().split('T')[0],
  };
  return supabaseFetch('/cole_feedback', {
    method: 'POST',
    body: JSON.stringify(row),
  });
}

async function getAverage() {
  const { ok, data } = await supabaseFetch(
    '/cole_feedback?select=score&order=scored_at.desc&limit=100'
  );
  if (!ok || !Array.isArray(data) || data.length === 0) return null;
  const sum = data.reduce((acc, r) => acc + (Number(r.score) || 0), 0);
  return Math.round((sum / data.length) * 10) / 10;
}

// ── handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Auth
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      const raw = await new Promise((resolve, reject) => {
        let s = '';
        req.on('data', (c) => { s += c; });
        req.on('end', () => resolve(s));
        req.on('error', reject);
      });
      body = raw ? JSON.parse(raw) : {};
    } catch (_) {
      body = {};
    }
  }

  const score = parseInt(body.score, 10);
  if (!score || score < 1 || score > 5) {
    return res.status(400).json({ ok: false, error: 'score must be 1-5' });
  }

  const note = typeof body.note === 'string' ? body.note.slice(0, 500) : null;

  const insertResult = await insertFeedback(score, note);
  if (!insertResult.ok) {
    console.error('[feedback-score] insert failed:', insertResult.status, insertResult.data);
    return res.status(500).json({ ok: false, error: 'insert failed', detail: insertResult.data });
  }

  const avg = await getAverage();

  console.log(`[feedback-score] recorded score=${score} note="${note}" avg=${avg}`);

  return res.status(200).json({
    ok: true,
    score,
    note,
    running_average: avg,
  });
};
