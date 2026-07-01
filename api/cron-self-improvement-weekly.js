'use strict';

// api/cron-self-improvement-weekly.js
// =============================================================================
// SV-ENG-RIDGE-SELF-IMPROVEMENT-WEEKLY-001 (Ridge, 2026-07-01)
//
// Tier 2 of the self-improvement meta-loop. Fires Sundays 6 AM CST (11:00 UTC).
//
// What it does:
//   1. Scan candidate capability sources for anything new in the last 7 days:
//        - Zapier enabled_actions catalog (are there apps recent tasks would
//          have benefited from?)
//        - `agent_queue` blocked rows + result_summary text that contains
//          "would be easier with", "if we had access to", "wish we could"
//        - Recent Cole punts recorded by tier-1 (theme=access_punt) — direct
//          capability gaps
//   2. Cross-reference gaps -> propose one of:
//        - enable_zapier_action  (auto-enableable, low friction)
//        - build_custom_integration (needs code — draft the spec)
//   3. Insert candidates into self_improvement_candidates (tier='weekly')
//   4. Log run to self_improvement_runs
//
// DOES NOT auto-enable Zapier actions. Every proposal needs Heath's yes/no
// in the Sunday brief.
//
// SCHEDULE: "0 11 * * 0"  (6 AM CDT Sunday = 11 UTC)
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

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

// ─── Signal gathering ────────────────────────────────────────────────────────

async function gatherAccessPuntSignals(since) {
  // Tier-1 already noted access punts. Weekly rolls up which apps/services
  // Cole most often lacked capability for.
  const q = 'self_improvement_signals?select=id,verbatim_quote,notes,metadata,theme'
         + `&theme=in.(access_punt,asked_heath_to_check,permission_ask)`
         + `&detected_at=gte.${encodeURIComponent(since)}&limit=200`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function gatherWishlistLanguageSignals(since) {
  // Scan agent_queue result_summary for capability wishes verbatim.
  const q = 'agent_queue?select=id,agent_name,task_subject,result_summary'
         + `&completed_at=gte.${encodeURIComponent(since)}`
         + `&result_summary=ilike.*would be easier*&limit=100`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function gatherBlockedTaskSignals(since) {
  const q = 'agent_queue?select=id,agent_name,task_subject,result_summary,metadata'
         + `&status=eq.blocked&created_at=gte.${encodeURIComponent(since)}&limit=50`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

// ─── Candidate drafter ───────────────────────────────────────────────────────
// Cluster raw signals by capability theme and draft one candidate per cluster.

function clusterByCapability(accessPunts, wishlistRows, blockedRows) {
  // Very simple keyword bucketing — the human review will refine.
  const buckets = new Map();

  function add(bucketKey, evidence) {
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, { count: 0, evidence: [] });
    const b = buckets.get(bucketKey);
    b.count += 1;
    if (b.evidence.length < 5) b.evidence.push(evidence);
  }

  const CAPABILITY_KEYWORDS = [
    { key: 'gmail_send',       re: /\bsend (an? )?email\b|\bgmail\b/i },
    { key: 'calendar_book',    re: /\b(schedule|book|calendar|meeting invite)\b/i },
    { key: 'stripe_action',    re: /\bstripe\b|\bsubscription\b|\bcheckout\b/i },
    { key: 'facebook_group',   re: /\bfb group\b|\bfacebook group\b/i },
    { key: 'linkedin',         re: /\blinkedin\b/i },
    { key: 'x_twitter',        re: /\btwitter\b|\bpost.*(x|X)\b/i },
    { key: 'phone_call',       re: /\b(call|voice call|ring)\b/i },
    { key: 'sms_send',         re: /\b(sms|text message)\b/i },
    { key: 'docusign',         re: /\bdocusign\b|\bdocuseal\b/i },
    { key: 'zoom_recording',   re: /\bzoom recording\b|\btranscript\b/i },
    { key: 'drive_upload',     re: /\bgoogle drive\b/i },
    { key: 'canva_design',     re: /\bcanva\b/i },
  ];

  const all = [
    ...accessPunts.map(r => ({ text: `${r.verbatim_quote || ''} ${r.notes || ''}`, source: 'signal', id: r.id })),
    ...wishlistRows.map(r => ({ text: `${r.task_subject || ''} ${r.result_summary || ''}`, source: 'wishlist', id: r.id })),
    ...blockedRows.map(r => ({ text: `${r.task_subject || ''} ${r.result_summary || ''}`, source: 'blocked', id: r.id })),
  ];

  for (const item of all) {
    for (const { key, re } of CAPABILITY_KEYWORDS) {
      if (re.test(item.text)) {
        add(key, item);
        break;
      }
    }
  }

  return buckets;
}

function draftCapabilityCandidates(buckets) {
  const candidates = [];

  const ZAPIER_MAP = {
    gmail_send:     { app: 'Gmail',              action: 'send_email' },
    calendar_book:  { app: 'Google Calendar',    action: 'create_event' },
    stripe_action:  { app: 'Stripe',             action: 'create_customer_or_charge' },
    docusign:       { app: 'DocuSign',           action: 'send_envelope' },
    drive_upload:   { app: 'Google Drive',       action: 'upload_file' },
    canva_design:   { app: 'Canva',              action: 'export_design' },
  };

  for (const [key, { count, evidence }] of buckets) {
    if (count < 2) continue; // one-off ask is not enough for a capability build

    const impact = Math.min(10, 3 + count);
    const supporting = evidence[0]?.text?.slice(0, 240) || null;

    if (ZAPIER_MAP[key]) {
      const { app, action } = ZAPIER_MAP[key];
      candidates.push({
        change_kind: 'enable_zapier_action',
        title: `Enable Zapier action: ${app} / ${action} (${count} gap${count>1?'s':''} this week)`,
        rationale: `${count} agent tasks in the last 7 days either punted or wished for ${app} capability. Zapier already integrates ${app} — enabling the ${action} action is a low-friction unlock.`,
        proposed_change: `Call mcp__claude_ai_Zapier__discover_zapier_actions for ${app}, then enable_zapier_action for the "${action}" step. Add a memory pointer at reference_capabilities.md so agents know it exists.`,
        target_path: 'Zapier catalog + reference_capabilities.md',
        supporting_quote: supporting,
        signal_count: count,
        impact_score: impact,
      });
    } else {
      // Non-Zapier capability — needs custom build
      candidates.push({
        change_kind: 'build_custom_integration',
        title: `Capability gap: ${key.replace(/_/g,' ')} (${count} event${count>1?'s':''} this week)`,
        rationale: `${count} tasks in the last 7 days hit a "${key}" capability gap. No off-the-shelf Zapier action fits — needs a custom integration or MCP wrapper.`,
        proposed_change: `Scope a build for "${key}". Options: (a) native API integration, (b) Playwright script if UI-only, (c) MCP server if it should be tool-accessible to all agents. Cost + effort estimate required before Heath approves.`,
        target_path: 'scripts/ OR api/_lib/',
        supporting_quote: supporting,
        signal_count: count,
        impact_score: impact,
      });
    }
  }

  candidates.sort((a, b) => b.impact_score - a.impact_score);
  return candidates;
}

// ─── Main handler ────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-self-improvement-weekly', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const startedAt = Date.now();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

  let signalsScanned = 0;
  let signalsRecorded = 0;
  let candidatesDrafted = 0;
  let outcome = 'ok';
  let outcomeReason = null;

  try {
    const [accessPunts, wishlist, blocked] = await Promise.all([
      gatherAccessPuntSignals(since),
      gatherWishlistLanguageSignals(since),
      gatherBlockedTaskSignals(since),
    ]);

    signalsScanned = accessPunts.length + wishlist.length + blocked.length;

    if (signalsScanned === 0) {
      outcome = 'no_data';
      outcomeReason = 'no_capability_gaps_this_week';
    } else {
      const buckets = clusterByCapability(accessPunts, wishlist, blocked);
      const candidates = draftCapabilityCandidates(buckets);

      // Persist meta-signal rows (one per bucket >= 2) so tier-3 can see them
      const metaSignalRows = [];
      for (const [key, { count }] of buckets) {
        if (count < 2) continue;
        metaSignalRows.push({
          tier: 'weekly',
          signal_kind: 'tool_gap',
          theme: `capability_${key}`,
          severity: Math.min(5, 2 + Math.floor(count / 2)),
          notes: `${count} tasks needed "${key}" this week`,
          metadata: { capability: key, count },
        });
      }
      if (metaSignalRows.length > 0) {
        const sRes = await sb('self_improvement_signals?select=id', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(metaSignalRows),
        });
        if (sRes.ok) signalsRecorded = metaSignalRows.length;
      }

      if (candidates.length > 0) {
        const rows = candidates.map(c => ({
          tier: 'weekly',
          change_kind: c.change_kind,
          title: c.title,
          rationale: c.rationale,
          proposed_change: c.proposed_change,
          target_path: c.target_path,
          supporting_quote: c.supporting_quote,
          signal_ids: [],
          signal_count: c.signal_count,
          impact_score: c.impact_score,
        }));
        const cRes = await sb('self_improvement_candidates?select=id', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify(rows),
        });
        if (cRes.ok) {
          candidatesDrafted = rows.length;
        } else {
          outcome = 'error';
          outcomeReason = `candidate_insert_failed:${cRes.status}`;
        }
      }
    }
  } catch (err) {
    outcome = 'error';
    outcomeReason = (err && err.message) ? err.message.slice(0, 400) : 'crash';
  }

  await sb('self_improvement_runs?select=id', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      tier: 'weekly',
      signals_scanned: signalsScanned,
      signals_recorded: signalsRecorded,
      candidates_drafted: candidatesDrafted,
      outcome,
      outcome_reason: outcomeReason,
      duration_ms: Date.now() - startedAt,
    }),
  });

  return res.status(200).json({
    ok: outcome !== 'error',
    tier: 'weekly',
    signals_scanned: signalsScanned,
    signals_recorded: signalsRecorded,
    candidates_drafted: candidatesDrafted,
    outcome,
    outcome_reason: outcomeReason,
  });
});
