const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-sage-draft-engagements.js
//
// Pulls engagement_candidates with status='pending', drafts a reply in Sage's
// voice via Claude Haiku, writes the draft back to comment_draft, and sets
// status='drafted'. The next cron (cron-send-engagement-approvals) ships
// them to DossieMarketingBot for Heath's tap.
//
// Schedule: every 30 minutes via cron-job.org (Vercel cron cap at 20/20).
//
// Auth: Bearer ${CRON_SECRET}.
//
// Per-run cap: 8 drafts so a single invocation stays well under the 60s
// serverless ceiling. Sage's voice is opinionated — bad keyword match means
// the draft is "SKIP" and we mark the row 'rejected' with reason='no_fit'
// instead of asking Heath about it.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// Caps locked by Heath 2026-06-10. SHARED SOURCE OF TRUTH.
const {
  canComment,
  getTodayCounts,
  meetsSubstanceFloor,
  SUBSTANCE_MIN_CHARS,
} = require('../scripts/_lib/comment-caps');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_DRAFTS_PER_RUN = 8;

// Sage's voice for engagement comments. Tighter than the social-post system
// prompt because we're replying TO someone — context-aware, not broadcast.
const SAGE_COMMENT_PROMPT = `You are Sage, Head of Social Media for Shepard Ventures. You're drafting a comment Heath Shepard (licensed Texas REALTOR who built Dossie, an AI transaction coordinator) will leave on someone else's post.

Heath's voice when commenting on other people's posts:
- Warm, casual, genuine, first-person
- Sounds like a working agent on his phone between showings
- Short sentences. Self-deprecating when appropriate.
- Never corporate. Never use "excited", "thrilled", "game-changer", "leverage", "solution", "ecosystem"
- He acknowledges their pain FIRST before mentioning anything he built

Rules for this comment:
- Be genuinely helpful — answer the question or empathize with the pain
- Mention Dossie ONE time max, as something Heath built, with a relevant beat (cost, control, deadlines)
- meetdossie.com/founding only if the post is clearly a TC/software pain point AND it would be natural
- If the post has no genuine opening for Dossie (off-topic, already solved, location outside US, just sharing a win), reply with ONLY the word SKIP
- Platform fit:
  * Facebook groups: 2-4 sentences, no hashtags
  * Instagram: 1-2 short sentences, no link (IG kills comment reach with links)
  * LinkedIn: 2-3 sentences, professional but human
- Plain ASCII only — no em dashes (use hyphens), no curly quotes
- Never fabricate specifics (member counts, ratings, customer names beyond ones in the system prompt)`;

// ─── Supabase ────────────────────────────────────────────────────────────────

async function sbFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function fetchPending(limit) {
  const path = `/rest/v1/engagement_candidates?status=eq.pending&order=relevance_score.desc.nullslast,created_at.asc&limit=${limit}`;
  const { ok, data } = await sbFetch(path);
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function patchRow(id, fields) {
  // Return ok so callers can detect persistence failures. Previously this
  // swallowed PATCH errors silently -- a draft that failed to write back to
  // the DB still flipped the in-memory state to "drafted" with no draft
  // text anywhere. Root cause of the 2026-06-10 row-29 data-loss incident.
  const { ok, status, data } = await sbFetch(
    `/rest/v1/engagement_candidates?id=eq.${id}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(fields),
    }
  );
  return { ok, status, data };
}

// ─── Claude ──────────────────────────────────────────────────────────────────

async function draftFor(row) {
  if (!ANTHROPIC_API_KEY) return { draft: null, raw: 'no ANTHROPIC_API_KEY' };

  const userMsg = [
    `Platform: ${row.platform}`,
    `Author: ${row.author_handle || 'unknown'}`,
    `Matched keywords: ${(row.matched_keywords || []).join(', ') || 'n/a'}`,
    `Relevance score: ${row.relevance_score ?? 'n/a'}`,
    `Post URL: ${row.post_url}`,
    '',
    'Post text:',
    `"""${(row.post_text || '').slice(0, 2200)}"""`,
    '',
    'Draft a Heath-voice comment for this post. Reply with ONLY the comment text, or the literal word SKIP if there is no genuine opening for Dossie.',
  ].join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 320,
        system: SAGE_COMMENT_PROMPT,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { draft: null, raw: `claude ${res.status}: ${err.slice(0, 200)}` };
    }
    const json = await res.json();
    const txt = String(json?.content?.[0]?.text || '').trim();
    if (!txt || txt.toUpperCase().startsWith('SKIP')) {
      return { draft: null, raw: 'SKIP' };
    }
    // ASCII-only cleanup matches Heath's content rules.
    const cleaned = txt
      .replace(/[—–]/g, '-')        // em / en dash
      .replace(/[‘’]/g, "'")        // curly singles
      .replace(/[“”]/g, '"')        // curly doubles
      .trim()
      .slice(0, 1000);
    return { draft: cleaned, raw: 'ok' };
  } catch (e) {
    return { draft: null, raw: `exception: ${(e && e.message) || e}` };
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-sage-draft-engagements', async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const pending = await fetchPending(MAX_DRAFTS_PER_RUN);
  if (!pending.length) {
    return res.status(200).json({ ok: true, drafted: 0, skipped: 0, message: 'queue empty' });
  }

  // Pre-flight: pull today's per-platform counts. If a platform is at cap,
  // skip drafting for it entirely so we don't waste Haiku tokens. Caps from
  // scripts/_lib/comment-caps.js (Heath-approved 2026-06-10).
  const todayCounts = await getTodayCounts(sbFetch);

  let drafted = 0;
  let skipped = 0;
  let failed = 0;
  let capSkipped = 0;

  let persistFailures = 0;
  for (const row of pending) {
    const cap = await canComment(row.platform, sbFetch);
    if (!cap.allowed) {
      await patchRow(row.id, {
        status: 'cap_deferred',
        rejection_reason: cap.reason,
      });
      capSkipped++;
      continue;
    }
    const { draft, raw } = await draftFor(row);
    if (draft) {
      // Substance floor — 80+ chars referencing specifics from the source post.
      const keywords = Array.isArray(row.matched_keywords) ? row.matched_keywords : [];
      const sub = meetsSubstanceFloor(draft, keywords);
      if (!sub.ok) {
        await patchRow(row.id, {
          status: 'rejected',
          rejection_reason: `substance_floor:${sub.reason}`,
        });
        skipped++;
        continue;
      }
      // CRITICAL: verify PATCH actually wrote comment_draft. If the PATCH
      // fails, do NOT advance status to 'drafted' -- leave the row pending
      // so the next cron run retries. Losing a draft to a silent PATCH
      // failure was the original 2026-06-10 row-29 data-loss path.
      const patch = await patchRow(row.id, {
        comment_draft: draft,
        status: 'drafted',
      });
      const wroteOk = patch && patch.ok && Array.isArray(patch.data) &&
        patch.data[0] && patch.data[0].comment_draft === draft;
      if (wroteOk) {
        drafted++;
      } else {
        persistFailures++;
        await patchRow(row.id, {
          last_error: `draft_persist_failed status=${patch && patch.status}`,
          post_attempt_count: (row.post_attempt_count || 0) + 1,
        });
        failed++;
      }
    } else if (raw === 'SKIP') {
      await patchRow(row.id, {
        status: 'rejected',
        rejection_reason: 'sage_skip_no_fit',
      });
      skipped++;
    } else {
      await patchRow(row.id, {
        last_error: raw.slice(0, 500),
        post_attempt_count: (row.post_attempt_count || 0) + 1,
      });
      failed++;
    }
    // tiny gap so Anthropic doesn't see a burst
    await new Promise((r) => setTimeout(r, 250));
  }

  return res.status(200).json({
    ok: true,
    drafted,
    skipped,
    failed,
    capSkipped,
    persistFailures,
    sampled: pending.length,
    todayCounts,
    substanceFloorChars: SUBSTANCE_MIN_CHARS,
  });
});
