// Vercel Serverless Function: /api/fb-comment-track
//
// Bumps comment_count + last_commented_at on a fb_groups row whenever Sage
// or Atlas posts a substantive comment in a Facebook group via automation.
//
// A comment is "substantive" if it's >50 chars and not a pure reaction phrase.
// Callers SHOULD only POST when those criteria are met, but this endpoint
// re-validates so a buggy caller can't pollute the metric.
//
// POST /api/fb-comment-track
// Headers:
//   Authorization: Bearer ${CRON_SECRET}
//   Content-Type:  application/json
// Body:
//   {
//     "group_url": "https://www.facebook.com/groups/...",  // required (PK)
//     "comment_text": "...",                                // required, validated
//     "agent": "sage" | "atlas",                            // optional, for audit
//     "permalink": "https://www.facebook.com/groups/.../permalink/..."  // optional
//   }
//
// Returns 200 { ok: true, comment_count, last_commented_at } on success,
//         200 { ok: false, reason: 'not_substantive' } when filtered out,
//         4xx for auth / bad input.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET  = process.env.CRON_SECRET;

const MIN_LEN = 50;

// Pure reaction phrases — if the comment IS one of these (case-insensitive,
// trimmed, punctuation-stripped) we don't count it.
const REACTION_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'no', 'nope', 'lol', 'lmao', 'haha', 'this',
  'so true', 'so this', 'agreed', 'agree', 'preach', 'facts', 'truth',
  'same', 'same here', 'me too', 'great post', 'love this', 'love it',
  'amazing', 'awesome', 'beautiful', 'stunning', 'wow', 'omg',
  'congrats', 'congratulations', 'thank you', 'thanks',
]);

function isSubstantive(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length < MIN_LEN) return false;
  const norm = text.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  if (REACTION_PHRASES.has(norm)) return false;
  return true;
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const { group_url, comment_text, agent = null, permalink = null } = req.body || {};

  if (!group_url || typeof group_url !== 'string') {
    return res.status(400).json({ ok: false, error: 'group_url required' });
  }
  if (!comment_text || typeof comment_text !== 'string') {
    return res.status(400).json({ ok: false, error: 'comment_text required' });
  }

  if (!isSubstantive(comment_text)) {
    return res.status(200).json({ ok: false, reason: 'not_substantive', comment_len: comment_text.length });
  }

  // Find the row first (to compute new comment_count atomically-ish via PATCH).
  // Supabase PostgREST doesn't support `comment_count = comment_count + 1`
  // expressions, so we read-then-write. Race condition is acceptable here:
  // we'll undercount by 1 at most if Sage and Atlas post comments in the
  // same second — not material for an unlock threshold of 5+.
  const findRes = await supa(`fb_groups?group_url=eq.${encodeURIComponent(group_url)}&select=comment_count`);
  if (!findRes.ok) {
    const t = await findRes.text();
    return res.status(500).json({ ok: false, error: 'fb_groups lookup failed', detail: t.slice(0, 200) });
  }
  const found = await findRes.json();

  const now = new Date().toISOString();

  if (!found.length) {
    // Auto-insert row when we comment in a group we hadn't tracked yet.
    // posting_status defaults to 'unknown' — Sage/Heath can refine later.
    const groupName = group_url.replace(/^https?:\/\/(www\.|m\.)?facebook\.com\/groups\//, '').replace(/\/$/, '');
    const insertRes = await supa('fb_groups', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        group_url,
        group_name: groupName,
        comment_count: 1,
        last_commented_at: now,
        member_status: 'member', // safe default: we wouldn't comment if not a member
        notes: agent ? `Auto-created from ${agent} comment` : 'Auto-created from comment-track',
      }),
    });
    if (!insertRes.ok) {
      const t = await insertRes.text();
      return res.status(500).json({ ok: false, error: 'auto-insert failed', detail: t.slice(0, 200) });
    }
    return res.status(200).json({ ok: true, comment_count: 1, last_commented_at: now, created: true });
  }

  const newCount = (found[0].comment_count || 0) + 1;

  const patchRes = await supa(`fb_groups?group_url=eq.${encodeURIComponent(group_url)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      comment_count: newCount,
      last_commented_at: now,
    }),
  });

  if (!patchRes.ok) {
    const t = await patchRes.text();
    return res.status(500).json({ ok: false, error: 'PATCH failed', detail: t.slice(0, 200) });
  }

  // Optional audit log — best-effort, non-fatal
  try {
    await supa('ventures_activity_events', {
      method: 'POST',
      body: JSON.stringify({
        agent_name: agent || 'unknown',
        company: 'dossie',
        event_type: 'fb_comment_posted',
        summary: `Comment in FB group (${group_url})`,
        detail: { comment_count: newCount, permalink, comment_len: comment_text.length },
      }),
    });
  } catch (_) { /* swallow */ }

  return res.status(200).json({ ok: true, comment_count: newCount, last_commented_at: now });
}
