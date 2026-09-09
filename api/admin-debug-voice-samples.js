'use strict';

// api/admin-debug-voice-samples.js
//
// TEMPORARY dev-only tool, 2026-09-09 (Carter). Generates real sample
// output from the new voice guard for Heath to review before anything goes
// live: the 3 real flagged comment replies (old draft vs new draft) and a
// full sample day of the 5 daily group posts.
//
// NOTHING in this endpoint writes to any table or sends any Telegram
// message or Facebook post — it calls the real drafting functions
// (draftReply, generateCleanPost) directly with real Claude calls and
// returns the JSON. Read-only against Supabase (reddit_pain_language,
// comment-hunt-groups.json) for real content fuel.
//
// Remove this file once Heath has reviewed the samples — it exists only to
// reach the real ANTHROPIC_API_KEY, which is write-only in Vercel and
// unrecoverable from a local shell.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Owner: Carter, 2026-09-09

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const tcReply = require('./cron-tc-reply-approval.js');
const guard = require('./_lib/heath-voice-guard.js');
const { generateCleanPost, loadTargetGroups, defaultLoadPainLines } = require('./_lib/daily-group5-post-generator.js');

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

const REPLY_CASES = [
  {
    label: 'James Molter — Texas Real Estate Agents',
    oldDraft: `Haha love the confidence, James - if you had to pick the one thing clients bring up most from that 'everything,' what would it be?`,
    post: {
      group_name: 'Texas Real Estate Agents',
      post_body: "Genuinely curious what other agents actually include when they tell a client they 'handle everything' during a transaction. What does that really mean day to day for you?",
    },
    comment: { commenter_name: 'James Molter', comment_text: 'I actually offer everything.' },
  },
  {
    label: 'Ben Howard — DFW Realtors',
    oldDraft: `A couple times a week just to forward verification texts is wild, Ben - does she ever miss one if you're slow to forward it, or has that system held up so far?`,
    post: {
      group_name: 'DFW Realtors',
      post_body: 'How often are you all dealing with earnest money / option fee verification back and forth with your TC or lender on a given deal?',
    },
    comment: { commenter_name: 'Ben Howard', comment_text: 'Couple times a week. But as soon as I get a verification text, I just forward it to her.' },
  },
  {
    label: 'Holly Peery Osborne — DFW Realtors',
    oldDraft: `Holly, that's a great tip about writing both emails into the contract so there's no excuse not to copy - how often do you still find yourself having to send tha...`,
    post: {
      group_name: 'DFW Realtors',
      post_body: 'Anyone ever had an important document or notice slip through the cracks because it went to the wrong email during a transaction?',
    },
    comment: { commenter_name: 'Holly Peery Osborne', comment_text: "Heath Shepard i have not had something slip through yet, but it's because I'm on top of looking at it and you do have to forward it. In Texas, you can actually put it in the contract with your email address" },
  },
];

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  try {
    // ── Part 1: the 3 real flagged replies, old vs new ──────────────────────
    const recentOpeners = [];
    const replies = [];
    for (const c of REPLY_CASES) {
      const d = await tcReply.draftReply(c.post, c.comment, null, recentOpeners.slice());
      const check = guard.checkVoiceCompliance(d.reply);
      replies.push({
        label: c.label,
        comment: c.comment.comment_text,
        old_draft: c.oldDraft,
        new_draft: d.reply,
        voice_check: check,
      });
      if (d.reply) recentOpeners.unshift(d.reply);
    }
    const replyBatch = guard.batchVoiceCheck(replies.map((r) => r.new_draft));

    // ── Part 2: a full sample day — 5 group posts, one per group ────────────
    const groups = loadTargetGroups();
    const painLines = await defaultLoadPainLines(supabaseFetch).catch(() => []);
    const runOpeners = [];
    const posts = [];
    for (const group of groups) {
      const clean = await generateCleanPost({
        generate: async (prompt) => {
          const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 900, messages: [{ role: 'user', content: prompt }] }),
          });
          const text = await r.text();
          if (!r.ok) throw new Error(`Anthropic ${r.status}: ${text.slice(0, 200)}`);
          const data = JSON.parse(text);
          const raw = (data?.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
          let s = raw;
          if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
          const fb = s.indexOf('{'); const lb = s.lastIndexOf('}');
          return JSON.parse(s.slice(fb, lb + 1));
        },
        group,
        recentPosts: [], // first real run — no prior daily5 history in the DB
        painLines,
        log: () => {},
        recentOpeners: runOpeners,
      });
      if (clean) {
        runOpeners.unshift(clean.post_body);
        const check = guard.checkVoiceCompliance(clean.post_body);
        posts.push({ group_key: group.key, group_name: group.name, format: clean.format.id, post_body: clean.post_body, voice_check: check });
      } else {
        posts.push({ group_key: group.key, group_name: group.name, error: 'could not produce a clean post after retry' });
      }
    }
    const postBatch = guard.batchVoiceCheck(posts.map((p) => p.post_body).filter(Boolean));

    return res.status(200).json({
      ok: true,
      replies,
      reply_batch_check: replyBatch,
      posts,
      post_batch_check: postBatch,
    });
  } catch (err) {
    console.error('[admin-debug-voice-samples]', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
