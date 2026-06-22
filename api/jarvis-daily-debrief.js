// Vercel Serverless Function: /api/jarvis-daily-debrief
// Glanceable summary of today's activity for the Jarvis HUD.
//
// Computes live (no caching of stale rows) — pulls today's counts from the
// real source tables rather than the daily_debriefs table (which is the
// async cron output and may lag).
//
// Returns:
//   {
//     ok, generated_at,
//     headline: "8 actions completed today, 2 awaiting your eye",
//     closed_deals: { count, names: [...] },
//     new_signups: { count, names: [...] },
//     customer_activity: { forms_filled, dossiers_created, documents_uploaded },
//     agent_completions: { count, by_agent: { atlas: 3, ... } },
//     outbound: { emails_sent, telegrams_sent, social_posts_published },
//     pending_count: 2,
//   }
//
// Heath-only. GET. Refresh 60s from the PWA.
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

async function sbCount(path) {
  // Use HEAD + Prefer: count=exact for cheap counts.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'HEAD',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const range = res.headers.get('content-range') || '0/0';
  const total = parseInt(range.split('/')[1] || '0', 10);
  return isNaN(total) ? 0 : total;
}

function startOfTodayIsoUTC() {
  // Use 24h-ago window. Heath is CST so "today" rolls at midnight CST, but
  // for an at-a-glance HUD a rolling 24h window is more useful than a strict
  // calendar day (and avoids TZ math complexity).
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  return d.toISOString();
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

  const since = startOfTodayIsoUTC();

  try {
    const [
      closedDeals,
      newProfiles,
      newSubs,
      newDocuments,
      newTransactions,
      newDossierMilestones,
      agentEvents,
      agentActivity,
      socialsPosted,
      emailsSent,
      foundingsToday,
      pendingSocials,
      pendingEmails,
      pendingFoundings,
      sageResearchDraftsToday,
    ] = await Promise.all([
      sbGet(`transactions?select=id,property_address,buyer_name,seller_name,closed_at&closed_at=gte.${since}&order=closed_at.desc&limit=20`).catch(() => []),
      sbGet(`profiles?select=id,full_name,email,created_at&created_at=gte.${since}&order=created_at.desc&limit=20`).catch(() => []),
      sbGet(`subscriptions?select=id,user_id,plan,created_at&created_at=gte.${since}&order=created_at.desc&limit=20`).catch(() => []),
      sbCount(`documents?created_at=gte.${since}`),
      sbCount(`transactions?created_at=gte.${since}`),
      sbCount(`dossier_milestones?created_at=gte.${since}`),
      sbGet(`jarvis_agent_events?select=agent_name,event_type,summary,created_at&created_at=gte.${since}&event_type=eq.completed&order=created_at.desc&limit=100`).catch(() => []),
      sbGet(`agent_activity?select=agent_name,task_summary,status,completed_at,created_at&created_at=gte.${since}&order=created_at.desc&limit=100`).catch(() => []),
      sbCount(`social_posts?posted_at=gte.${since}&status=eq.posted`),
      sbCount(`email_queue?sent_at=gte.${since}&status=eq.sent`),
      sbCount(`founding_applications?created_at=gte.${since}`),
      sbCount(`social_posts?status=in.(draft,pending_approval)`),
      sbCount(`email_queue?status=in.(pending,draft)`),
      sbCount(`founding_applications?status=eq.pending`),
      sbCount(`social_posts?status=eq.pending_approval&source_type=eq.sage_research&created_at=gte.${since}`),
    ]);

    // Roll up agent completions by name from BOTH event sources.
    const byAgent = {};
    let agentCompletions = 0;
    for (const ev of agentEvents) {
      const k = (ev.agent_name || 'unknown').toLowerCase();
      byAgent[k] = (byAgent[k] || 0) + 1;
      agentCompletions++;
    }
    for (const ev of agentActivity) {
      if (ev.status === 'completed' || ev.completed_at) {
        const k = (ev.agent_name || 'unknown').toLowerCase();
        byAgent[k] = (byAgent[k] || 0) + 1;
        agentCompletions++;
      }
    }

    const closedDealNames = closedDeals.map((d) => d.property_address || d.buyer_name || d.seller_name || `Deal ${String(d.id).slice(0, 6)}`).filter(Boolean);
    const newSignupNames = [
      ...newProfiles.map((p) => p.full_name || p.email),
      ...newSubs.map((s) => `Sub ${s.plan || ''} ${String(s.id).slice(0, 6)}`),
    ].filter(Boolean);

    const pendingCount = pendingSocials + pendingEmails + pendingFoundings;
    const totalCompleted = agentCompletions + (socialsPosted || 0) + (emailsSent || 0);

    const headline = `${totalCompleted} action${totalCompleted === 1 ? '' : 's'} completed in last 24h${pendingCount ? `, ${pendingCount} awaiting your eye` : ''}`;

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      window: '24h',
      headline,
      closed_deals: { count: closedDeals.length, names: closedDealNames.slice(0, 8) },
      new_signups: { count: newProfiles.length + newSubs.length, names: newSignupNames.slice(0, 8) },
      customer_activity: {
        forms_filled: newDocuments,
        dossiers_created: newTransactions,
        documents_uploaded: newDocuments,
        milestones_shared: newDossierMilestones,
      },
      agent_completions: { count: agentCompletions, by_agent: byAgent },
      outbound: {
        emails_sent: emailsSent || 0,
        social_posts_published: socialsPosted || 0,
      },
      inbound: {
        founding_applications: foundingsToday,
      },
      sage_research: {
        drafts_today: sageResearchDraftsToday || 0,
      },
      pending_count: pendingCount,
    });
  } catch (err) {
    console.error('jarvis-daily-debrief error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err?.message || err) });
  }
}
