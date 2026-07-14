'use strict';

// api/cron-autonomous-daily-digest.js
// =============================================================================
// SV-ENG-RIDGE-AUTONOMOUS-DIGEST-001 (Ridge, 2026-07-01)
//
// Daily 6:00 AM CDT (11:00 UTC). Reads the last 24h of autonomous_loop_runs
// and sends Heath ONE plain-English morning brief:
//
//   Overnight your team shipped X and Y. Blocked on Z waiting for you.
//   Nothing scary happened.
//
// Also updates jarvis_future_builds with ship_commit_sha when we can match
// a completed queue row to a recent git commit (best-effort; not guaranteed).
//
// Delivery: Telegram (primary) + Resend email (secondary, optional).
//
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// SCHEDULE: "0 11 * * *"  (6 AM CDT = 11 UTC)
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;
const RESEND_API_KEY            = process.env.RESEND_API_KEY;

const HEATH_EMAIL = 'heath.shepard@kw.com';

async function sb(pathAndQuery, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return { ok: r.ok };
  } catch (err) {
    console.error('[digest] tg error:', err && err.message);
    return { ok: false };
  }
}

async function email(subject, htmlBody) {
  if (!RESEND_API_KEY) return { ok: false, skipped: 'no_key' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Ridge <heath@meetdossie.com>',
        to: [HEATH_EMAIL],
        subject,
        html: htmlBody,
      }),
    });
    return { ok: r.ok };
  } catch (err) {
    console.error('[digest] email error:', err && err.message);
    return { ok: false };
  }
}

// ─── Plain-English rendering helpers ─────────────────────────────────────────
// Per feedback_customer_emails_minimize_problem.md and feedback_telegram_plain_english.md:
// no jargon, no fabricated specifics, calm and short.

function pluralize(n, singular, plural) {
  return n === 1 ? singular : (plural || (singular + 's'));
}

// Group candidates by category so the digest can show top 3 per bucket
// (yesterday's conversation review, overnight capability scan, 7d rule audit).
// Fallback: candidates without a category column are treated as
// "conversation_review" so old rows still surface.
function groupCandidatesByCategory(candidates) {
  const groups = { conversation_review: [], capability_scan: [], rule_audit: [] };
  for (const c of (candidates || [])) {
    const cat = groups[c.category] ? c.category : 'conversation_review';
    groups[cat].push(c);
  }
  // Each group is already ordered by impact_score desc from the SQL query,
  // but re-sort defensively in case category grouping reordered anything.
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => (b.impact_score || 0) - (a.impact_score || 0));
  }
  return groups;
}

const CATEGORY_LABELS = {
  conversation_review: 'Yesterday\'s conversation review',
  capability_scan:     'Overnight capability scan',
  rule_audit:          'Rule audit (7d rolling)',
};

let __digestGlobalCounter = 0;

// Format age as [Nh], [Nd], with 🟡 flag for 72h–7d and 🔴 for >7d.
// Locked 2026-07-06 — prevents Heath action items from silently rotting past 3+ days.
function formatHeathActionAge(createdAtIso) {
  if (!createdAtIso) return { label: '[?]', hours: 0, flag: '' };
  const ageMs  = Date.now() - new Date(createdAtIso).getTime();
  const ageHrs = Math.floor(ageMs / (3600 * 1000));
  const ageDays = Math.floor(ageHrs / 24);
  let label;
  if (ageHrs < 24) {
    label = `${ageHrs}h`;
  } else {
    label = `${ageDays}d`;
  }
  let flag = '';
  if (ageHrs >= 24 * 7) {
    flag = ' 🔴';
  } else if (ageHrs >= 72) {
    flag = ' 🟡';
  }
  return { label: `[${label}${flag}]`, hours: ageHrs, flag: flag.trim() };
}

function renderHeathActionsBlock(pendingActions) {
  if (!Array.isArray(pendingActions) || pendingActions.length === 0) return [];
  // Sort oldest first so stalest items are on top.
  const sorted = [...pendingActions].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return ta - tb;
  });
  const shown = sorted.slice(0, 10);
  const lines = [];
  lines.push('<b>Heath action items (by age):</b>');
  for (const a of shown) {
    const age = formatHeathActionAge(a.created_at);
    const title = String(a.title || 'unnamed').slice(0, 90);
    // brief = first line of body, trimmed
    let brief = '';
    if (a.body) {
      const firstLine = String(a.body).split('\n')[0].trim();
      if (firstLine && firstLine.length > 3) {
        brief = ' — ' + firstLine.slice(0, 90);
      }
    }
    lines.push(`• ${age.label} ${title}${brief}`);
  }
  if (sorted.length > shown.length) {
    lines.push(`<i>...${sorted.length - shown.length} more at <a href="https://meetdossie.com/ventures/heath-actions">meetdossie.com/ventures/heath-actions</a></i>`);
  }
  lines.push('');
  return lines;
}

function renderPlainEnglishSummary(runs, completedTasks, blocked, stuck, selfImprovementCandidates, heathActions) {
  const shipped = completedTasks.length;
  const attempted = runs.filter(r => r.outcome === 'dispatched').length;
  const escalated = runs.filter(r => r.outcome === 'skipped_guardrail').length;

  const lines = [];
  lines.push('<b>Morning brief — autonomous loop</b>');
  lines.push('');

  // Opening line — what happened overnight
  if (shipped === 0 && attempted === 0) {
    lines.push('Overnight your team was idle — nothing needed attention. Quiet is healthy.');
  } else if (shipped === 0 && attempted > 0) {
    lines.push(`Overnight your team started ${attempted} ${pluralize(attempted, 'thing')} — still in progress, none finished yet.`);
  } else {
    lines.push(`Overnight your team shipped ${shipped} ${pluralize(shipped, 'thing')}.`);
  }
  lines.push('');

  // What shipped
  if (completedTasks.length > 0) {
    lines.push('<b>Shipped:</b>');
    for (const t of completedTasks.slice(0, 8)) {
      const short = String(t.task_subject || t.item_picked || 'unnamed').slice(0, 100);
      const agent = t.agent_name || t.agent_dispatched || '?';
      lines.push(`• ${short} <i>(${agent})</i>`);
    }
    if (completedTasks.length > 8) {
      lines.push(`• ...and ${completedTasks.length - 8} more.`);
    }
    lines.push('');
  }

  // What's blocked waiting for Heath
  if (blocked.length > 0) {
    lines.push('<b>Blocked on you:</b>');
    for (const b of blocked.slice(0, 5)) {
      const short = String(b.item_picked || 'unnamed').slice(0, 100);
      const reason = String(b.outcome_reason || '').replace(/^guardrail:/, '');
      lines.push(`• ${short} — needs your call on <i>${reason}</i>`);
    }
    if (blocked.length > 5) {
      lines.push(`• ...and ${blocked.length - 5} more.`);
    }
    lines.push('');
  }

  // Stuck signals
  if (stuck.length > 0) {
    lines.push('<b>Stuck (human review):</b>');
    for (const s of stuck.slice(0, 3)) {
      const short = String(s.item_picked || s.signal_key || 'unnamed').slice(0, 100);
      lines.push(`• ${short}`);
    }
    lines.push('');
  }

  // Heath action items — surfaces stale pending items so nothing rots.
  // Sorted oldest first; yellow flag at 72h, red flag at 7d.
  const heathActionLines = renderHeathActionsBlock(heathActions);
  for (const l of heathActionLines) lines.push(l);

  // Self-improvement — top 3 per category (conversation / capability / rule)
  if (Array.isArray(selfImprovementCandidates) && selfImprovementCandidates.length > 0) {
    const grouped = groupCandidatesByCategory(selfImprovementCandidates);
    let globalIdx = 0;
    let anyShown = false;

    // Dedup across ALL categories by title. The daily drafter re-inserts the
    // same title every run (e.g. "Reliability gap: 1 cron stuck…"), so pending
    // rows pile up and previously showed 3× in the brief. Keep the highest-
    // impact / oldest surviving row per title (already ordered by SQL query).
    const seenTitles = new Set();

    for (const catKey of ['conversation_review', 'capability_scan', 'rule_audit']) {
      const items = grouped[catKey]
        .filter((c) => {
          const key = String(c.title || '').trim().toLowerCase();
          if (!key) return true;
          if (seenTitles.has(key)) return false;
          seenTitles.add(key);
          return true;
        })
        .slice(0, 3);
      if (items.length === 0) continue;
      if (!anyShown) {
        lines.push('<b>Self-improvement — say yes/no:</b>');
        anyShown = true;
      }
      lines.push('');
      lines.push(`<i>${CATEGORY_LABELS[catKey]}</i>`);
      for (const c of items) {
        globalIdx += 1;
        const shortTitle = String(c.title || 'unnamed').slice(0, 140);
        lines.push(`${globalIdx}. ${shortTitle}`);
        if (c.rationale) {
          lines.push(`   <i>why:</i> ${String(c.rationale).slice(0, 200)}`);
        }
      }
    }

    if (anyShown) {
      lines.push('');
      lines.push('<i>Reply "approve 1", "reject 2", "defer 3" (yes/no/skip also work). Multi-select OK: "approve 1 3 5".</i>');
      lines.push('');
    }
    __digestGlobalCounter = globalIdx;
  }

  // Closing line
  if (escalated === 0 && stuck.length === 0) {
    lines.push('<i>Nothing scary happened.</i>');
  }

  lines.push('');
  lines.push('Watch live at <a href="https://meetdossie.com/ventures/reliability">meetdossie.com/ventures/reliability</a>.');

  return lines.join('\n');
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-autonomous-daily-digest', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // 1) Pull runs from last 24h
  const r1 = await sb(`autonomous_loop_runs?select=*&run_ts=gte.${encodeURIComponent(since)}&order=run_ts.desc&limit=200`);
  const runs = (r1.ok && Array.isArray(r1.data)) ? r1.data : [];

  // 2) Pull queue rows the loop dispatched (queue_id in runs) so we can see
  //    which of them actually completed. Batch by queue_id list.
  const queueIds = runs.filter(r => r.queue_id).map(r => r.queue_id);
  let completedTasks = [];
  if (queueIds.length > 0) {
    const ids = queueIds.slice(0, 100).map(id => `"${id}"`).join(',');
    const r2 = await sb(`agent_queue?select=id,agent_name,task_subject,status,completed_at,result_summary&id=in.(${ids})&status=eq.completed`);
    if (r2.ok && Array.isArray(r2.data)) {
      // Merge with run's item_picked for readability
      const runByQueue = new Map(runs.map(r => [r.queue_id, r]));
      completedTasks = r2.data.map(t => ({
        ...t,
        item_picked: runByQueue.get(t.id)?.item_picked,
        agent_dispatched: runByQueue.get(t.id)?.agent_dispatched,
      }));
    }
  }

  const blocked = runs.filter(r => r.outcome === 'skipped_guardrail');
  const stuck   = runs.filter(r => r.outcome === 'skipped_stuck');

  // 3) Pull top pending self-improvement candidates for Heath's yes/no.
  //    Order: highest impact_score first, then oldest drafted_at as tiebreaker.
  //    Pull ≤30 so the renderer can show top 3 per category (3 categories × 3).
  //    Try selecting the "category" column first; fall back gracefully if the
  //    column doesn't exist yet.
  let selfImprovementCandidates = [];
  {
    const rCands = await sb(
      'self_improvement_candidates?select=id,tier,category,change_kind,title,rationale,impact_score,drafted_at'
      + '&heath_decision=is.null&order=impact_score.desc,drafted_at.asc&limit=30'
    );
    if (rCands.ok && Array.isArray(rCands.data)) {
      selfImprovementCandidates = rCands.data;
    } else {
      // Fallback: older schema without category column
      const rFallback = await sb(
        'self_improvement_candidates?select=id,tier,change_kind,title,rationale,impact_score,drafted_at'
        + '&heath_decision=is.null&order=impact_score.desc,drafted_at.asc&limit=30'
      );
      if (rFallback.ok && Array.isArray(rFallback.data)) {
        selfImprovementCandidates = rFallback.data;
      }
    }
  }

  // 3b) Pull all pending heath_actions so we can surface stale items in the digest.
  //     Ordered oldest first at render-time (regardless of DB order).
  //     Skip snoozed items whose snoozed_until is still in the future.
  let heathActions = [];
  {
    const rHA = await sb(
      'heath_actions?select=id,title,body,source,priority,created_at,snoozed_until,deadline'
      + '&status=eq.pending&order=created_at.asc&limit=100'
    );
    if (rHA.ok && Array.isArray(rHA.data)) {
      const nowMs = Date.now();
      heathActions = rHA.data.filter(a => {
        if (!a.snoozed_until) return true;
        return new Date(a.snoozed_until).getTime() <= nowMs;
      });
    }
  }

  // 4) Stamp surfaced_in_brief_at so we know these were shown.
  //    Only stamp the ones the renderer actually included (top 3 per category).
  const shownIds = [];
  if (selfImprovementCandidates.length > 0) {
    const grouped = groupCandidatesByCategory(selfImprovementCandidates);
    for (const catKey of ['conversation_review', 'capability_scan', 'rule_audit']) {
      for (const c of grouped[catKey].slice(0, 3)) shownIds.push(c.id);
    }
    if (shownIds.length > 0) {
      const ids = shownIds.map(id => `"${id}"`).join(',');
      await sb(`self_improvement_candidates?id=in.(${ids})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ surfaced_in_brief_at: new Date().toISOString() }),
      });
    }
  }

  // 5) Compose message
  const summary = renderPlainEnglishSummary(runs, completedTasks, blocked, stuck, selfImprovementCandidates, heathActions);

  // 5a) Persist the numbered → UUID surface mapping so the Telegram webhook
  //     can parse Heath's "approve 1" / "defer 3" reply. shownIds is already
  //     in the order the renderer uses (conversation_review, capability_scan,
  //     rule_audit — top 3 each).
  if (shownIds.length > 0 && TELEGRAM_CHAT_ID) {
    const grouped2 = groupCandidatesByCategory(selfImprovementCandidates);
    await sb('improvement_digest_surfaces', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        chat_id: String(TELEGRAM_CHAT_ID),
        candidate_ids: shownIds,
        metadata: {
          category_counts: {
            conversation_review: Math.min(3, grouped2.conversation_review.length),
            capability_scan:     Math.min(3, grouped2.capability_scan.length),
            rule_audit:          Math.min(3, grouped2.rule_audit.length),
          },
        },
      }),
    });
  }

  // 6) Send
  const tgRes = await tg(summary);

  // Optional email version (plain HTML — same content, slightly formatted)
  const emailHtml = summary
    .replace(/<b>/g, '<strong>').replace(/<\/b>/g, '</strong>')
    .replace(/<i>/g, '<em>').replace(/<\/i>/g, '</em>')
    .replace(/\n/g, '<br>\n');
  const emailRes = await email('Morning brief — autonomous loop', emailHtml);

  const grouped = groupCandidatesByCategory(selfImprovementCandidates);
  return res.status(200).json({
    ok: true,
    runs_seen: runs.length,
    shipped_count: completedTasks.length,
    blocked_count: blocked.length,
    stuck_count: stuck.length,
    heath_actions_pending: heathActions.length,
    heath_actions_red_count: heathActions.filter(a => {
      const h = a.created_at ? Math.floor((Date.now() - new Date(a.created_at).getTime()) / 3600000) : 0;
      return h >= 24 * 7;
    }).length,
    heath_actions_yellow_count: heathActions.filter(a => {
      const h = a.created_at ? Math.floor((Date.now() - new Date(a.created_at).getTime()) / 3600000) : 0;
      return h >= 72 && h < 24 * 7;
    }).length,
    self_improvement_candidates_pulled: selfImprovementCandidates.length,
    self_improvement_candidates_shown: shownIds.length,
    self_improvement_by_category: {
      conversation_review: Math.min(3, grouped.conversation_review.length),
      capability_scan:     Math.min(3, grouped.capability_scan.length),
      rule_audit:          Math.min(3, grouped.rule_audit.length),
    },
    telegram_ok: tgRes.ok,
    email_ok: emailRes.ok,
  });
});
