// /api/cron-deletion-reminders
// DOD-V-9: at day 75 after a member is removed, send "Your data will be deleted in 15 days" email.
// Idempotent via organization_members.deletion_reminder_sent_at.
// Auth: requires Bearer ${CRON_SECRET} per CLAUDE.md sec 15.

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = 'Dossie <heath@meetdossie.com>';
const CRON_SECRET = process.env.CRON_SECRET;
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://meetdossie.com';

async function sendResendEmail({ to, subject, html }) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY not set');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`resend ${r.status}: ${txt}`);
  }
  return r.json().catch(() => ({}));
}

function buildReminderHtml({ orgName, agentEmail, vaultStatus, downloadUrl }) {
  return `
<!doctype html><html><body style="margin:0;padding:0;background:#fafaf7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1A1A2E;">
  <div style="max-width:560px;margin:40px auto;padding:32px;background:#fff;border:1px solid #f0e6e0;border-radius:12px;">
    <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:28px;line-height:1.2;margin-bottom:16px;color:#1A1A2E;">
      Your data will be deleted in 15 days
    </div>
    <p style="font-size:16px;line-height:1.6;color:#333;">
      Hi — you were removed from <strong>${escapeHtml(orgName)}</strong> on Dossie about 75 days ago, and per our retention policy your transaction records, documents, and dossier milestones will be permanently deleted in 15 days.
    </p>
    <p style="font-size:16px;line-height:1.6;color:#333;">
      ${vaultStatus === 'active'
        ? `Your team has an active Data Vault, so your records may continue to be retained by the team admin. If you want a personal copy, download below.`
        : `If you'd like to keep your records, download them now.`}
    </p>
    <div style="text-align:center;margin:32px 0;">
      <a href="${downloadUrl}" style="display:inline-block;padding:14px 32px;background:#E8836B;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;">
        Download my data
      </a>
    </div>
    <p style="font-size:13px;color:#999;text-align:center;margin-top:24px;">
      Questions? Just reply to this email.
    </p>
  </div>
</body></html>`.trim();
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = async function handler(req, res) {
  // Auth: Vercel cron sends CRON_SECRET via Authorization header
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Find members removed exactly between 75 and 76 days ago, with no reminder yet.
    // Window is 1 day wide so a daily cron catches every candidate exactly once.
    const cutoffStart = new Date(Date.now() - 76 * 24 * 60 * 60 * 1000).toISOString();
    const cutoffEnd = new Date(Date.now() - 75 * 24 * 60 * 60 * 1000).toISOString();

    const { data: candidates, error: queryErr } = await supabase
      .from('organization_members')
      .select(`
        id, org_id, user_id, removed_at,
        organizations:org_id ( id, name, archived_at )
      `)
      .gte('removed_at', cutoffStart)
      .lte('removed_at', cutoffEnd)
      .is('deletion_reminder_sent_at', null);

    if (queryErr) {
      console.error('[cron-deletion-reminders] query error:', queryErr.message);
      return res.status(500).json({ ok: false, error: queryErr.message });
    }

    let sent = 0;
    let skipped = 0;
    const errors = [];

    for (const c of candidates || []) {
      try {
        // Get user email + admin email + vault status
        const { data: userRow } = await supabase.auth.admin.getUserById(c.user_id);
        if (!userRow || !userRow.user || !userRow.user.email) {
          skipped++;
          errors.push({ member_id: c.id, reason: 'no agent email' });
          continue;
        }
        const agentEmail = userRow.user.email;
        const orgName = (c.organizations && c.organizations.name) || 'your team';

        const { data: vault } = await supabase
          .from('data_vault_subscriptions')
          .select('id')
          .eq('org_id', c.org_id)
          .is('canceled_at', null)
          .maybeSingle();
        const vaultStatus = vault ? 'active' : 'none';

        // Admin recipient(s): all current admins of the org
        const { data: admins } = await supabase
          .from('organization_members_with_roles')
          .select('user_id, roles')
          .eq('org_id', c.org_id);
        const adminUserIds = (admins || [])
          .filter((a) => (a.roles || []).includes('admin'))
          .map((a) => a.user_id);
        const adminEmails = [];
        for (const aid of adminUserIds) {
          const { data: au } = await supabase.auth.admin.getUserById(aid);
          if (au && au.user && au.user.email) adminEmails.push(au.user.email);
        }

        const downloadUrl = `${BASE_URL}/app#export`;
        const html = buildReminderHtml({ orgName, agentEmail, vaultStatus, downloadUrl });
        const recipients = [agentEmail, ...adminEmails];

        // Send a single email per recipient (simpler retry semantics than BCC)
        for (const to of recipients) {
          await sendResendEmail({
            to,
            subject: 'Your data will be deleted in 15 days',
            html,
          });
        }

        // Mark reminder sent + write audit row via RPC
        await supabase.rpc('record_deletion_reminder_sent', {
          p_member_id: c.id,
          p_acting_user_id: null,
          p_recipients: recipients,
        });

        sent++;
      } catch (e) {
        errors.push({ member_id: c.id, error: e.message });
      }
    }

    return res.status(200).json({
      ok: true,
      candidates: (candidates || []).length,
      sent,
      skipped,
      errors,
    });
  } catch (err) {
    console.error('[cron-deletion-reminders] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
