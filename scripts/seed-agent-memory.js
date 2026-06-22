#!/usr/bin/env node
// scripts/seed-agent-memory.js
// ============================================================================
// One-shot seeder: backfills agent_role_memory with ~30 atomic lessons
// extracted from today's marathon (2026-06-19 -> 2026-06-22) memory files,
// CLAUDE.md rules, and the session-handoff notes.
//
// Run locally:
//   node scripts/seed-agent-memory.js
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY  (.env.local)
//   SEED_TENANT_SLUG (default 'heath')
//
// Idempotent: each lesson goes through the dedupe path. Reruns either bump
// usage_count or are silently no-ops.
//
// Owner: atlas_2, 2026-06-22.
// ============================================================================

const path = require('path');
const fs = require('fs');

// Load env from .env.local if present
try {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) {
        let v = m[2];
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
} catch (_) {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SEED_TENANT_SLUG = process.env.SEED_TENANT_SLUG || 'heath';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !OPENAI_API_KEY) {
  console.error('Missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / OPENAI_API_KEY');
  process.exit(1);
}

// ============================================================================
// The atomic lessons. Curated from CLAUDE.md + MEMORY.md + session handoffs +
// the marathon today. Atomic, useful, role-scoped.
// ============================================================================
const LESSONS = [
  // ====== ATLAS — infrastructure / dev ops / voice / observability ======
  {
    role: 'atlas',
    title: 'ElevenLabs 429 -> use scribe_v1 STT, not OpenAI Whisper',
    content: 'When ElevenLabs returns 429 on TTS/chat, its STT (scribe_v1) sub-quota usually still has headroom. Keep using /api/jarvis-voice?op=stt (ElevenLabs scribe_v1). Do NOT fall back to OpenAI Whisper unless ElevenLabs is fully exhausted — it adds latency and a paid API touch with no upside on quota errors.',
    category: 'api_gotcha',
    tags: ['elevenlabs', '429', 'stt', 'voice'],
  },
  {
    role: 'atlas',
    title: 'VAD silenceMs 600ms is the sweet spot post-streaming-TTS',
    content: 'After shipping the streaming chat+TTS pipeline, 800ms VAD silence felt sluggish on the Jarvis PWA. Heath asked for snappier turn-take. 600ms cuts the gap noticeably without false-fire on natural pauses. 1500ms is too long. Below 500ms produces premature cutoffs.',
    category: 'voice_ux',
    tags: ['vad', 'jarvis', 'voice', 'latency'],
  },
  {
    role: 'atlas',
    title: 'Conversation history MUST order DESC + LIMIT + reverse',
    content: 'When loading recent N messages from jarvis_messages, use order=created_at.desc + limit=N + slice().reverse() in JS. Loading ASC + LIMIT gives you the OLDEST N (every reply based on ancient context) instead of the most recent N. Heath called Jarvis a "conversational idiot" before this fix landed. See api/jarvis-voice.js handleChat() ~line 519.',
    category: 'code_pattern',
    tags: ['supabase', 'pagination', 'jarvis', 'history'],
  },
  {
    role: 'atlas',
    title: 'NEVER run vercel env pull or vercel link',
    content: 'Both commands overwrite/destroy .env.local. Heath lost 60+ secrets on 2026-06-17 when an agent ran `vercel env pull`. Permanently banned. Use the Vercel dashboard for env management, or ask Heath for the specific var. Add a guard in any new automation that touches Vercel CLI.',
    category: 'security',
    tags: ['vercel', 'secrets', 'banned-command'],
  },
  {
    role: 'atlas',
    title: 'Push-to-talk MUST release MediaStream tracks on conversation end',
    content: 'When stopping the Jarvis PWA push-to-talk, call stream.getTracks().forEach(t => t.stop()) AND null the MediaRecorder/AudioContext refs. Skipping this leaves the phone microphone LED on permanently (held by the page). Mobile Chrome especially never releases it on visibility change alone.',
    category: 'code_pattern',
    tags: ['mediastream', 'mic', 'jarvis-pwa', 'mobile'],
  },
  {
    role: 'atlas',
    title: 'Vite content-hashed bundle in-place edit MUST rename + update HTML',
    content: 'Editing a workspace-XXXX.js in place without renaming the file leaves the CDN serving the cached version forever (immutable headers). The deploy workflow is: build in ../Dossie -> cp dist/assets/workspace-*.js MeetDossie/assets/ -> update hash in BOTH app.html and workspace.html -> git rm the old bundle -> commit. All in one commit.',
    category: 'workflow',
    tags: ['vite', 'vercel', 'cdn', 'deploy'],
  },
  {
    role: 'atlas',
    title: 'Pre-push grep for merge conflict markers is mandatory',
    content: 'Before EVERY git push: run `git grep "<<<<<<<" -- "*.html" "*.js" "*.jsx" "*.json"`. Must return zero. Unresolved markers shipped to production at least three times across 2026-06. The grep takes 200ms; the prod-down incident takes hours.',
    category: 'workflow',
    tags: ['git', 'merge', 'pre-push-gate'],
  },
  {
    role: 'atlas',
    title: 'Mobile fixed overlay needs bottom:80+ AND z-index:110+',
    content: 'The Dossie mobileTabBar is fixed bottom:0, height:60, zIndex:100. Any fixed overlay or floating button that needs to be visible above it must use bottom:>=80 AND zIndex:>=110. Lower z-index or smaller bottom value = invisible on mobile, perfect on desktop emulation. Bit me twice.',
    category: 'code_pattern',
    tags: ['mobile', 'css', 'z-index', 'overlay'],
  },
  {
    role: 'atlas',
    title: 'Vercel CLI env adds are interactive — use the API instead',
    content: '`vercel env add` opens an interactive prompt that hangs headless agent runs. For server-to-server env updates, POST to https://api.vercel.com/v9/projects/{id}/env with the Vercel auth token. Same for `vercel env pull` — banned anyway, but the API would also be the right call.',
    category: 'external_service_quirk',
    tags: ['vercel', 'cli', 'env'],
  },
  {
    role: 'atlas',
    title: 'Supabase realtime publication: only adds, never auto-includes new tables',
    content: 'New tables do NOT automatically join the supabase_realtime publication. After every CREATE TABLE that the PWA needs to subscribe to, add: `alter publication supabase_realtime add table public.<name>`. Symptoms when missed: client.channel().on("postgres_changes",...) listener never fires; UI shows stale data until next poll.',
    category: 'external_service_quirk',
    tags: ['supabase', 'realtime', 'publication'],
  },
  {
    role: 'atlas',
    title: 'pgvector ivfflat with 100 lists is fine up to ~50k rows',
    content: 'For agent_role_memory and similar small knowledge pools, ivfflat with lists=100 over a 1536-dim vector column gives sub-50ms nearest-neighbor search. Switch to hnsw or bump lists only if row count crosses ~50k OR query latency creeps over 200ms. Smaller datasets actually perform WORSE with more lists due to index sparsity.',
    category: 'code_pattern',
    tags: ['pgvector', 'ivfflat', 'embeddings', 'supabase'],
  },
  {
    role: 'atlas',
    title: 'verifySupabaseToken throws — wrap caller in try/catch',
    content: 'api/_middleware/auth.js verifySupabaseToken(req) throws AuthError with .status on bad/missing token. Every caller must try/catch and return res.status(err.status || 401). Letting it bubble causes a 500 the client cannot distinguish from a real server failure.',
    category: 'code_pattern',
    tags: ['auth', 'supabase', 'middleware'],
  },

  // ====== CARTER — product engineering (Dossie React) ======
  {
    role: 'carter',
    title: 'Heath approves merges. Carter does NOT push to main.',
    content: 'Locked 2026-06-18: Carter writes diffs and pushes to STAGING only. Atlas pulls, builds the bundle, runs Playwright APV against the staging URL, and merges to main only after APV passes. Carter shipping straight to main caused the prod-down incident + customer demo failure. No exceptions, no urgent patches.',
    category: 'workflow',
    tags: ['process', 'merge', 'staging', 'carter'],
  },
  {
    role: 'carter',
    title: 'Founding price is $29/mo — NEVER change without explicit instruction',
    content: 'CLAUDE.md Section 5 locks pricing. Founding Members = $29/mo, 50 spots, currently 12 taken. Solo monthly $79 / annual $39. Team $199. NEVER modify these values when refactoring pricing displays. If a refactor "simplifies" by removing the constant, add it back BEFORE the commit.',
    category: 'heath_preference',
    tags: ['pricing', 'founding', 'locked'],
  },
  {
    role: 'carter',
    title: 'Dossie is always "she/her" — never "it" or "the app"',
    content: 'Brand voice rule: in any user-facing copy (UI text, email body, tooltip, error message, marketing), Dossie is referred to as she/her, warm and feminine. "Dossie helps you" not "the app helps you" / "Dossie reminded me" not "the system reminded me". Tagline: Your deals. Her job.',
    category: 'heath_preference',
    tags: ['brand', 'voice', 'copy'],
  },
  {
    role: 'carter',
    title: 'Test the customer flow signed-in, not as anonymous curl',
    content: 'For any customer-facing change, verification must use Playwright signed-in as heath.shepard@kw.com or demo@meetdossie.com and execute the exact action a customer would. Unauthenticated smoke tests (curl returning 401 against the API) do NOT count as verification. APV is the merge gate.',
    category: 'workflow',
    tags: ['testing', 'apv', 'playwright'],
  },

  // ====== HADLEY — legal / TREC forms ======
  {
    role: 'hadley',
    title: 'TREC 39-10 is Amendment to Contract, NOT Loan Assumption',
    content: 'Common mix-up: form 39-10 (Amendment to Contract) vs. 41-3 (Loan Assumption Addendum). Always disambiguate by full form number AND title before generating prefill data. The TREC promulgated forms catalog is the source of truth — never infer form number from a colloquial name.',
    category: 'legal_nuance',
    tags: ['trec', 'forms', 'amendment'],
  },
  {
    role: 'hadley',
    title: 'TREC 40-11: leaving interest-rate cap blank voids financing contingency',
    content: 'On TREC 40-11 (Third Party Financing Addendum), failing to fill the interest-rate cap field — or filling it with "market" — does NOT default to "any rate". It voids the financing contingency entirely under Texas case law. Always require a numeric cap. Flag any draft missing this as DEFECTIVE.',
    category: 'legal_nuance',
    tags: ['trec', '40-11', 'financing-contingency'],
  },
  {
    role: 'hadley',
    title: 'DocuSeal template 4018208 has duplicate "Seller 2" field — re-map carefully',
    content: 'When prefilling via DocuSeal API for the TREC resale contract template 4018208, the field set includes two distinct "Seller 2" entries (one signature, one printed name). Match by full slug, not display name. Mis-mapping caused contract draft failures noted in 2026-06-17 session handoff.',
    category: 'external_service_quirk',
    tags: ['docuseal', 'trec', '4018208', 'prefill'],
  },
  {
    role: 'hadley',
    title: 'Full transaction template must work before any TREC fill goes live',
    content: 'Per-form ship is forbidden. Buyer-side package = TREC 20-17 + 40-11 + conditional addendums ALL must fill correctly before any TREC fill is enabled in customer UI. Partial functionality misleads agents into legally defective drafts. Locked 2026-06-17.',
    category: 'legal_nuance',
    tags: ['trec', 'fill-form', 'ship-gate'],
  },
  {
    role: 'hadley',
    title: 'DocuSeal is the default e-sign; DocuSign is the paid upgrade',
    content: 'Texas ESIGN/UETA renders DocuSeal-signed documents enforceable in real estate. Default Dossie deals use DocuSeal. DocuSign stays an opt-in upgrade for customers who want brand recognition or whose brokerage compliance requires it. No build of the DocuSign integration until 30+ paying customers exist. Locked 2026-06-19.',
    category: 'legal_nuance',
    tags: ['docuseal', 'docusign', 'esign', 'compliance'],
  },

  // ====== JARVIS — voice loop / persona / addressing ======
  {
    role: 'jarvis',
    title: 'Heath addresses preference = "sir" (varies like a real EA)',
    content: 'Heath\'s tenants.addressing_pref is "sir". Use it naturally but VARY phrasing like a real executive assistant: "sir", "Heath", a question without an address. Never robotic. Never "Mr. Shepard" (too formal). Never "boss" (off-brand). Default to sir, but if the last 3 replies all started with sir, drop it on the 4th.',
    category: 'heath_preference',
    tags: ['addressing', 'persona', 'voice'],
  },
  {
    role: 'jarvis',
    title: 'Heath prefers Iron Man HUD aesthetic — electric cyan, info-dense, always moving',
    content: 'V5 HUD spec: Earth wireframe + city lights + hex-grid background + electric cyan accents + glassmorphic panels + seamless rotation + always-moving (no static states). Carter re-reads reference_jarvis_v5_visual_spec.md every round. Static UI = wrong. Stop-and-go animations = wrong.',
    category: 'heath_preference',
    tags: ['hud', 'jarvis-pwa', 'aesthetic'],
  },
  {
    role: 'jarvis',
    title: 'Default reply = 1-2 sentences. No bullet list. No threads register.',
    content: 'Heath set radical brevity 2026-06-18. Even "tight" replies were too long. Default = max 2 sentences. No "here\'s the plan" preamble. No multi-paragraph diagnoses. The Open Threads register is OFF unless asked. HUD card is the durable view; chat is fleeting status. Expand only on explicit Heath request.',
    category: 'heath_preference',
    tags: ['brevity', 'tone', 'voice'],
  },
  {
    role: 'jarvis',
    title: 'NEVER curl Telegram getUpdates — steals poll lock from the plugin',
    content: 'The telegram MCP plugin holds a long-poll lock against the bot getUpdates endpoint. Any concurrent curl to /getUpdates causes the plugin to drop inbound messages silently. Symptom: "Telegram MCP inbound dropped" notes in session handoffs. NEVER hit Telegram API directly from a tool that runs alongside the plugin.',
    category: 'api_gotcha',
    tags: ['telegram', 'mcp', 'getupdates', 'banned'],
  },
  {
    role: 'jarvis',
    title: 'Carter "done" is NOT actionable — only Atlas APV PASS triggers merge proposal',
    content: 'Pattern: Carter reports "ready for merge" -> actually broken. Locked: Jarvis never asks Heath to merge based on Carter\'s word. Carter ships to staging -> Jarvis auto-spawns Atlas APV -> only Atlas-confirmed PASS pings Heath. Saves 5+ false-positive merge requests per day.',
    category: 'workflow',
    tags: ['process', 'apv', 'merge-gate'],
  },
  {
    role: 'jarvis',
    title: 'Customer bugs preempt other work + email customer back personally',
    content: 'Any founding-member bug report jumps to the top of the queue. Verify on staging by eye, get Heath\'s merge approval, ship, THEN email the customer thanking them + giving refresh/clear-cache instructions. Brittney pattern 2026-06-17. Tone: calm friend, small stakes. Never quantify breadth ("hit every customer"). Never name vendors as cause (Vercel/Supabase/Resend).',
    category: 'customer_pattern',
    tags: ['customer-support', 'brittney', 'tone'],
  },
  {
    role: 'jarvis',
    title: 'Heath = 100% SC disabled veteran — qualifies for SDVOSB',
    content: 'Heath is a 100% service-connected disabled veteran. Eligible for SDVOSB certification, TX franchise tax exemption, SBA Express loans, AWS/Azure veteran programs, GitHub for Veterans. Surface these whenever a relevant cost/grant/cert decision comes up. Apply at SDVOSB cert when forming Dossie LLC.',
    category: 'heath_preference',
    tags: ['veteran', 'sdvosb', 'grants'],
  },

  // ====== PIERCE — growth + customer success ======
  {
    role: 'pierce',
    title: 'Founder outreach = warm friendly, never confrontational',
    content: 'Outreach to dormant founding members: open with a warm 1-line opener (NOT "Name, Heath."). Frame founders as having a direct line to the builder, eager to hear feedback + make it work. No transactional tone. No "we noticed you haven\'t logged in" guilt trip. Locked 2026-06-17 after Pierce reactivation rewrite.',
    category: 'customer_pattern',
    tags: ['outreach', 'tone', 'founder'],
  },
  {
    role: 'pierce',
    title: 'Subscriber emails: Tue-Thu 8:30am CST ONLY',
    content: 'Never schedule mass subscriber emails Mon, Fri, evenings, or weekends. Open rates drop 30-40% outside the Tue/Wed/Thu 8:30am CST window. The "Weekly Update" goes Friday only as exception because it\'s explicitly weekly-themed; even then send no later than 9am.',
    category: 'workflow',
    tags: ['email', 'send-window', 'open-rate'],
  },
  {
    role: 'pierce',
    title: 'Persona Dossie-usage timeframes = "recently" / "last few weeks"',
    content: 'When writing persona-driven marketing copy (Brenda, Patricia, Victor), NEVER imply multi-month or multi-year Dossie use. Product is ~6 weeks old. Use "recently", "over the last few weeks", "since I started using Dossie". Multi-month claims look fabricated to anyone who knows the launch date.',
    category: 'customer_pattern',
    tags: ['persona', 'marketing', 'copy', 'truth'],
  },

  // ====== SAGE — social / content distribution ======
  {
    role: 'sage',
    title: 'Reels pipeline = Kling + ElevenLabs + ffmpeg + Submagic — NOT Creatomate',
    content: 'Dossie reel workflow: Kling AI clips in Media/Videos/ -> ElevenLabs Charlie voiceover -> ffmpeg concat/freeze -> Supabase upload (auth token only, NO apikey header) -> Submagic Hormozi 1 captions. Creatomate is for the lifestyle-video pipeline, not reels. Mixing the two has corrupted output twice.',
    category: 'workflow',
    tags: ['reels', 'kling', 'submagic', 'video'],
  },
  {
    role: 'sage',
    title: 'NEVER fabricate specifics in customer-facing posts',
    content: 'Social posts, emails, marketing copy must only reference VERIFIED facts. No invented member numbers, fake timestamps, hallucinated features, or debug stories that did not happen. If a number isn\'t in the DB or CLAUDE.md, do not include it. Locked rule.',
    category: 'workflow',
    tags: ['brand', 'truth', 'social'],
  },
  {
    role: 'sage',
    title: 'Founding Files FB group autoposts via fb-group-poster.js',
    content: 'Private group facebook.com/share/g/1P2QL9T42t/ — DossieBot Chrome profile is logged in. To post: insert row into group_posts (group_name, group_url, post_body, status="approved", template_id="direct"), then run `node scripts/fb-group-poster.js --post-id <uuid>`. CLOSE the DossieBot Chrome window first or Playwright will collide with the profile lock.',
    category: 'workflow',
    tags: ['founding-files', 'facebook', 'autopost'],
  },

  // ====== QUINN — QA ======
  {
    role: 'quinn',
    title: 'After every Carter staging push, run full test suite — no "non-blocking" skips',
    content: 'Quinn auto-spawns after every Carter staging push. Loop with Carter up to 3 rounds to fix ALL failures, including "non-blocking" ones. Heath says "merge it" before Cole touches main — no exceptions. Cole never auto-merges. Heath is always the final gate.',
    category: 'workflow',
    tags: ['qa', 'staging', 'merge-gate'],
  },
  {
    role: 'quinn',
    title: 'Mobile bug diagnostic = on-page overlay activated by URL flag',
    content: 'When a UI bug breaks on Heath\'s real mobile but Playwright emulation says clean, STOP guessing after attempt 2. Build a visible on-page event-stream overlay activated by a URL flag (?debug=1). Heath taps the broken flow, screenshots the log, you diagnose in one round-trip. Proven 2026-05-24 mobile-scan bug.',
    category: 'workflow',
    tags: ['debug', 'mobile', 'overlay'],
  },

  // ====== STERLING — markets / trading ======
  {
    role: 'sterling',
    title: 'Sterling never PREDICTS — surfaces info and risk-managed orders',
    content: 'Sterling is honest about market unpredictability. Job is to surface catalysts, news, risk factors, and draft RISK-MANAGED order ideas. Never "buy this stock", never confident price predictions. Always include a stop-loss + position-sizing rule with every order draft. Educate, don\'t hype.',
    category: 'heath_preference',
    tags: ['markets', 'risk', 'tone'],
  },

  // ====== RIDGE — reliability / SRE ======
  {
    role: 'ridge',
    title: 'Vercel cron "configured" != "firing" — check last invocation timestamp',
    content: 'A vercel.json cron entry is a SCHEDULE, not a proof of execution. To verify a cron is alive, pull the last invocation timestamp via the Vercel deployments + runtime logs (or write a "cron heartbeat" row into a table and check freshness). If no fire in the expected window, flag as DEAD CRON. Locked under Atlas A2 rule, applies to Ridge SRE checks.',
    category: 'workflow',
    tags: ['cron', 'vercel', 'observability'],
  },
];

console.log(`[seed-agent-memory] preparing to seed ${LESSONS.length} lessons...`);

// ----------------------------------------------------------------------------
// HTTP helpers
// ----------------------------------------------------------------------------
async function sbGet(p) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) throw new Error(`sbGet ${p} ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbPost(p, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPost ${p} ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbPatch(p, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPatch ${p} ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`sbRpc ${fn} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.data[0].embedding;
}

function toPgVec(arr) {
  return '[' + arr.map(n => Number(n).toFixed(6)).join(',') + ']';
}

(async () => {
  // Resolve tenant
  const tenants = await sbGet(`tenants?select=id&slug=eq.${SEED_TENANT_SLUG}&limit=1`);
  if (!tenants.length) {
    console.error(`Tenant '${SEED_TENANT_SLUG}' not found`);
    process.exit(1);
  }
  const tenantId = tenants[0].id;
  console.log(`[seed-agent-memory] tenant ${tenantId} (${SEED_TENANT_SLUG})`);

  let inserted = 0, merged = 0, errors = 0;
  for (const lesson of LESSONS) {
    try {
      const embedText = `${lesson.title}\n\n${lesson.content}`;
      const vec = await embed(embedText);
      const pgVec = toPgVec(vec);

      // Dedupe
      const dupes = await sbRpc('agent_memory_find_duplicate', {
        p_tenant_id: tenantId,
        p_agent_role: lesson.role,
        p_query_embed: pgVec,
        p_threshold: 0.92,
      });
      if (Array.isArray(dupes) && dupes.length > 0) {
        // increment usage_count
        const dup = dupes[0];
        const existing = await sbGet(`agent_role_memory?select=usage_count&id=eq.${dup.id}&limit=1`);
        if (existing.length) {
          await sbPatch(`agent_role_memory?id=eq.${dup.id}`, {
            usage_count: (existing[0].usage_count || 0) + 1,
            last_used_at: new Date().toISOString(),
          });
        }
        merged++;
        console.log(`  [merge] ${lesson.role}/${lesson.title.slice(0, 60)} sim=${dup.similarity?.toFixed(3)}`);
        continue;
      }

      // Insert
      const row = {
        tenant_id: tenantId,
        agent_role: lesson.role,
        title: lesson.title.slice(0, 200),
        content: lesson.content.slice(0, 4000),
        category: lesson.category || 'workflow',
        validation_status: 'auto',
        tags: lesson.tags || [],
        usage_count: 0,
        embedding: pgVec,
      };
      const ins = await sbPost('agent_role_memory', row);
      inserted++;
      console.log(`  [ok]    ${lesson.role}/${ins[0].id.slice(0,8)} ${lesson.title.slice(0, 60)}`);
    } catch (err) {
      errors++;
      console.error(`  [ERR]   ${lesson.role}/${lesson.title.slice(0, 60)} ${err.message}`);
    }
  }

  // Report
  const counts = await sbGet(`agent_role_memory?select=agent_role&tenant_id=eq.${tenantId}`);
  const tally = {};
  for (const r of counts) tally[r.agent_role] = (tally[r.agent_role] || 0) + 1;

  console.log('\n[seed-agent-memory] done');
  console.log(`  inserted: ${inserted}`);
  console.log(`  merged:   ${merged}`);
  console.log(`  errors:   ${errors}`);
  console.log(`  totals by role: ${JSON.stringify(tally)}`);
})().catch(err => {
  console.error('seeder fatal:', err);
  process.exit(1);
});
