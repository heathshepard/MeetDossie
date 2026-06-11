// One-time migration: create sage_inbox table for Sage's autonomous review pipeline.
// Run this ONCE manually, then delete. No schedule needed.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Create sage_inbox table if it doesn't exist
  const createTableSQL = `
CREATE TABLE IF NOT EXISTS sage_inbox (
  id BIGINT PRIMARY KEY DEFAULT gen_random_bytes(8)::bigint,
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  status VARCHAR(50) DEFAULT 'pending_sage_review', -- pending_sage_review | approved | rejected | regenerating
  sage_verdict VARCHAR(20), -- approve | reject_soft | reject_hard
  sage_feedback TEXT, -- reason for rejection or issue to fix
  regeneration_attempts INT DEFAULT 0,
  regenerated_content TEXT, -- new caption if regenerated
  created_at TIMESTAMP DEFAULT NOW(),
  sage_reviewed_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sage_inbox_status ON sage_inbox(status);
CREATE INDEX IF NOT EXISTS idx_sage_inbox_post_id ON sage_inbox(post_id);
  `;

  const result = await supabaseFetch('/rest/v1/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ sql: createTableSQL }),
  });

  if (result.ok) {
    // Also create sage_engagement_queue for first-comment triggers
    const createEngagementSQL = `
CREATE TABLE IF NOT EXISTS sage_engagement_queue (
  id BIGINT PRIMARY KEY DEFAULT gen_random_bytes(8)::bigint,
  post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  platform VARCHAR(50), -- facebook, instagram, twitter, linkedin
  status VARCHAR(50) DEFAULT 'pending', -- pending | processing | posted | failed
  reply_count_threshold INT DEFAULT 3,
  current_reply_count INT DEFAULT 0,
  comment_text TEXT,
  posted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sage_engagement_status ON sage_engagement_queue(status);
CREATE INDEX IF NOT EXISTS idx_sage_engagement_post ON sage_engagement_queue(post_id);
    `;

    await supabaseFetch('/rest/v1/rpc/exec', {
      method: 'POST',
      body: JSON.stringify({ sql: createEngagementSQL }),
    });

    return res.status(200).json({
      ok: true,
      message: 'sage_inbox and sage_engagement_queue tables created successfully',
    });
  } else {
    return res.status(500).json({
      ok: false,
      error: 'Failed to create tables',
      details: result.data,
    });
  }
};
