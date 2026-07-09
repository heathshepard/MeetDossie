// Vercel Serverless Function: /api/cron-trec-member-alerts
//
// Fans out newly-detected TREC updates to affected members.
// Reads trec_updates WHERE member_notified = false, joins to profiles +
// transactions to find who should hear about the change, writes:
//   - trec_update_notifications row per (user, update, channel)
//   - outbound_email_queue row for each customer email
// Then sets member_notified=true on the trec_updates row.
//
// SV-TREC-SCANNER-002 (Atlas, 2026-07-08).
//
// Schedule: 30 8 * * * (3:30am CT — 30 min after scanner) via vercel.json.
//
// Auth: Vercel cron header OR Authorization: Bearer $CRON_SECRET.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CRON_SECRET
//
// Legal disclaimer (Hadley-owned, wrapped inline):
//   Every alert email carries the disclaimer that Dossie relays public TREC
//   content and does not provide legal advice. Agents should confirm details
//   at the TREC source URL and consult their broker for form-specific
//   guidance. Full text below in DISCLAIMER_HTML.

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FROM_EMAIL = 'Dossie <heath@meetdossie.com>';
const REPLY_TO = 'heath@meetdossie.com';

// Cap per run so a bad batch of many updates can't email-flood.
const MAX_UPDATES_PER_RUN = 10;
const MAX_RECIPIENTS_PER_UPDATE = 50;

// Hadley-approved disclaimer — plain English, no legal advice claim.
const DISCLAIMER_HTML = `
<hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0 16px 0" />
<p style="font-size:12px;color:#6B7280;line-height:1.5;margin:0">
Dossie relays publicly available Texas Real Estate Commission (TREC) content
so you can react quickly to rule and form changes. This alert is not legal
advice. Always confirm details at the linked TREC source and consult your
broker or attorney before changing how you handle a live contract.
</p>
<p style="font-size:12px;color:#9CA3AF;line-height:1.5;margin:8px 0 0 0">
You are receiving this because you are a Dossie founding member with an
active transaction that may be affected. Reply STOP to opt out of TREC
Watch alerts.
</p>
`;

const DISCLAIMER_TEXT = `\n\n---\nDossie relays publicly available Texas Real Estate Commission (TREC) content so you can react quickly to rule and form changes. This alert is not legal advice. Always confirm details at the linked TREC source and consult your broker or attorney before changing how you handle a live contract.\n\nYou are receiving this because you are a Dossie founding member with an active transaction that may be affected. Reply STOP to opt out of TREC Watch alerts.`;

function isAuthed(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

async function pgGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`pgGet ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function pgPost(path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`pgPost ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function pgPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`pgPatch ${path}: ${r.status} ${await r.text()}`);
}

// Find members who should hear about an update.
//
// Strategy:
//   - If affects_forms is empty → notify all active founding members (rule change,
//     rule of thumb: all resale-contract agents care about generic TREC news).
//   - If affects_forms includes a common resale form (20-18, 20-17, 40-11, 49-1,
//     47-0) → notify agents with an active transaction (status != 'closed', 'cancelled').
//   - Cap MAX_RECIPIENTS_PER_UPDATE per update.
//
// Excludes: is_demo=true profiles (never bug the demo account).
async function findAffectedMembers(update) {
  const affects = update.affects_forms || [];
  const isBroadResaleChange = affects.some((f) => ['20-18', '20-17', '40-11', '49-1', '47-0', ''].includes(f)) || affects.length === 0;

  if (isBroadResaleChange) {
    // Notify anyone with an active transaction (not closed/cancelled).
    const activeAgents = await pgGet(
      `transactions?select=user_id&status=not.in.(closed,cancelled,archived)&limit=1000`
    );
    const userIds = Array.from(new Set(activeAgents.map((t) => t.user_id).filter(Boolean)));
    if (userIds.length === 0) return [];
    // Pull profiles for those user_ids, filtering out demo accounts.
    const inList = userIds.map((u) => `"${u}"`).join(',');
    const profiles = await pgGet(
      `profiles?select=id,email,full_name,preferred_name,is_demo&id=in.(${inList})&is_demo=is.false&limit=${MAX_RECIPIENTS_PER_UPDATE}`
    );
    return profiles.filter((p) => p.email);
  }

  // Non-broad change → only notify agents whose active transaction implies the
  // form applies. We don't have transactions.forms_used yet, so use transaction_type
  // as a proxy. Conservative: notify all active-transaction owners.
  return findAffectedMembers({ ...update, affects_forms: [] });
}

function renderEmail(update, member) {
  const firstName = (member.preferred_name || member.full_name || '').split(' ')[0] || 'there';
  const severityLabel =
    update.severity === 'critical'
      ? 'Critical'
      : update.severity === 'action_required'
      ? 'Action recommended'
      : 'Heads-up';
  const effectiveLine = update.effective_date
    ? `<p style="margin:0 0 12px 0;color:#111827"><strong>Effective:</strong> ${update.effective_date}</p>`
    : '';
  const formsLine =
    update.affects_forms && update.affects_forms.length > 0
      ? `<p style="margin:0 0 12px 0;color:#111827"><strong>Affects TREC form${update.affects_forms.length > 1 ? 's' : ''}:</strong> ${update.affects_forms.join(', ')}</p>`
      : '';
  const subject = `[TREC Watch] ${update.title}`;

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <div style="background:${update.severity === 'critical' ? '#FEE2E2' : update.severity === 'action_required' ? '#FEF3C7' : '#F5E6E0'};border-radius:8px;padding:16px 20px;margin-bottom:20px">
    <div style="font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:#6B7280;margin-bottom:4px">TREC Watch · ${severityLabel}</div>
    <div style="font-size:20px;font-weight:600;color:#111827">${update.title}</div>
  </div>
  <p style="margin:0 0 16px 0">Hi ${firstName},</p>
  <p style="margin:0 0 16px 0">Dossie's nightly TREC scan flagged a change you may want to know about:</p>
  ${effectiveLine}
  ${formsLine}
  <div style="background:#F9FAFB;border-left:3px solid #C9A96E;padding:12px 16px;margin:16px 0;line-height:1.6;color:#111827">${escapeHtml(update.summary)}</div>
  <p style="margin:16px 0"><a href="${update.source_url}" style="color:#C9A96E;font-weight:600">Read the TREC source page →</a></p>
  <p style="margin:24px 0 0 0;color:#6B7280;font-size:14px">— Dossie</p>
  ${DISCLAIMER_HTML}
</body></html>`;

  const text = `[TREC Watch — ${severityLabel}] ${update.title}\n\nHi ${firstName},\n\nDossie's nightly TREC scan flagged a change you may want to know about:\n\n${update.effective_date ? `Effective: ${update.effective_date}\n` : ''}${update.affects_forms && update.affects_forms.length ? `Affects TREC form(s): ${update.affects_forms.join(', ')}\n` : ''}\n${update.summary}\n\nRead the TREC source: ${update.source_url}\n\n— Dossie${DISCLAIMER_TEXT}`;

  return { subject, html, text };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function queueEmail(member, subject, html, text, updateId) {
  await pgPost(
    'outbound_email_queue',
    {
      to_email: member.email,
      from_email: FROM_EMAIL,
      subject,
      body_html: html,
      body_text: text,
      reply_to: REPLY_TO,
      status: 'pending',
      metadata: {
        source: 'trec_watch',
        trec_update_id: updateId,
        user_id: member.id,
      },
    },
    'return=minimal'
  );
}

async function recordNotification(updateId, userId, channel) {
  try {
    await pgPost(
      'trec_update_notifications',
      {
        trec_update_id: updateId,
        user_id: userId,
        channel,
      },
      'return=minimal'
    );
    return true;
  } catch (e) {
    // Unique constraint (already notified) — treat as OK
    if (/duplicate key|23505/.test(e.message)) return false;
    throw e;
  }
}

async function purgeOldSynthetic() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await pgPatch(
    `trec_updates?synthetic=is.true&scanned_at=lt.${cutoff}&member_notified=is.true`,
    { /* no-op patch → we use DELETE below instead */ }
  ).catch(() => {});
  // Actually delete (Supabase DELETE via REST)
  await fetch(
    `${SUPABASE_URL}/rest/v1/trec_updates?synthetic=is.true&scanned_at=lt.${cutoff}`,
    {
      method: 'DELETE',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  ).catch(() => {});
}

async function handler(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  await purgeOldSynthetic();

  const pending = await pgGet(
    `trec_updates?member_notified=is.false&order=scanned_at.asc&limit=${MAX_UPDATES_PER_RUN}&select=id,source_url,source_type,title,summary,effective_date,affects_forms,severity,synthetic`
  );

  const summary = { updates_processed: 0, emails_queued: 0, in_app_written: 0, errors: [] };

  for (const update of pending) {
    try {
      const members = await findAffectedMembers(update);
      let emailsQueued = 0;
      let inAppWritten = 0;

      for (const m of members) {
        const wroteInApp = await recordNotification(update.id, m.id, 'in_app');
        if (wroteInApp) inAppWritten += 1;

        const wroteEmail = await recordNotification(update.id, m.id, 'email');
        if (wroteEmail) {
          const { subject, html, text } = renderEmail(update, m);
          await queueEmail(m, subject, html, text, update.id);
          emailsQueued += 1;
        }
      }

      await pgPatch(`trec_updates?id=eq.${update.id}`, {
        member_notified: true,
        notified_at: new Date().toISOString(),
      });

      summary.updates_processed += 1;
      summary.emails_queued += emailsQueued;
      summary.in_app_written += inAppWritten;
    } catch (e) {
      console.error('[trec-alerts] update failed', update.id, e);
      summary.errors.push({ id: update.id, error: e.message });
    }
  }

  return res.status(200).json({
    ok: true,
    ...summary,
    at: new Date().toISOString(),
  });
}

module.exports = withTelemetry('cron-trec-member-alerts', handler);
