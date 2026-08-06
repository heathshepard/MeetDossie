// api/_lib/mark-complete-core.js
// ============================================================================
// Shared resolver for "mark that done" — the conversational-completion gap
// flagged in the Jarvis mission-control proposal (2026-08-06):
//
//   "There's currently no single place a conversational 'mark this done'
//    naturally lands — if you tell me in chat 'that's done', today I'd have
//    to know which of 4 different tables to touch and do it manually."
//
// Used by BOTH:
//   - /api/jarvis-mark-complete.js (direct HTTP endpoint — id-based or
//     plain-language reference)
//   - the `mark_complete` tool in _jarvis_tools.js (Jarvis voice/chat)
//
// Resolution model (deliberately simple — no LLM call, just word-overlap
// scoring against open rows in the three tables the mission-control view
// covers). If the top match isn't clearly ahead of the runner-up, this
// returns ambiguous candidates instead of guessing — same posture as the
// existing tool_remove_todo pattern in _jarvis_tools.js.
//
// Tables covered + what "complete" means for each:
//   heath_todo   -> status='done', completed_at=now()      (mirrors heath-todo-complete.js)
//   agent_queue  -> status='completed', completed_at=now()  (mirrors agent-queue-complete.js)
//   merge_queue  -> merged_to_main=true, merged_at=now()    (mirrors what
//                    cron-merge-queue-backfill.js does automatically when it
//                    detects a direct `git push` merge — this lets Heath
//                    trigger the same flip by voice instead of waiting for
//                    the daily cron)
//
// Owner: Atlas — Jarvis mission-control consolidation, 2026-08-06.
// ============================================================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function sbPatch(path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'and', 'or', 'of', 'on', 'in', 'is', 'that',
  'this', 'it', 'was', 'with', 'from', 'has', 'have', 'be', 'as', 'at', 'by',
  'done', 'complete', 'completed', 'finish', 'finished', 'mark', 'marked',
  'fix', 'fixed', 'ship', 'shipped', 'task', 'item',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function score(referenceTokens, candidateText) {
  const candTokens = new Set(tokenize(candidateText));
  if (candTokens.size === 0 || referenceTokens.length === 0) return 0;
  let hits = 0;
  for (const t of referenceTokens) if (candTokens.has(t)) hits += 1;
  return hits / referenceTokens.length; // fraction of reference words matched
}

// Pull every open row across the three tables, normalized to a common shape.
async function fetchOpenCandidates() {
  const [todos, tasks, merges] = await Promise.all([
    sbGet(
      'heath_todo?select=id,title,detail,priority,venture,status,created_at' +
      '&status=in.(pending,snoozed)&order=created_at.desc&limit=200'
    ).catch(() => []),
    sbGet(
      'agent_queue?select=id,agent_name,task_subject,task_brief,priority,venture,status,created_at' +
      '&status=in.(pending,in_progress,blocked)&order=created_at.desc&limit=200'
    ).catch(() => []),
    sbGet(
      'merge_queue?select=id,commit_sha,title,description,all_green,created_at' +
      '&merged_to_main=eq.false&order=created_at.desc&limit=200'
    ).catch(() => []),
  ]);

  const out = [];
  for (const t of todos || []) {
    out.push({
      source: 'heath_todo',
      id: t.id,
      title: t.title,
      text: `${t.title} ${t.detail || ''}`,
      status: t.status,
      created_at: t.created_at,
    });
  }
  for (const t of tasks || []) {
    out.push({
      source: 'agent_queue',
      id: t.id,
      title: `[${t.agent_name}] ${t.task_subject}`,
      text: `${t.agent_name} ${t.task_subject} ${t.task_brief || ''}`,
      status: t.status,
      created_at: t.created_at,
    });
  }
  for (const m of merges || []) {
    out.push({
      source: 'merge_queue',
      id: m.id,
      title: m.title || m.commit_sha,
      text: `${m.title || ''} ${m.description || ''} ${m.commit_sha}`,
      status: m.all_green ? 'ready_to_merge' : 'pending_signoff',
      created_at: m.created_at,
    });
  }
  return out;
}

// Applies the completion action for a resolved (source,id) pair.
async function completeRow(source, id) {
  const now = new Date().toISOString();
  if (source === 'heath_todo') {
    const rows = await sbPatch(
      `heath_todo?id=eq.${encodeURIComponent(id)}&status=in.(pending,snoozed)`,
      { status: 'done', completed_at: now }
    );
    if (!rows || rows.length === 0) return { ok: false, error: 'not_found_or_already_terminal' };
    return { ok: true, row: rows[0], action: 'marked_done' };
  }
  if (source === 'agent_queue') {
    const rows = await sbPatch(
      `agent_queue?id=eq.${encodeURIComponent(id)}&status=in.(pending,in_progress,blocked)`,
      {
        status: 'completed',
        completed_at: now,
        result_summary: 'Marked complete by Heath via jarvis-mark-complete (conversational close-out).',
        completed_by_agent_session: 'jarvis-mark-complete',
      }
    );
    if (!rows || rows.length === 0) return { ok: false, error: 'not_found_or_already_terminal' };
    return { ok: true, row: rows[0], action: 'marked_completed' };
  }
  if (source === 'merge_queue') {
    const rows = await sbPatch(
      `merge_queue?id=eq.${encodeURIComponent(id)}&merged_to_main=eq.false`,
      { merged_to_main: true, merged_at: now, merged_by_user_id: 'heath-via-jarvis', updated_at: now }
    );
    if (!rows || rows.length === 0) return { ok: false, error: 'not_found_or_already_merged' };
    return { ok: true, row: rows[0], action: 'marked_merged' };
  }
  return { ok: false, error: `unknown_source:${source}` };
}

// Resolve a plain-language reference against open candidates. Returns either
// a confident single match or an `ambiguous` list — never guesses silently.
async function resolveReference(reference) {
  const refTokens = tokenize(reference);
  if (refTokens.length === 0) {
    return { ok: false, reason: 'reference_too_vague' };
  }
  const candidates = await fetchOpenCandidates();
  const scored = candidates
    .map((c) => ({ ...c, score: score(refTokens, c.text) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { ok: false, reason: 'no_match' };
  }
  const top = scored[0];
  const runnerUp = scored[1];
  // Confident if the top score clears a floor AND has clear separation from
  // the runner-up (or there's no runner-up at all).
  const confident = top.score >= 0.5 && (!runnerUp || top.score - runnerUp.score >= 0.2);
  if (!confident) {
    return {
      ok: false,
      reason: 'ambiguous',
      candidates: scored.slice(0, 5).map((c) => ({
        source: c.source, id: c.id, title: c.title, score: Math.round(c.score * 100) / 100,
      })),
    };
  }
  return { ok: true, match: top };
}

module.exports = { fetchOpenCandidates, completeRow, resolveReference, tokenize };
