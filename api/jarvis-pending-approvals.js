// Vercel Serverless Function: /api/jarvis-pending-approvals
// Returns the cross-system list of items awaiting Heath's yes/no.
//
// Sources (all queried in parallel):
//   1. social_posts where status IN ('draft','pending_approval') and requires_approval IS NOT FALSE
//   2. email_queue where status IN ('pending','draft')
//   3. outbound_email_queue where status IN ('pending')  (Cole-facing transactional queue)
//   4. founding_applications where status='pending'
//   5. decision_queue where status='open' (generic Heath-decision bucket)
//   6. hadley_unanswered_questions where answered_at IS NULL  (Hadley wants Heath's review on legal Qs)
//   7. heath_actions where status IN ('pending','snoozed' [due])  (generic Heath-action queue —
//      Atlas/Carter ship items, manual tasks, anything queued for Heath's yes/no by name)
//
// Heath-only (email gate via the standard middleware).
// GET only. Auto-refresh from the PWA every 30s.
//
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
    const body = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

function minutesAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 60000));
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
  // Heath-only — Pending Approvals is a Heath HUD, not a customer surface.
  if (authUser.email !== 'heath.shepard@kw.com' && authUser.email !== 'heath@meetdossie.com') {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }

  try {
    const heathActionsFilter = `tenant_id=eq.${authUser.userId}&status=in.(pending,snoozed)`;
    const [socials, emails, outboundEmails, foundings, decisions, hadleyQs, heathActions] = await Promise.all([
      sbGet(`social_posts?select=id,platform,hook,content,persona,topic,created_at,status,source_type,verifier_result&status=in.(draft,pending_approval)&order=created_at.asc&limit=25`).catch(() => []),
      sbGet(`email_queue?select=id,to_email,to_name,subject,template_type,created_at,status&status=in.(pending,draft)&order=created_at.asc&limit=25`).catch(() => []),
      sbGet(`outbound_email_queue?select=id,to_email,subject,created_at,status&status=in.(pending)&order=created_at.asc&limit=25`).catch(() => []),
      sbGet(`founding_applications?select=id,name,email,brokerage,market,transactions_12mo,why,created_at,status&status=eq.pending&order=created_at.asc&limit=25`).catch(() => []),
      sbGet(`decision_queue?select=id,decision_type,title,description,required_by,created_at,status&status=eq.open&order=created_at.asc&limit=25`).catch(() => []),
      sbGet(`hadley_unanswered_questions?select=id,question_text,form_context,asked_at,answered_at&answered_at=is.null&order=asked_at.asc&limit=25`).catch(() => []),
      sbGet(`heath_actions?select=id,title,body,source,priority,created_at,snoozed_until,status,deadline&${heathActionsFilter}&order=created_at.asc&limit=50`).catch(() => []),
    ]);

    // Filter heath_actions: pending now, plus snoozed actions whose snoozed_until has passed.
    const now = new Date();
    const visibleHeathActions = (heathActions || []).filter((a) => {
      if (a.status === 'pending') return true;
      if (a.status === 'snoozed' && a.snoozed_until) {
        return new Date(a.snoozed_until) <= now;
      }
      return false;
    });

    const items = [];

    for (const r of socials) {
      const isResearch = r.source_type === 'sage_research';
      const sourceFeed = isResearch && r.verifier_result?.summary
        ? String(r.verifier_result.summary).split(':')[0]
        : null;
      items.push({
        id: `social:${r.id}`,
        source: isResearch ? 'sage_research_draft' : 'social_post',
        source_id: r.id,
        title: r.hook || (r.content || '').slice(0, 80) || `${r.platform} post`,
        subtitle: isResearch
          ? `${(r.platform || '').toUpperCase()} · ${sourceFeed || 'Sage research'} · ${r.topic || ''}`
          : `${(r.platform || '').toUpperCase()} · ${r.persona || ''}${r.topic ? ' · ' + r.topic : ''}`,
        agent: 'Sage',
        waiting_minutes: minutesAgo(r.created_at),
        created_at: r.created_at,
        approve_endpoint: '/api/jarvis-approve',
        approve_payload: { kind: 'social_post', id: r.id },
        details: {
          full_content: r.content,
          platform: r.platform,
          persona: r.persona,
          topic: r.topic,
          source_type: r.source_type,
          source_link: r.verifier_result?.source_link || null,
          pillar: r.verifier_result?.pillar || null,
          feature_referenced: r.verifier_result?.feature_referenced || null,
        },
      });
    }

    for (const r of emails) {
      items.push({
        id: `email:${r.id}`,
        source: 'email_queue',
        source_id: r.id,
        title: r.subject || '(no subject)',
        subtitle: `To: ${r.to_name || r.to_email} · ${r.template_type || 'email'}`,
        agent: 'Pierce',
        waiting_minutes: minutesAgo(r.created_at),
        created_at: r.created_at,
        approve_endpoint: '/api/jarvis-approve',
        approve_payload: { kind: 'email_queue', id: r.id },
        details: { to_email: r.to_email, subject: r.subject, template_type: r.template_type },
      });
    }

    for (const r of outboundEmails) {
      items.push({
        id: `outbound:${r.id}`,
        source: 'outbound_email_queue',
        source_id: r.id,
        title: r.subject || '(no subject)',
        subtitle: `To: ${r.to_email}`,
        agent: 'Cole',
        waiting_minutes: minutesAgo(r.created_at),
        created_at: r.created_at,
        approve_endpoint: '/api/jarvis-approve',
        approve_payload: { kind: 'outbound_email', id: r.id },
        details: { to_email: r.to_email, subject: r.subject },
      });
    }

    for (const r of foundings) {
      items.push({
        id: `founding:${r.id}`,
        source: 'founding_application',
        source_id: r.id,
        title: `Founding application — ${r.name || r.email}`,
        subtitle: `${r.brokerage || 'no brokerage'} · ${r.market || ''} · ${r.transactions_12mo || 0} TX/12mo`,
        agent: 'Pierce',
        waiting_minutes: minutesAgo(r.created_at),
        created_at: r.created_at,
        approve_endpoint: '/api/jarvis-approve',
        approve_payload: { kind: 'founding_application', id: r.id },
        details: { name: r.name, email: r.email, brokerage: r.brokerage, market: r.market, why: r.why, transactions_12mo: r.transactions_12mo },
      });
    }

    for (const r of decisions) {
      items.push({
        id: `decision:${r.id}`,
        source: 'decision_queue',
        source_id: r.id,
        title: r.title || '(decision)',
        subtitle: `${r.decision_type || 'decision'}${r.required_by ? ' · due ' + r.required_by.slice(0, 10) : ''}`,
        agent: 'Jarvis',
        waiting_minutes: minutesAgo(r.created_at),
        created_at: r.created_at,
        approve_endpoint: '/api/jarvis-approve',
        approve_payload: { kind: 'decision', id: r.id },
        details: { description: r.description, required_by: r.required_by },
      });
    }

    for (const r of hadleyQs) {
      items.push({
        id: `hadleyq:${r.id}`,
        source: 'hadley_question',
        source_id: r.id,
        title: (r.question_text || '').slice(0, 100) || '(legal question)',
        subtitle: `Hadley needs answer · ${r.form_context || 'unscoped'}`,
        agent: 'Hadley',
        waiting_minutes: minutesAgo(r.asked_at),
        created_at: r.asked_at,
        approve_endpoint: '/api/jarvis-approve',
        approve_payload: { kind: 'hadley_question', id: r.id },
        details: { question: r.question_text, form_context: r.form_context },
      });
    }

    for (const r of visibleHeathActions) {
      const priority = (r.priority || 'soon').toLowerCase();
      items.push({
        id: `heath_action:${r.id}`,
        source: 'heath_action',
        source_id: r.id,
        title: r.title || '(untitled)',
        subtitle: `${(r.source || 'unknown').toUpperCase()} · ${priority.toUpperCase()}${r.deadline ? ' · due ' + r.deadline.slice(0,10) : ''}`,
        agent: r.source || 'Jarvis',
        waiting_minutes: minutesAgo(r.created_at),
        created_at: r.created_at,
        approve_endpoint: '/api/approve-heath-action',
        approve_payload: { action_id: r.id },
        details: { body: r.body, priority: r.priority, deadline: r.deadline, snoozed_until: r.snoozed_until },
      });
    }

    // Oldest first (longest waiting bubbles up).
    items.sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0));

    return res.status(200).json({
      ok: true,
      generated_at: new Date().toISOString(),
      count: items.length,
      breakdown: {
        social_posts: socials.length,
        email_queue: emails.length,
        outbound_email_queue: outboundEmails.length,
        founding_applications: foundings.length,
        decision_queue: decisions.length,
        hadley_questions: hadleyQs.length,
        heath_actions: visibleHeathActions.length,
      },
      items,
    });
  } catch (err) {
    console.error('jarvis-pending-approvals error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err?.message || err) });
  }
}
