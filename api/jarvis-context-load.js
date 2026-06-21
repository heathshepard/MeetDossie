// Vercel Serverless Function: /api/jarvis-context-load
// Aggregates Heath's full context so Jarvis on the PWA knows what Cole knows.
//
// Heath's full context is too big to live in /repo (211 memory .md files,
// session handoffs, DoDs) AND it's not safe to expose those raw files to
// Vercel — they live on Heath's home PC. This endpoint instead aggregates
// a leaner, server-safe version of that context:
//
//   1. heath_todo (open items) — live from Supabase
//   2. jarvis_agent_events latest — live from Supabase
//   3. Subscription/MRR snapshot — live from Supabase
//   4. Customer roster — live from Supabase profiles
//   5. Recent jarvis_conversations titles + handful of last messages
//   6. A STATIC "memory backbone" — paramount rules + identities, hardcoded
//      from MEMORY.md (see below). Re-hydrated when MEMORY.md changes; for
//      now it's the locked set of paramount + identity entries.
//
// POST /api/jarvis-context-load
//   Body: optional { conversation_id?: string, fresh?: boolean }
//   <- 200 { ok:true, context: { ... }, system_prompt_extension: string,
//           token_estimate: number, generated_at: iso }
//
// Auth: REQUIRED. Bearer Supabase JWT. Tenant resolved via jarvis_users.
// Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
// Owner: Atlas (SV-JARVIS-PWA-002)

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const config = {
  api: { bodyParser: true },
  maxDuration: 15,
};

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

// In-memory cache (per Vercel warm instance). 60s TTL for all DB-derived
// blocks. Static memory backbone is process-lifetime cached.
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function cachedSbGet(path) {
  const key = `sb:${path}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && (now - hit.at) < CACHE_TTL_MS) return hit.data;
  const data = await sbGet(path);
  cache.set(key, { at: now, data });
  return data;
}

// ===== STATIC MEMORY BACKBONE =====
// This is the condensed, locked set of paramount rules + identities that
// Jarvis needs every conversation. Sourced from MEMORY.md headings on
// 2026-06-21. Token budget: ~3.5k tokens.
//
// When MEMORY.md changes materially, update this constant + re-deploy.
// Future: turn this into a Supabase row 'jarvis_memory_backbone' so it
// can be edited without code change.
const MEMORY_BACKBONE = `
=== JARVIS MEMORY BACKBONE ===

== Identity ==
- Your name is Jarvis (renamed from Cole on 2026-06-17 by Heath).
- You are Heath Shepard's personal AI chief of staff.
- Address Heath as "sir" most of the time but vary naturally — sometimes by name, sometimes just answer.
- You replaced 'Cole' as the orchestrator/EA persona. Cole's old context is yours.
- You speak in clean prose suitable for TTS — no markdown, no bullets, no symbols, no emoji.

== Heath ==
- Heath Shepard, founder of Shepard Ventures (venture studio) in San Antonio, Texas.
- 100% SC disabled veteran (qualifies for SDVOSB cert, TX franchise tax exemption, VA grants).
- TX REALTOR at KW City View / KW Boerne. Emails: heath.shepard@kw.com (KW work), heath@meetdossie.com (Dossie).
- Goal: location-independent (Hawaii long-term). Also runs Plane & Ember (cigar woodwork).
- Direct, voice-transcription user — interpret prompts charitably. Speed beats perfection. Low hedge tolerance.
- Decision-fatigue mode: when Heath signals overwhelm ("you decide", "I'm tired"), make the call yourself and execute. Only escalate spend, customer contact, legal sign-off, or merge approval.

== Paramount behavioral rules ==
- BREVITY: default reply is 1-2 sentences. No bullets, no preamble. Expand only when Heath asks for depth.
- NO APOLOGY THEATER: when something breaks, name what broke + the process fix + how it prevents recurrence. Never "you're right / my fault".
- NO FABRICATED SPECIFICS: never invent numbers, names, dates, customer counts. If unknown, say so plainly.
- HONEST about your own limits when relevant but don't open every reply with a disclaimer.
- VERBAL APPROVAL gate for state-changing actions (send_*, purchases, bookings). Confirm with Heath verbally before firing.
- Telegram = decision pings + verifications + mission-complete + urgent incidents only. NEVER spawn/commit/QC iteration noise.
- Founder outreach tone = warm, friendly, never confrontational. Founder = direct line to builder.
- Customer emails: minimize the problem, never amplify. Never name 3rd-party platforms (Vercel/Resend/Supabase) as cause. Calm-friend tone.
- Subscriber emails: only sent Tue-Thu 8:30am CST. Never evenings/Mon/Fri.

== Permanent agent roster ==
You can spawn these specialists in the background:
- Atlas (Head of Platform Engineering) — infra, dashboards, observability, voice integrations, agent orchestration, ships Carter-drafted code. Carter drafts; Atlas ships.
- Carter (Head of Product Engineering) — DRAFTS feature code, has NO push privileges as of 2026-06-18.
- Hadley (General Counsel) — legal, compliance, DoD drafting, TREC field schemas.
- Pierce (Growth + Customer Success) — activation funnel, drip emails, founder reactivation, marketing automation.
- Sage (Head of Social Media) — platform strategy, posting schedules, reel production, algorithm optimization.
- Quinn (QA) — full test suite after every Carter draft, loops with Carter up to 3x.
- Ridge (Reliability) — failure modes, retry/timeout/fallback, observability, cost ceilings.
- Sterling (Markets + Portfolio Strategy) — stock/crypto research, catalyst tracking, risk-managed orders.

== Dossie product context ==
- Tagline: Your deals. Her job. Audience: Texas REALTORS (SA launch -> statewide).
- Two-door: (A) agents replacing a TC ($400/file -> $29-49/mo), (B) TCs scaling solo (3x files).
- Architecture: vertical-agnostic AI core + Texas-TREC config layer. Acquisition story: 3-10x ARR from Zillow/Lone Wolf/CoStar.
- Dossie is always "she/her". Warm, capable, never corporate.
- Pricing (LOCKED): Solo $79/mo or $39/yr. Team $199/mo or $119/yr (3 seats; max 8 at $35/seat). Brokerage custom. Founding Member $29/mo (50 spots).
- Stack: React (Vite) on Vercel, Supabase (project pgwoitbdiyubjugwufhk), Resend, Stripe, Zernio social, HCTI cards, ElevenLabs voice, Creatomate video, Submagic captions, fal.ai b-roll.
- Two repos: Dossie (build), MeetDossie (deploy). Staging -> main flow. NEVER push direct to main.

== Live URLs ==
- App: meetdossie.com/app
- Workspace: meetdossie.com/workspace
- Founding: meetdossie.com/founding
- Agents landing: meetdossie.com/agents
- Coordinators landing: meetdossie.com/coordinators
- Calculator: meetdossie.com/calculator
- Jarvis PWA: meetdossie.com/myjarvis

== Key customer context (as of last sync) ==
- Brittney Ybarbo — Dossie's most engaged founding customer; treat as VIP.
- Customer bug reports preempt other work; verify staging by eye + email customer back with thanks.

== Workflow rules ==
- Staging first, main second. Always.
- Tag stable milestones: GOLD-YYYY-MM-DD-vN-desc.
- Pre-push grep: \`git grep '<<<<<<<' -- '*.html' '*.js' '*.jsx' '*.json'\` must return zero.
- Never commit secrets — Vercel env only. GitGuardian monitors the public repo.
- NEVER \`vercel env pull\` or \`vercel link\` (banned 2026-06-17 after 60+ secrets destroyed).
- Atlas APV is the merge gate. Carter's "done" is not actionable until Atlas signs in to staging + executes the flow + captures success.

== Important paths ==
- Memory: \`~/.claude/projects/C--Users-Heath-Shepard-Desktop-MeetDossie/memory/\` (211 files, ~660KB total).
- MeetDossie repo: \`Desktop/MeetDossie\` (deploy).
- Dossie repo: \`Desktop/Dossie\` (build).
- Shepard Ventures Engineering filing cabinet: \`Desktop/Shepard-Ventures/Engineering/\`.
- Session diary: \`Desktop/MeetDossie/SESSION-DIARY.md\`.

== Heath's pending personal items (high level — read heath_todo for live state) ==
- Dossie LLC formation (Northwest paid 2026-05-22; EIN obtained 42-2807262; TX state filing pending; bank + insurance TBD).
- Chamonix family trip June 29 - July 2 (Les Praz/Argentière, AdM 7am, Lac d'Annecy boat, Tramway du Mont-Blanc).

=== END BACKBONE ===
`.trim();

// Latest session handoffs — read from disk at deploy time is not possible
// (Vercel functions don't have access to the home PC). Instead, we embed a
// compact summary that the build process (or Atlas) re-renders into this
// file when handoffs change. For now it's manually-curated.
const LATEST_HANDOFF_SUMMARY = `
=== LATEST SESSION HANDOFF ===
2026-06-21 — Jarvis PWA Session 1 SHIPPED to staging.
- Foundation: schema + voice loop + Iron Man HUD shell.
- 38 of 97 DoD criteria PASS. Multi-tenant proven (demo tenant onboarded by row-insert only).
- Voice round-trip 1.85s for chat leg. ElevenLabs George voice locked.
- Files: api/jarvis-voice.js, jarvis-pwa.html, jarvis-pwa-manifest.json, jarvis-pwa-sw.js, supabase/migrations/20260621_jarvis_pwa_init.sql.
- Session 2 IN FLIGHT: context federation (this endpoint) + tool surface (web_search, send_telegram, spawn_agent, query_supabase, read_dossie_dashboards, set_reminder, read_calendar, web_browse).
- Parallel: latency Atlas adding chat_tts_stream op for sub-1s perceived response.

=== END HANDOFF ===
`.trim();

// Tightly-formatted active DoD summaries.
const ACTIVE_DODS = `
=== ACTIVE DOD: Jarvis PWA v1 (2026-06-21) ===
Owner: Atlas + Carter + Hadley. 97 acceptance criteria across Schema, Auth, Voice, PTT, UI, Tools, Sync, Persona, Multi-tenant, Storage, Performance.
Section F tool belt: web_search, web_browse, send_telegram, send_sms, send_email, send_slack, read_calendar, set_reminder, read_contacts, read_recent_emails, read_recent_texts, morning_brief, spawn_agent.
All state-changing tools require verbal approval gate. Texas one-party consent for voice records (Heath only — no third-party voice in v1).
Audio buffer transient by default; only saved on explicit "save this" command. Auto-delete 24h.

=== END ACTIVE DOD ===
`.trim();

async function loadLiveContext(tenant, jarvisUser) {
  // Fire all DB reads in parallel.
  const [
    todoRows,
    agentEvents,
    subRows,
    recentConvs,
  ] = await Promise.all([
    cachedSbGet('heath_todo?select=id,title,detail,action_type,priority,deadline,status,venture&status=in.(pending,snoozed)&order=priority.desc.nullslast&limit=15').catch(() => []),
    cachedSbGet(`jarvis_agent_events?select=agent_name,event_type,summary,created_at&tenant_id=eq.${tenant.id}&order=created_at.desc&limit=15`).catch(() => []),
    cachedSbGet('subscriptions?select=id,status,price_id&status=eq.active').catch(() => []),
    sbGet(`jarvis_conversations?select=id,title,started_at,ended_at&tenant_id=${tenant.id ? `eq.${tenant.id}` : ''}&order=started_at.desc&limit=5`).catch(() => []),
  ]);

  // MRR math: Stripe founding price = $29; assume all active = founding for now.
  // Future: pull price_amount from Stripe and sum.
  const mrr = subRows.length * 29;

  // Latest agent status per agent name (most recent wins)
  const latestPerAgent = {};
  for (const ev of agentEvents) {
    if (!latestPerAgent[ev.agent_name]) latestPerAgent[ev.agent_name] = ev;
  }

  return {
    customer_count: subRows.length,
    mrr_estimated: mrr,
    todo: todoRows.map((t) => ({
      id: t.id,
      title: t.title,
      detail: (t.detail || '').slice(0, 200),
      action_type: t.action_type,
      priority: t.priority,
      deadline: t.deadline,
      status: t.status,
      venture: t.venture,
    })),
    agent_status: Object.entries(latestPerAgent).map(([agent, ev]) => ({
      agent,
      latest_event: ev.event_type,
      summary: (ev.summary || '').slice(0, 120),
      at: ev.created_at,
    })),
    recent_conversations: (recentConvs || []).map((c) => ({
      id: c.id,
      title: c.title || '(untitled)',
      started_at: c.started_at,
      ended_at: c.ended_at,
    })),
  };
}

function formatLiveBlock(live) {
  const lines = ['=== LIVE STATE (refreshed at conversation start) ==='];

  lines.push(`Customers: ${live.customer_count} active subscriptions, ~$${live.mrr_estimated}/mo MRR (estimate).`);

  if (live.todo && live.todo.length) {
    lines.push('');
    lines.push('Heath\'s open todo items (top 15):');
    for (const t of live.todo) {
      const p = t.priority != null ? `[P${t.priority}]` : '';
      const d = t.deadline ? ` due ${t.deadline}` : '';
      const v = t.venture ? ` (${t.venture})` : '';
      lines.push(`  - ${p} ${t.title}${d}${v}`);
    }
  } else {
    lines.push('Heath\'s todo list is empty or no open items.');
  }

  if (live.agent_status && live.agent_status.length) {
    lines.push('');
    lines.push('Agent latest status:');
    for (const a of live.agent_status) {
      lines.push(`  - ${a.agent}: ${a.latest_event} — ${a.summary}`);
    }
  }

  if (live.recent_conversations && live.recent_conversations.length) {
    lines.push('');
    lines.push('Recent conversations with you:');
    for (const c of live.recent_conversations) {
      lines.push(`  - "${c.title}" (${c.started_at})`);
    }
  }

  lines.push('=== END LIVE STATE ===');
  return lines.join('\n');
}

function estimateTokens(str) {
  // Rough heuristic: 1 token ~= 4 chars.
  return Math.ceil(str.length / 4);
}

async function resolveTenant(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=id,tenant_id,role,tenants(id,slug,display_name,theme,voice_id,voice_settings,addressing_pref)&auth_user_id=eq.${authUserId}&limit=1`
  );
  if (!rows || rows.length === 0) return null;
  return { jarvisUser: rows[0], tenant: rows[0].tenants };
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const requestId = `ctx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    if (err.status === 401) {
      return res.status(401).json({ ok: false, error: 'Not signed in' });
    }
    console.error(`[jarvis-context-load] [${requestId}] auth error: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Auth failure' });
  }

  let context;
  try {
    context = await resolveTenant(authUser.userId);
  } catch (err) {
    console.error(`[jarvis-context-load] [${requestId}] tenant resolve: ${err.message}`);
    return res.status(500).json({ ok: false, error: 'Tenant lookup failed' });
  }
  if (!context || !context.tenant) {
    return res.status(403).json({ ok: false, error: 'No Jarvis tenant for this user' });
  }

  try {
    const live = await loadLiveContext(context.tenant, context.jarvisUser);
    const liveBlock = formatLiveBlock(live);

    // Heath-only: backbone is full. Other tenants get a minimal scaffold.
    const isHeath = context.tenant.slug === 'heath';
    const backbone = isHeath ? MEMORY_BACKBONE : `=== JARVIS MEMORY BACKBONE ===\n${context.tenant.display_name} is the owner. Address as "${context.tenant.addressing_pref}". Be helpful and concise.\n=== END BACKBONE ===`;
    const handoff = isHeath ? LATEST_HANDOFF_SUMMARY : '';
    const dods = isHeath ? ACTIVE_DODS : '';

    const blocks = [backbone, handoff, dods, liveBlock].filter(Boolean);
    const systemPromptExtension = blocks.join('\n\n');

    const tokenEstimate = estimateTokens(systemPromptExtension);

    console.log(`[jarvis-context-load] [${requestId}] tenant=${context.tenant.slug} todo=${live.todo.length} agents=${live.agent_status.length} mrr=${live.mrr_estimated} tokens~=${tokenEstimate}`);

    return res.status(200).json({
      ok: true,
      tenant: { slug: context.tenant.slug, addressing_pref: context.tenant.addressing_pref },
      context: live,
      system_prompt_extension: systemPromptExtension,
      token_estimate: tokenEstimate,
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[jarvis-context-load] [${requestId}] error: ${err.message}\n${err.stack}`);
    return res.status(500).json({ ok: false, error: 'Context load failed', requestId });
  }
}
