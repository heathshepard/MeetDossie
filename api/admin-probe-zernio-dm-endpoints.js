'use strict';

// Vercel Serverless Function: /api/admin-probe-zernio-dm-endpoints
//
// TEMPORARY, READ-ONLY investigation endpoint for task 3 of the 2026-09-28
// autonomy build (DM monitoring). "Do not fake this. Investigate what is
// actually possible today... an honest 'blocked until ManyChat' is the
// correct deliverable if that's the truth."
//
// api/_lib/zernio-comments.js only documents VERIFIED comment endpoints
// (/v1/accounts, /v1/inbox/comments*, /v1/comment-automations*) — no DM-read
// endpoint appears anywhere in that file's "VERIFIED AGAINST THE LIVE API"
// list. This probes the most plausible DM/conversation/message endpoint
// shapes directly against the real Zernio API with the real key, the same
// way zernio-comments.js's own header was built, rather than trusting
// docs.zernio.com (which that file's own header notes disagrees with the
// live API in places).
//
// UPDATE 2026-09-28: GET /v1/inbox/conversations returned 200 with a real
// {data, pagination, meta} shape on the first probe. This second stage digs
// one level deeper: shape of a single conversation item, and whether a
// per-conversation message-read endpoint exists. Still GET only, still
// never sends anything.
//
// GET only. Message bodies are truncated hard and only a COUNT/shape is
// returned for anything with real customer content — this never dumps a
// live commenter/lead's DM text into a log or response body.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const { zernio, makeBudget } = require('./_lib/zernio-comments.js');

const CRON_SECRET = process.env.CRON_SECRET;

const CANDIDATES = [
  'GET /inbox/conversations',
  'GET /inbox/messages',
  'GET /inbox/dms',
  'GET /conversations',
  'GET /messages',
  'GET /dms',
  'GET /inbox',
];

// Redact anything that looks like real message content before it ever
// leaves this function — keep only shape/metadata.
function shapeOnly(obj, depth = 0) {
  if (depth > 3 || obj === null || obj === undefined) return typeof obj;
  if (Array.isArray(obj)) return obj.length ? [shapeOnly(obj[0], depth + 1)] : [];
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      // Redact anything that's plausibly real message/PII text; keep its type only.
      if (typeof v === 'string' && /text|message|body|content|name|handle|username/i.test(k)) {
        out[k] = `<string, len=${v.length}>`;
      } else {
        out[k] = shapeOnly(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!process.env.ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  const budget = makeBudget(30);
  const results = [];

  for (const candidate of CANDIDATES) {
    const [, path] = candidate.split(' ');
    try {
      const r = await zernio(path, {}, budget);
      results.push({
        candidate,
        status: r.status,
        ok: r.ok,
        top_level_keys: r.data && typeof r.data === 'object' ? Object.keys(r.data).slice(0, 10) : null,
        error_excerpt: r.ok ? null : String(r.error || '').slice(0, 200),
      });
    } catch (err) {
      results.push({ candidate, status: 0, ok: false, error_excerpt: err.message });
    }
  }

  // Stage 2: dig into /inbox/conversations specifically, since stage 1
  // returned 200 for it.
  let conversationsDetail = null;
  const convoResult = results.find((r) => r.candidate === 'GET /inbox/conversations' && r.ok);
  if (convoResult) {
    const r = await zernio('/inbox/conversations?limit=5', {}, budget);
    const list = (r.data && (r.data.data || r.data.conversations)) || [];
    conversationsDetail = {
      status: r.status,
      pagination: r.data && r.data.pagination,
      meta: r.data && r.data.meta,
      count_returned: Array.isArray(list) ? list.length : 0,
      first_item_shape: Array.isArray(list) && list.length > 0 ? shapeOnly(list[0]) : null,
    };

    // If a conversation has an id/accountId, try the obvious per-conversation
    // message-read shapes.
    const first = Array.isArray(list) && list.length > 0 ? list[0] : null;
    if (first) {
      const convoId = first.id || first._id || first.conversationId;
      const accountId = first.accountId || (first.account && first.account._id) || first.account;
      const msgCandidates = [];
      if (convoId) {
        msgCandidates.push(`/inbox/conversations/${encodeURIComponent(convoId)}`);
        msgCandidates.push(`/inbox/conversations/${encodeURIComponent(convoId)}/messages`);
        if (accountId) msgCandidates.push(`/inbox/conversations/${encodeURIComponent(convoId)}?accountId=${encodeURIComponent(accountId)}`);
      }
      const msgResults = [];
      for (const path of msgCandidates) {
        const mr = await zernio(path, {}, budget);
        const mlist = mr.data && (mr.data.data || mr.data.messages);
        msgResults.push({
          path,
          status: mr.status,
          ok: mr.ok,
          top_level_keys: mr.data && typeof mr.data === 'object' ? Object.keys(mr.data).slice(0, 10) : null,
          message_count: Array.isArray(mlist) ? mlist.length : null,
          first_message_shape: Array.isArray(mlist) && mlist.length > 0 ? shapeOnly(mlist[0]) : null,
          error_excerpt: mr.ok ? null : String(mr.error || '').slice(0, 200),
        });
      }
      conversationsDetail.conversation_id_field_used = convoId ? 'yes' : 'no (no id/_id/conversationId field found)';
      conversationsDetail.message_read_probe = msgResults;
    }
  }

  return res.status(200).json({ ok: true, budget_used: budget.used, results, conversations_detail: conversationsDetail });
};
