// Vercel Serverless Function: /api/cron-email-digest
//
// Daily 8am CT (13:00 UTC) Resend digest. For each active paying customer
// (non-demo, non-heath, non-cancelled) with at least ONE pending email draft
// in email_queue (status != 'sent'), send a single branded HTML email titled
// "Dossie - you have N drafts waiting". The email lists every draft with
// dossier context, recipient, status, age, and a per-draft CTA.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 13 * * *" (13:00 UTC = 8:00 AM CDT during DST).
//
// Idempotent within reason: we never write back to email_queue. The cron is
// safe to retry — agents would just receive the digest again. Re-runs within
// the same day are not gated (intentional simplicity for v1; if a customer
// complains we add a daily-fire log table).
//
// Customer filter mirrors cron-morning-brief.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';
const BRAND_BORDER = '#E8E0D8';

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.startsWith('heath.shepard@')) return true;
  if (e.includes('demo')) return true;
  return false;
}

function ageLabel(createdAt) {
  if (!createdAt) return 'recently';
  const created = new Date(createdAt);
  if (isNaN(created.getTime())) return 'recently';
  const diffMs = Date.now() - created.getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return 'less than an hour';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

async function sendResend(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

// Same customer roster loader as cron-deadline-reminders / cron-morning-brief.
async function loadActiveCustomers() {
  const subResp = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=user_id,plan,status');
  if (!subResp.ok) throw new Error(`subscriptions fetch ${subResp.status}`);
  const subs = subResp.data || [];
  if (subs.length === 0) return [];

  const userIds = subs.map((s) => s.user_id).filter(Boolean);
  if (userIds.length === 0) return [];

  const filter = userIds.map((id) => `"${id}"`).join(',');
  const profResp = await supabaseFetch(
    `/rest/v1/profiles?id=in.(${filter})&select=id,email,full_name,is_demo`,
  );
  if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);
  const profilesById = new Map((profResp.data || []).map((p) => [p.id, p]));

  const out = [];
  for (const s of subs) {
    const p = profilesById.get(s.user_id);
    if (!p) continue;
    if (p.is_demo) continue;
    if (isExcludedEmail(p.email)) continue;
    out.push({
      user_id: s.user_id,
      email: p.email,
      first_name: (p.full_name || p.email || '').split(/[\s.@]/)[0] || 'there',
    });
  }
  return out;
}

// All pending drafts for a single user, joined with the transaction's
// property_address so we can show context in the digest. transaction_id is
// a text column on email_queue but a uuid on transactions — both serialize
// to the same string, so the join works.
async function loadPendingDrafts(userId) {
  const r = await supabaseFetch(
    `/rest/v1/email_queue?user_id=eq.${encodeURIComponent(userId)}&status=neq.sent&select=id,transaction_id,to_email,to_name,subject,status,created_at&order=created_at.asc`,
  );
  if (!r.ok) return [];
  const drafts = r.data || [];
  if (drafts.length === 0) return [];

  // Hydrate property addresses for each unique transaction_id.
  const txIds = Array.from(new Set(drafts.map((d) => d.transaction_id).filter(Boolean)));
  const addrByTxId = new Map();
  if (txIds.length > 0) {
    const filter = txIds.map((id) => `"${id}"`).join(',');
    const txResp = await supabaseFetch(
      `/rest/v1/transactions?id=in.(${filter})&select=id,property_address`,
    );
    if (txResp.ok) {
      for (const t of (txResp.data || [])) addrByTxId.set(String(t.id), t.property_address);
    }
  }

  return drafts.map((d) => ({
    ...d,
    property_address: addrByTxId.get(String(d.transaction_id)) || 'Dossier',
  }));
}

function draftRowHtml(d) {
  const recipient = d.to_name
    ? `${d.to_name} (${d.to_email || 'no email'})`
    : (d.to_email || 'recipient pending');
  const subj = d.subject || 'Untitled draft';
  const status = d.status || 'draft';
  const age = ageLabel(d.created_at);

  return `<div style="border: 1px solid ${BRAND_BORDER}; border-radius: 12px; padding: 18px 20px; margin: 0 0 14px; background: white;">
    <div style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; color: ${BRAND_NAVY}; font-weight: 600; margin-bottom: 6px;">${d.property_address}</div>
    <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 15px; color: ${BRAND_NAVY}; margin-bottom: 4px;"><strong>${subj}</strong></div>
    <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 13px; color: ${BRAND_TEXT_SOFT}; margin-bottom: 4px;">To: ${recipient}</div>
    <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; color: ${BRAND_MUTED}; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px;">${status} &middot; queued ${age}</div>
    <a href="https://meetdossie.com/app#emails" style="display: inline-block; padding: 10px 20px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 13px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Review and send -&gt;</a>
  </div>`;
}

function buildDigestHtml({ firstName, drafts }) {
  const name = (firstName || '').trim() || 'there';
  const count = drafts.length;
  const rows = drafts.map(draftRowHtml).join('');

  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
    <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE &middot; DAILY DIGEST</div>
    <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; line-height: 1.2; margin: 0 0 18px; color: ${BRAND_NAVY};">Good morning, ${name}.</h1>
    <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 24px;">You have <strong style="color: ${BRAND_NAVY};">${count} draft${count === 1 ? '' : 's'}</strong> sitting in your Emails queue. Each one is ready to review and send.</p>
    ${rows}
    <div style="margin: 32px 0 12px;">
      <a href="https://meetdossie.com/app" style="display: inline-block; padding: 14px 30px; background: ${BRAND_NAVY}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">View all in Dossie -&gt;</a>
    </div>
    <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: ${BRAND_NAVY}; line-height: 1.4; margin: 28px 0 4px;">- Dossie</p>
    <p style="margin-top: 28px; font-size: 12px; color: ${BRAND_MUTED}; line-height: 1.6;">You get this digest whenever you have at least one draft waiting. Send or dismiss your drafts in Dossie to clear the queue.</p>
  </div>`;
}

module.exports = async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }
    if (!RESEND_API_KEY) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'RESEND_API_KEY not set' });
    }

    const customers = await loadActiveCustomers();
    const summary = {
      ok: true,
      customers_scanned: customers.length,
      digests_sent: 0,
      customers_with_no_drafts: 0,
      errors: [],
    };

    for (const cust of customers) {
      const drafts = await loadPendingDrafts(cust.user_id);
      if (drafts.length === 0) {
        summary.customers_with_no_drafts++;
        continue;
      }

      const subject = `Dossie - you have ${drafts.length} draft${drafts.length === 1 ? '' : 's'} waiting`;
      const html = buildDigestHtml({ firstName: cust.first_name, drafts });

      const send = await sendResend(cust.email, subject, html);
      if (!send.ok) {
        console.error('[cron-email-digest] resend failed', cust.email, send.status, (send.raw || '').slice(0, 200));
        summary.errors.push({
          user_id: cust.user_id,
          email: cust.email,
          status: send.status,
          error: (send.raw || '').slice(0, 200),
        });
        continue;
      }
      summary.digests_sent++;
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[cron-email-digest] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
