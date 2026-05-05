// Vercel Serverless Function: /api/cron-deadline-reminders
// Daily cron. For every calculator_signups row with a deadline 3 days from
// now, send a Resend email with the deadline + a CTA to /founding. Tracks
// reminders_sent JSONB so we don't double-fire.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — once per day (e.g. "0 13 * * *" = 8am CT).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';

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

function dateOnly(iso) {
  // Pull YYYY-MM-DD from an ISO string (UTC). We compare against the
  // platform's clock — the calculator stores deadlines at 5pm local, but
  // for "3 days out" the time-of-day doesn't matter, only the date.
  const m = String(iso || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function addDaysISO(baseDate, n) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function deadlineCopy(deadline, daysOut) {
  const niceDate = (() => {
    const d = new Date(deadline.date);
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
  })();
  const subject = `${deadline.label} in ${daysOut} day${daysOut === 1 ? '' : 's'} — ${niceDate}`;
  const para = deadline.paragraph ? ` (${deadline.paragraph})` : '';
  const body = [
    `Hey,`,
    ``,
    `Heads up — your <strong>${deadline.label}</strong>${para} hits on <strong>${niceDate}</strong> at 5:00 PM local. That's ${daysOut} day${daysOut === 1 ? '' : 's'} from today.`,
    ``,
    `If you'd rather not track this manually for every deal, Dossie does it automatically — every dossier in your pipeline gets the same TREC engine, plus reminders, follow-up emails, document QA, and contract scanning.`,
    ``,
    `Founding membership is $29/month for life: <a href="https://meetdossie.com/founding">meetdossie.com/founding</a>`,
    ``,
    `— Heath Shepard, REALTOR®`,
    `Founder, Dossie`,
  ].join('<br>');
  return { subject, html: wrapHtml(body) };
}

function wrapHtml(inner) {
  return `<div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 32px 20px; color: #1C2B3A; line-height: 1.7;">${inner}<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #E8E0D8; font-size: 12px; color: #9CA8B4; line-height: 1.6;">You signed up for these reminders at <a href="https://meetdossie.com/calculator">meetdossie.com/calculator</a>. To stop, just reply with "stop".</div></div>`;
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

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  if (!RESEND_API_KEY) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'RESEND_API_KEY not set' });
  }

  const today = new Date();
  const targetISO = addDaysISO(today, 3); // deadlines exactly 3 days out
  // Pull all signups not unsubscribed. The fan-out shouldn't be huge — batch
  // up to 500 per run; if we ever exceed that we'll add pagination.
  const { data: rows, ok } = await supabaseFetch('/rest/v1/calculator_signups?unsubscribed_at=is.null&select=id,email,deadlines,reminders_sent&limit=500');
  if (!ok) return res.status(502).json({ ok: false, error: 'failed to load signups' });

  let sent = 0;
  let skipped = 0;
  const errors = [];

  for (const row of (rows || [])) {
    const sentMap = (row.reminders_sent && typeof row.reminders_sent === 'object') ? { ...row.reminders_sent } : {};
    const deadlinesArr = Array.isArray(row.deadlines) ? row.deadlines : [];
    let dirty = false;

    for (const d of deadlinesArr) {
      if (!d || !d.id || !d.date) continue;
      const dDate = dateOnly(d.date);
      if (dDate !== targetISO) continue;

      const sentKey = `${d.id}|3d`;
      if (sentMap[sentKey]) { skipped++; continue; }

      const daysOut = 3;
      const { subject, html } = deadlineCopy(d, daysOut);
      const result = await sendResend(row.email, subject, html);
      if (result.ok) {
        sentMap[sentKey] = new Date().toISOString();
        dirty = true;
        sent++;
      } else {
        console.error('[cron-deadline-reminders] resend failed', row.email, result.status, result.raw?.slice(0, 200));
        errors.push({ id: row.id, email: row.email, status: result.status, error: (result.raw || '').slice(0, 200) });
      }
    }

    if (dirty) {
      const patch = await supabaseFetch(`/rest/v1/calculator_signups?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ reminders_sent: sentMap }),
      });
      if (!patch.ok) errors.push({ id: row.id, error: 'patch reminders_sent failed', status: patch.status });
    }
  }

  return res.status(200).json({ ok: true, target_date: targetISO, sent, skipped, errors });
};
