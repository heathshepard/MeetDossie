// Vercel Serverless Function: /api/jarvis-customer-activity
// Last 20 customer-facing events, normalized + chronologically merged.
//
// Sources (in parallel, then sorted by ts desc):
//   - profiles.last_seen_at recent (signed in)
//   - documents.created_at recent (uploaded a PDF / form)
//   - transactions.created_at recent (new dossier)
//   - dossier_milestones.created_at recent (closing card shared)
//   - founding_applications.created_at recent (new app submitted)
//   - subscriptions.created_at recent (paid + provisioned)
//
// Joins profile.full_name where available; falls back to email -> id.
// PWA polls every ~20s (no Supabase Realtime subscription on serverless;
// realtime is wired separately client-side via the supabase JS client).
//
// Heath-only.
// Owner: Atlas (Jarvis PWA Tier 1)

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = {
  api: { bodyParser: true },
  maxDuration: 10,
};

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

function firstName(p) {
  if (!p) return null;
  if (p.full_name) return String(p.full_name).split(/\s+/)[0];
  if (p.email) return String(p.email).split('@')[0];
  return null;
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: 'unauthorized' });
  }
  if (authUser.email !== 'heath.shepard@kw.com' && authUser.email !== 'heath@meetdossie.com') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  const limitParam = Math.min(50, Math.max(5, parseInt(req.query?.limit || '20', 10) || 20));

  try {
    // Pull last 7 days of each kind. Exclude is_demo profiles.
    const sevenDays = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const [profiles, signins, documents, transactions, milestones, foundings, subs] = await Promise.all([
      // Real customers only (not demo). Used to map user_id -> name.
      sbGet(`profiles?select=id,full_name,email,is_demo&is_demo=eq.false&limit=500`).catch(() => []),
      sbGet(`profiles?select=id,full_name,email,last_seen_at&is_demo=eq.false&last_seen_at=gte.${sevenDays}&order=last_seen_at.desc&limit=20`).catch(() => []),
      sbGet(`documents?select=id,user_id,file_name,file_type,form_type,created_at&created_at=gte.${sevenDays}&order=created_at.desc&limit=30`).catch(() => []),
      sbGet(`transactions?select=id,user_id,property_address,buyer_name,seller_name,created_at&created_at=gte.${sevenDays}&order=created_at.desc&limit=20`).catch(() => []),
      sbGet(`dossier_milestones?select=id,user_id,milestone_type,city_state,created_at&created_at=gte.${sevenDays}&order=created_at.desc&limit=20`).catch(() => []),
      sbGet(`founding_applications?select=id,name,email,brokerage,created_at&created_at=gte.${sevenDays}&order=created_at.desc&limit=20`).catch(() => []),
      sbGet(`subscriptions?select=id,user_id,plan,status,created_at&created_at=gte.${sevenDays}&order=created_at.desc&limit=20`).catch(() => []),
    ]);

    const profileById = new Map(profiles.map((p) => [p.id, p]));

    const events = [];

    for (const p of signins) {
      events.push({
        ts: p.last_seen_at,
        kind: 'signin',
        actor: firstName(p) || 'A customer',
        text: `${firstName(p) || 'A customer'} signed in`,
        meta: { user_id: p.id },
      });
    }

    for (const d of documents) {
      const p = profileById.get(d.user_id);
      const who = firstName(p) || 'A customer';
      const what = d.form_type ? `filled ${d.form_type}` : `uploaded ${d.file_name || 'a document'}`;
      events.push({
        ts: d.created_at,
        kind: 'document',
        actor: who,
        text: `${who} ${what}`,
        meta: { user_id: d.user_id, file_name: d.file_name, form_type: d.form_type },
      });
    }

    for (const t of transactions) {
      const p = profileById.get(t.user_id);
      const who = firstName(p) || 'A customer';
      const addr = t.property_address || 'a new dossier';
      events.push({
        ts: t.created_at,
        kind: 'transaction',
        actor: who,
        text: `${who} created a dossier — ${addr}`,
        meta: { user_id: t.user_id, address: addr },
      });
    }

    for (const m of milestones) {
      const p = profileById.get(m.user_id);
      const who = firstName(p) || 'A customer';
      const where = m.city_state ? ` (${m.city_state})` : '';
      events.push({
        ts: m.created_at,
        kind: 'milestone',
        actor: who,
        text: `${who} shared a ${m.milestone_type || 'closing'} card${where}`,
        meta: { user_id: m.user_id, milestone_type: m.milestone_type },
      });
    }

    for (const f of foundings) {
      events.push({
        ts: f.created_at,
        kind: 'founding_application',
        actor: f.name || f.email || 'New applicant',
        text: `New founding application from ${f.name || f.email}${f.brokerage ? ' · ' + f.brokerage : ''}`,
        meta: { email: f.email, brokerage: f.brokerage },
      });
    }

    for (const s of subs) {
      const p = profileById.get(s.user_id);
      const who = firstName(p) || 'A customer';
      events.push({
        ts: s.created_at,
        kind: 'subscription',
        actor: who,
        text: `${who} started a ${s.plan || 'founding'} subscription`,
        meta: { user_id: s.user_id, plan: s.plan, status: s.status },
      });
    }

    // Sort newest first, drop missing ts, slice to limit.
    events.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    const trimmed = events.filter((e) => e.ts).slice(0, limitParam);

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      count: trimmed.length,
      events: trimmed,
    });
  } catch (err) {
    console.error('jarvis-customer-activity error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err?.message || err) });
  }
}
