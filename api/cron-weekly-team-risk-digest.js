// Vercel Serverless Function: /api/cron-weekly-team-risk-digest
//
// Weekly email to each active Team/Brokerage org's founder (the team lead)
// with what's at risk across their whole team: missing disclosures, overdue
// action items (oldest first), and deadline drift — sourced straight from
// api/_lib/team-risk-rollup.js (the same aggregation org-risk-overview.js's
// UI and the chat assistant's team-lead answers already use, so this digest
// can never disagree with what the Team Dashboard shows).
//
// Lighter approval model — same one decided for the ShowingTime digest
// (dossie-agent-capability-spec.md §10, "Approval model — decided,
// 2026-08-22: approve the template once"): this is recurring, informational,
// non-legal, non-negotiation content, so it runs automatically every week
// with no fresh per-send approval. Do not extend this lighter tier to
// anything negotiation-bearing.
//
// Idempotency: organizations.last_risk_digest_sent_at (added by migration
// 20260823170500_org_risk_digest_tracking.sql) skips an org already emailed
// within the last 6 days, so a manual re-trigger or a Vercel cron retry the
// same week doesn't double-send. Coded defensively: if that column isn't
// live yet in a given environment (migration not applied), the SELECT and
// UPDATE both fall back to "no idempotency tracking" rather than hard-
// failing the whole run — the digest itself still sends either way.
//
// Auth: Bearer ${CRON_SECRET}
// Manual re-send bypassing the 6-day guard: add ?force=1 (still requires the
// same CRON_SECRET bearer — the approved pattern per CLAUDE.md Section 15).
// Schedule: 0 13 * * 1  (Monday 8AM CST / 13:00 UTC — same slot as the other
// Monday weekly crons in this repo).

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { getServiceClient } = require('./_lib/team-auth.js');
const { buildTeamRiskRollup } = require('./_lib/team-risk-rollup.js');

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const IDEMPOTENCY_WINDOW_DAYS = 6;

function formatDate(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildDigestText(org, rollup) {
  const lines = [];
  lines.push(`Weekly risk digest — ${org.name}`);
  lines.push('');

  if (rollup.missing_disclosures.length === 0 && rollup.overdue_action_items.length === 0 && rollup.deadline_flags.length === 0) {
    lines.push('Nothing at risk this week — every active file has its disclosures and nothing is overdue.');
  } else {
    if (rollup.missing_disclosures.length > 0) {
      lines.push(`MISSING DISCLOSURES (${rollup.missing_disclosures.length}):`);
      rollup.missing_disclosures.forEach((m) => {
        lines.push(`  - ${m.property_address || 'Untitled dossier'} (${m.agent_name || m.agent_email || 'unassigned'}): ${m.missing_doc_types.join(', ')}`);
      });
      lines.push('');
    }
    if (rollup.overdue_action_items.length > 0) {
      lines.push(`OVERDUE ACTION ITEMS, oldest first (${rollup.overdue_action_items.length}):`);
      rollup.overdue_action_items.forEach((a) => {
        lines.push(`  - ${a.description} — ${a.property_address || 'Untitled dossier'} (${a.agent_name || a.agent_email || 'unassigned'}), ${a.days_overdue} day${a.days_overdue === 1 ? '' : 's'} overdue (due ${formatDate(a.due_date)})`);
      });
      lines.push('');
    }
    if (rollup.deadline_flags.length > 0) {
      lines.push(`DEADLINE DRIFT (${rollup.deadline_flags.length}):`);
      rollup.deadline_flags.forEach((d) => {
        lines.push(`  - ${d.property_address || 'Untitled dossier'} (${d.agent_name || d.agent_email || 'unassigned'}): ${d.flags.join(', ')}`);
      });
      lines.push('');
    }
  }

  lines.push(`Team: ${rollup.agents.length} member${rollup.agents.length === 1 ? '' : 's'}.`);
  lines.push('');
  lines.push('Full detail: https://meetdossie.com/app (Team tab)');
  return lines.join('\n');
}

function buildDigestHtml(org, rollup) {
  const section = (title, rows) => {
    if (rows.length === 0) return '';
    return `<h3 style="margin:18px 0 8px;font-size:14px;color:#1A1A2E;">${escapeHtml(title)} (${rows.length})</h3>
<ul style="margin:0 0 8px;padding-left:18px;font-size:13.5px;color:#2E2A27;line-height:1.6;">
${rows.join('\n')}
</ul>`;
  };

  const missingRows = rollup.missing_disclosures.map((m) => `<li>${escapeHtml(m.property_address || 'Untitled dossier')} (${escapeHtml(m.agent_name || m.agent_email || 'unassigned')}): ${escapeHtml(m.missing_doc_types.join(', '))}</li>`);
  const overdueRows = rollup.overdue_action_items.map((a) => `<li>${escapeHtml(a.description)} — ${escapeHtml(a.property_address || 'Untitled dossier')} (${escapeHtml(a.agent_name || a.agent_email || 'unassigned')}), <strong>${a.days_overdue} day${a.days_overdue === 1 ? '' : 's'} overdue</strong> (due ${formatDate(a.due_date)})</li>`);
  const flagRows = rollup.deadline_flags.map((d) => `<li>${escapeHtml(d.property_address || 'Untitled dossier')} (${escapeHtml(d.agent_name || d.agent_email || 'unassigned')}): ${escapeHtml(d.flags.join(', '))}</li>`);

  const nothingAtRisk = missingRows.length === 0 && overdueRows.length === 0 && flagRows.length === 0;

  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #2E2A27;">
  <div style="font-size:11px;letter-spacing:2px;color:#A48531;text-transform:uppercase;font-weight:700;margin-bottom:10px;">DOSSIE — WEEKLY TEAM RISK DIGEST</div>
  <h2 style="font-family: Georgia, serif; font-size: 22px; margin: 0 0 4px; color: #1A1A2E;">${escapeHtml(org.name)}</h2>
  <p style="font-size:12.5px;color:#7E776F;margin:0 0 16px;">Week of ${formatDate(rollup.generated_at)}</p>
  ${nothingAtRisk
    ? '<p style="font-size:14px;color:#4a6c43;">Nothing at risk this week — every active file has its disclosures and nothing is overdue.</p>'
    : section('Missing disclosures', missingRows) + section('Overdue action items, oldest first', overdueRows) + section('Deadline drift', flagRows)}
  <p style="font-size:12.5px;color:#7E776F;margin-top:18px;">Team: ${rollup.agents.length} member${rollup.agents.length === 1 ? '' : 's'}.</p>
  <p style="margin-top:20px;"><a href="https://meetdossie.com/app" style="color:#E8836B;font-size:13px;">Open the Team Dashboard &rarr;</a></p>
</div>`;
}

async function sendDigestEmail({ to, org, rollup }) {
  if (!RESEND_API_KEY) {
    return { sent: false, reason: 'RESEND_API_KEY not configured' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Dossie <dossie@meetdossie.com>',
      to: [to],
      bcc: ['heath@meetdossie.com'],
      subject: `Weekly team risk digest — ${org.name}`,
      text: buildDigestText(org, rollup),
      html: buildDigestHtml(org, rollup),
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    return { sent: false, reason: `Resend ${res.status}: ${text.slice(0, 300)}` };
  }
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* ignore */ }
  return { sent: true, resend_id: (data && data.id) || null };
}

// Resolve the org's founder's email — profiles first (fast path, already
// used by team-risk-rollup.js's own emailMap for agents), falling back to
// the Supabase auth admin API the same way team-risk-rollup.js does.
async function getFounderEmail(supabase, founderUserId) {
  if (!founderUserId) return null;
  const { data: profile } = await supabase
    .from('profiles')
    .select('email, full_name')
    .eq('id', founderUserId)
    .maybeSingle();
  if (profile && profile.email) return { email: profile.email, name: profile.full_name || null };

  const { data: userData } = await supabase.auth.admin.getUserById(founderUserId);
  if (userData && userData.user && userData.user.email) {
    return { email: userData.user.email, name: null };
  }
  return null;
}

async function handler(req, res) {
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  const supabase = getServiceClient();

  const result = { orgs_checked: 0, sent: 0, skipped_recent: 0, skipped_no_recipient: 0, errors: [] };

  try {
    // Prefer selecting last_risk_digest_sent_at for idempotency; fall back
    // to a plain select if the column isn't live in this environment yet
    // (migration 20260823170500 not applied) — see file header.
    let orgs = null;
    let hasDigestColumn = true;
    {
      const { data, error } = await supabase
        .from('organizations')
        .select('id, name, tier, created_by_user_id, last_risk_digest_sent_at')
        .in('tier', ['team', 'brokerage'])
        .is('archived_at', null);
      if (error && /last_risk_digest_sent_at/i.test(error.message || '')) {
        hasDigestColumn = false;
        const fallback = await supabase
          .from('organizations')
          .select('id, name, tier, created_by_user_id')
          .in('tier', ['team', 'brokerage'])
          .is('archived_at', null);
        if (fallback.error) throw fallback.error;
        orgs = fallback.data || [];
      } else if (error) {
        throw error;
      } else {
        orgs = data || [];
      }
    }

    if (!hasDigestColumn) {
      console.warn('[cron-weekly-team-risk-digest] organizations.last_risk_digest_sent_at not present in this DB — idempotency tracking disabled, sending unconditionally this run.');
    }

    const cutoff = Date.now() - IDEMPOTENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    for (const org of orgs) {
      result.orgs_checked++;

      if (!force && hasDigestColumn && org.last_risk_digest_sent_at) {
        const lastSent = new Date(org.last_risk_digest_sent_at).getTime();
        if (!Number.isNaN(lastSent) && lastSent > cutoff) {
          result.skipped_recent++;
          continue;
        }
      }

      try {
        const recipient = await getFounderEmail(supabase, org.created_by_user_id);
        if (!recipient || !recipient.email) {
          result.skipped_no_recipient++;
          console.warn('[cron-weekly-team-risk-digest] no recipient email for org', org.id, org.name);
          continue;
        }

        const rollup = await buildTeamRiskRollup(supabase, org.id);
        if (!rollup.ok) {
          result.errors.push({ org_id: org.id, error: rollup.error });
          continue;
        }

        const sendResult = await sendDigestEmail({ to: recipient.email, org, rollup });
        if (!sendResult.sent) {
          result.errors.push({ org_id: org.id, error: sendResult.reason });
          continue;
        }

        result.sent++;

        if (hasDigestColumn) {
          const { error: updateErr } = await supabase
            .from('organizations')
            .update({ last_risk_digest_sent_at: new Date().toISOString() })
            .eq('id', org.id);
          if (updateErr) {
            console.warn('[cron-weekly-team-risk-digest] last_risk_digest_sent_at update failed for org', org.id, updateErr.message);
          }
        }
      } catch (err) {
        result.errors.push({ org_id: org.id, error: err && err.message });
        console.error('[cron-weekly-team-risk-digest] failed for org', org.id, err && err.message);
      }
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[cron-weekly-team-risk-digest] fatal:', err && err.message);
    return res.status(500).json({ ok: false, error: err && err.message, ...result });
  }
}

module.exports = withTelemetry('cron-weekly-team-risk-digest', handler);
