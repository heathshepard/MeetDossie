// Vercel Serverless Function: /api/cron-morning-brief
//
// Sends Heath a daily Telegram snapshot of Dossie business health at 7AM CDT
// (12:00 UTC). Surfaces churn-risk customers as action items so he can text
// them personally before they go cold.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 12 * * *" (12:00 UTC = 7:00 AM CDT during DST).
//
// Demo / Heath accounts excluded from every metric:
//   - profiles.is_demo = true
//   - email LIKE 'heath.shepard@%'
//   - emails containing 'demo' (defense-in-depth)
//
// Error handling: every query is wrapped in safeQuery() so a single failure
// gracefully degrades that metric (rendered as '?') rather than aborting the
// whole brief. The brief is high-value even when one number is missing.
//
// Sections added 2026-05-25:
//   - STAGING DIFF: commits on staging not yet merged to main (child_process.execSync)
//   - SOCIAL: yesterday's post activity from social_posts table
//   - FOUNDING SPOTS REMAINING: 50 - active founding count
//   - REFERRAL PIPELINE: pending founding_applications with names
//   - LOGIN DETECTION FIX: caveat on last_sign_in_at accuracy + is_demo exclusion verified

const { execSync } = require('child_process');
const nodePath = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// Total founding spots available (locked — change only on explicit Heath instruction).
const FOUNDING_TOTAL_SPOTS = 50;

// Keep in sync with api/admin-dashboard.js expenses block. Only the three
// fixed-cost SaaS line items requested in the brief spec — Claude/Anthropic
// API spend is variable and shown separately on the admin dashboard.
//
// TODO: when admin-dashboard.js expense numbers drift, update both places.
const FIXED_MONTHLY_EXPENSES = 18 + 18.33 + 12; // Zernio + ElevenLabs + Submagic = $48.33

// TODO (v2): replace the hardcoded Suzanne-is-$1 rule with a metadata flag
// on the subscription row (e.g. subscriptions.metadata->>'is_friend' = 'true'
// or a 'founding_friend' plan value). For v1 we hardcode by email.
const FOUNDING_FRIEND_EMAILS = new Set(['k.suzanne.page@gmail.com']);

// ─── Supabase REST helper ────────────────────────────────────────────────

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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// Wrap a query so any thrown error or non-ok response gracefully degrades
// instead of crashing the brief.
async function safeQuery(label, fn, fallback) {
  try {
    const result = await fn();
    return result;
  } catch (err) {
    console.error(`[morning-brief] query failed (${label}):`, err && err.message);
    return fallback;
  }
}

// ─── Date helpers ────────────────────────────────────────────────────────

// Returns ISO string for the start of "today" in America/Chicago expressed
// in UTC. e.g. if it's 7AM CDT May 21, this returns the UTC instant
// corresponding to May 21 00:00 CDT.
function chicagoMidnightUtc(daysOffset = 0) {
  const now = new Date();
  // Get the date components in Chicago tz
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateStr = fmt.format(now); // 'YYYY-MM-DD' in Chicago
  // Parse the date in Chicago tz at 00:00
  // Determine Chicago offset right now (CDT is -05:00, CST is -06:00)
  const offsetFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    timeZoneName: 'shortOffset',
  });
  const parts = offsetFmt.formatToParts(now);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  // tzPart.value is like 'GMT-5' or 'GMT-6'
  const m = tzPart && tzPart.value.match(/GMT([+-]\d+)/);
  const offsetHours = m ? parseInt(m[1], 10) : -5; // default CDT
  // Midnight in Chicago = 00:00 - offsetHours UTC. e.g. CDT (-5) → 05:00 UTC
  const [y, mo, d] = dateStr.split('-').map(Number);
  const utcMidnight = new Date(Date.UTC(y, mo - 1, d, -offsetHours, 0, 0, 0));
  if (daysOffset !== 0) {
    utcMidnight.setUTCDate(utcMidnight.getUTCDate() + daysOffset);
  }
  return utcMidnight;
}

function chicagoDateLabel() {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric',
  });
  return fmt.format(new Date());
}

function startOfThisMonthUtc() {
  // First day of current calendar month in Chicago tz, as UTC instant.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit',
  });
  const ym = fmt.format(now); // 'YYYY-MM'
  const [y, mo] = ym.split('-').map(Number);
  // Approximate as the 1st at 00:00 UTC — acceptable for "this month" bucketing.
  return new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0, 0));
}

function startOfThisWeekChicago() {
  // Monday 00:00 in Chicago tz, expressed as UTC instant.
  // Get current Chicago weekday.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'short',
  });
  const weekdayShort = fmt.format(now); // 'Mon', 'Tue', ...
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[weekdayShort] ?? 1;
  // Days back to Monday (Sunday = 6 days back)
  const daysBackToMonday = dow === 0 ? 6 : dow - 1;
  return chicagoMidnightUtc(-daysBackToMonday);
}

function daysBetween(later, earlier) {
  return Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── Daily video recording brief ─────────────────────────────────────────
//
// Generates the "TODAY'S VIDEO" section of the morning brief.
// Portrait days (Mon/Wed/Fri): phone recording → TikTok + Instagram.
// Desktop days (Tue/Thu):      screen recording → Facebook + Twitter + LinkedIn.
// Weekend (Sat/Sun):           no new recording — re-run top performer.
//
// Topic rotation uses week index derived from day-of-year so the cycle is
// calendar-stable regardless of when the cron first ran.
// Week index = Math.floor(dayOfYear / 7) % 4 → cycles through 4 topics:
//   0 = Morning Brief, 1 = Pipeline View, 2 = Talk to Dossie, 3 = Document Upload

const VIDEO_TOPICS = [
  {
    slug: 'morning-brief',
    label: 'Morning Brief',
    portraitSteps: [
      '- Open meetdossie.com/app on your phone and log in as Sarah',
      '- Tap the Morning Brief banner at the top of the dashboard',
      '- Show the brief loading — let it read the first deal summary aloud',
      '- Scroll the deal list while the audio plays, then tap X to close',
    ],
    desktopSteps: [
      '- Open meetdossie.com/app and log in',
      '- Click the Morning Brief card at the top of the dashboard',
      '- Let the brief load and begin reading — keep cursor still while audio plays',
      '- Scroll down through the deal summary panel, then close the overlay',
    ],
  },
  {
    slug: 'pipeline-view',
    label: 'Pipeline View',
    portraitSteps: [
      '- Open meetdossie.com/app on your phone and navigate to the Pipeline tab',
      '- Scroll through the deal cards — show the deadline badges in red and yellow',
      '- Tap one deal card to open the dossier detail view',
      '- Scroll the detail to show the action items checklist, then swipe back',
    ],
    desktopSteps: [
      '- Open meetdossie.com/app and click Pipeline in the sidebar',
      '- Hover over a deal card with a red deadline badge — let the tooltip appear',
      '- Click the card to open the dossier detail page',
      '- Scroll to the Action Items section, then hit the browser back button',
    ],
  },
  {
    slug: 'talk-to-dossie',
    label: 'Talk to Dossie',
    portraitSteps: [
      '- Open meetdossie.com/app on your phone and tap the Talk to Dossie button',
      '- Type: "What is the option period deadline on 123 Main Street?" and send',
      '- Show Dossie\'s response with the TREC paragraph citation highlighted',
      '- Type a follow-up: "Add 3 days to the option period" and show the update',
    ],
    desktopSteps: [
      '- Open meetdossie.com/workspace and select a deal from the sidebar',
      '- In the chat input type: "What deadlines are coming up this week?" and press Enter',
      '- Show Dossie\'s response scroll in — pause on the deadline list',
      '- Type: "Draft an email to the title company confirming closing date" and send',
    ],
  },
  {
    slug: 'document-upload',
    label: 'Document Upload',
    portraitSteps: [
      '- Open meetdossie.com/app on your phone and tap a deal card to open it',
      '- Tap the Scan / Upload button in the dossier detail',
      '- Select or photograph a document (use a blank page or sample contract)',
      '- Show the document appear in the Documents section of the dossier',
    ],
    desktopSteps: [
      '- Open meetdossie.com/app and click into a dossier from the pipeline',
      '- Scroll to the Documents section and click Upload Document',
      '- Select a sample PDF from your desktop and confirm the upload',
      '- Watch the document card appear in the list with the file name and date',
    ],
  },
];

function buildVideoBrief(now) {
  // Determine Chicago day of week: 0=Sun, 1=Mon, ..., 6=Sat
  const dowFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
  });
  const dowShort = dowFmt.format(now); // 'Sun', 'Mon', 'Tue', ...
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const dow = dowMap[dowShort] ?? 0;

  // Weekend — no new recording.
  if (dow === 0 || dow === 6) {
    return [
      '🎬 No new recording today — Carter will re-run top performer from the week.',
    ].join('\n');
  }

  // Day-of-year for stable week index.
  const yearFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const dateStr = yearFmt.format(now); // 'YYYY-MM-DD'
  const [y, mo, d] = dateStr.split('-').map(Number);
  const startOfYear = new Date(Date.UTC(y, 0, 1));
  const dayOfYear = Math.floor((Date.UTC(y, mo - 1, d) - startOfYear.getTime()) / 86400000);
  const weekIndex = Math.floor(dayOfYear / 7) % 4;
  const topic = VIDEO_TOPICS[weekIndex];

  // Is this a portrait day (Mon=1, Wed=3, Fri=5) or desktop day (Tue=2, Thu=4)?
  const isPortrait = dow === 1 || dow === 3 || dow === 5;

  // Desktop days: alternate demo account by week parity.
  // Even week index → demo@meetdossie.com (Sarah Whitley)
  // Odd week index  → demo2@meetdossie.com (John Smith)
  let demoAccount, demoName;
  if (isPortrait) {
    demoAccount = 'demo@meetdossie.com';
    demoName = 'Sarah Whitley';
  } else {
    if (weekIndex % 2 === 0) {
      demoAccount = 'demo@meetdossie.com';
      demoName = 'Sarah Whitley';
    } else {
      demoAccount = 'demo2@meetdossie.com';
      demoName = 'John Smith';
    }
  }

  // Build save path.
  const savePath = isPortrait
    ? `Media/screen-recordings/vertical/${topic.slug}-mobile-${dateStr}.mp4`
    : `Media/screen-recordings/${topic.slug}-desktop-${dateStr}.mp4`;

  // Build the section.
  const lines = [];
  lines.push('🎬 TODAY\'S VIDEO');
  lines.push('');
  lines.push(`Format: ${isPortrait ? '📱 PORTRAIT (phone)' : '🖥️ DESKTOP (screen recording)'}`);
  lines.push(`Topic: ${topic.label}`);
  lines.push(`Account: ${demoName} — ${demoAccount}`);
  lines.push('');
  lines.push('Steps:');
  const steps = isPortrait ? topic.portraitSteps : topic.desktopSteps;
  for (const step of steps) lines.push(step);
  lines.push('');
  lines.push(`Save as: ${savePath}`);
  lines.push('');
  lines.push('Text DONE when saved. Carter will render with synced voiceover and send for review.');

  return lines.join('\n');
}

// ─── Staging diff ─────────────────────────────────────────────────────────

// Returns an array of one-line commit strings that are on staging but not yet
// merged to main. Uses git log main..staging so it's safe even when run from
// inside a Vercel build — if .git isn't present the catch returns null.
function getStagingDiff() {
  try {
    // __dirname is api/ inside the repo. Walk up one level to repo root.
    const repoRoot = nodePath.join(__dirname, '..');
    const output = execSync('git log main..staging --oneline', {
      cwd: repoRoot,
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch (err) {
    // git not available in Vercel serverless runtime — degrade gracefully.
    console.error('[morning-brief] git staging diff unavailable:', err && err.message);
    return null; // null = unavailable (vs [] = clean)
  }
}

// ─── Customer filtering ──────────────────────────────────────────────────

function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  // Catch every Heath variant — gmail, kw.com, meetdossie.com, plus-aliases, and
  // unprefixed test accounts (heathtestaccount@...). The profiles.is_founder
  // flag is the authoritative check; this is belt-and-suspenders for callers
  // that don't have the flag yet.
  if (e.startsWith('heath')) return true;
  if (e.includes('demo')) return true;
  return false;
}

function priceForCustomer({ email, plan }) {
  if (plan === 'founding') {
    return FOUNDING_FRIEND_EMAILS.has((email || '').toLowerCase()) ? 1 : 29;
  }
  if (plan === 'solo') return 79;
  if (plan === 'team') return 199;
  return 0;
}

// ─── Telegram ────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    throw new Error('Telegram env vars not set (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)');
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const respText = await res.text();
  if (!res.ok) {
    throw new Error(`Telegram ${res.status}: ${respText.slice(0, 300)}`);
  }
  return { ok: true, status: res.status };
}

// ─── Main brief assembly ─────────────────────────────────────────────────

async function buildBrief() {
  // 1. Load active subscriptions with profile + auth info joined.
  const customers = await safeQuery('active customers', async () => {
    // Fetch active subs.
    const subResp = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=user_id,plan,status,created_at,stripe_price_id,canceled_at');
    if (!subResp.ok) throw new Error(`subscriptions fetch ${subResp.status}`);
    const subs = subResp.data || [];
    if (subs.length === 0) return [];

    const userIds = subs.map((s) => s.user_id).filter(Boolean);
    if (userIds.length === 0) return [];

    // Fetch matching profiles.
    const profFilter = userIds.map((id) => `"${id}"`).join(',');
    const profResp = await supabaseFetch(
      `/rest/v1/profiles?id=in.(${profFilter})&select=id,email,full_name,is_demo,is_founder`,
    );
    if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);
    const profilesById = new Map((profResp.data || []).map((p) => [p.id, p]));

    // Fetch last_sign_in_at from auth.users via admin endpoint. PostgREST
    // doesn't expose the auth schema directly, so we hit the auth admin API.
    const lastSignInByUserId = new Map();
    for (const uid of userIds) {
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${uid}`, {
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          },
        });
        if (r.ok) {
          const u = await r.json();
          lastSignInByUserId.set(uid, u && u.last_sign_in_at ? new Date(u.last_sign_in_at) : null);
        }
      } catch (err) {
        console.error(`[morning-brief] auth lookup failed for ${uid}:`, err && err.message);
      }
    }

    // Join + exclude demo/heath.
    const joined = [];
    for (const s of subs) {
      const p = profilesById.get(s.user_id);
      if (!p) continue;
      if (p.is_demo) continue;
      if (p.is_founder) continue; // Shepard Ventures internal — never in customer aggregates
      if (isExcludedEmail(p.email)) continue;
      joined.push({
        user_id: s.user_id,
        email: p.email,
        name: p.full_name || (p.email ? p.email.split('@')[0] : 'Unknown'),
        plan: s.plan,
        stripe_price_id: s.stripe_price_id,
        created_at: new Date(s.created_at),
        last_sign_in_at: lastSignInByUserId.get(s.user_id) ?? null,
      });
    }
    return joined;
  }, []);

  // 2. Financial line.
  let mrr = 0;
  let foundingPaying = 0;
  let foundingFriend = 0;
  let soloCount = 0;
  let teamCount = 0;
  for (const c of customers) {
    const price = priceForCustomer(c);
    mrr += price;
    if (c.plan === 'founding') {
      if (price === 1) foundingFriend++;
      else foundingPaying++;
    } else if (c.plan === 'solo') {
      soloCount++;
    } else if (c.plan === 'team') {
      teamCount++;
    }
  }
  const expenses = FIXED_MONTHLY_EXPENSES;
  const net = mrr - expenses;

  // 3. Cancellations this month.
  const monthStartIso = startOfThisMonthUtc().toISOString();
  const cancelledThisMonth = await safeQuery('cancelled-this-month', async () => {
    // Match admin-dashboard.js: status='canceled' OR 'cancelled', use updated_at
    // (canceled_at column is unreliable — null on existing cancelled rows).
    const r = await supabaseFetch(
      `/rest/v1/subscriptions?or=(status.eq.canceled,status.eq.cancelled)&updated_at=gte.${encodeURIComponent(monthStartIso)}&select=id,user_id`,
    );
    if (!r.ok) return '?';
    const rows = Array.isArray(r.data) ? r.data : [];
    if (rows.length === 0) return 0;
    // Exclude Heath's own test accounts (same filter as active customers).
    const userIds = rows.map((row) => row.user_id).filter(Boolean);
    if (userIds.length === 0) return rows.length;
    const profFilter = userIds.map((id) => `"${id}"`).join(',');
    const profResp = await supabaseFetch(
      `/rest/v1/profiles?id=in.(${profFilter})&select=id,email`,
    );
    if (!profResp.ok) return rows.length;
    const emailById = new Map((profResp.data || []).map((p) => [p.id, p.email]));
    return rows.filter((row) => !isExcludedEmail(emailById.get(row.user_id))).length;
  }, '?');

  // 4. Growth: new paying customers this week (Mon-now).
  const weekStart = startOfThisWeekChicago();
  const newThisWeek = customers
    .filter((c) => c.created_at >= weekStart)
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const newMrrThisWeek = newThisWeek.reduce((sum, c) => sum + priceForCustomer(c), 0);

  // 5. Engagement.
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const activeIn7d = customers.filter((c) => c.last_sign_in_at && c.last_sign_in_at >= sevenDaysAgo);
  const activePct = customers.length > 0 ? Math.round((activeIn7d.length / customers.length) * 100) : 0;

  // Dossiers created yesterday.
  const yesterdayStartIso = chicagoMidnightUtc(-1).toISOString();
  const todayStartIso = chicagoMidnightUtc(0).toISOString();
  const dossiersYesterday = await safeQuery('dossiers-yesterday', async () => {
    const r = await supabaseFetch(
      `/rest/v1/transactions?created_at=gte.${encodeURIComponent(yesterdayStartIso)}&created_at=lt.${encodeURIComponent(todayStartIso)}&select=id`,
    );
    if (!r.ok) return '?';
    return Array.isArray(r.data) ? r.data.length : 0;
  }, '?');

  // Messages to Dossie yesterday — no messages/chat_messages table exists
  // (confirmed via list_tables 2026-05-20). Gracefully omitted in render.
  const messagesYesterday = null;

  // 6a. Founding spots remaining.
  // Count active founding subscriptions (paying $29) to derive spots used.
  // foundingPaying is already computed above — reuse it.
  // foundingFriend ($1) does NOT consume a founding spot (special case).
  const foundingSpotsUsed = foundingPaying; // excludes founding friend
  const foundingSpotsRemaining = FOUNDING_TOTAL_SPOTS - foundingSpotsUsed;

  // 6b. Referral pipeline — pending founding applications.
  const pendingApps = await safeQuery('pending-applications', async () => {
    const r = await supabaseFetch(
      `/rest/v1/founding_applications?status=eq.pending&select=id,name,email,created_at&order=created_at.asc`,
    );
    if (!r.ok) return null; // null = unavailable
    return Array.isArray(r.data) ? r.data : [];
  }, null);

  // 6c. Social health — yesterday's post activity.
  const socialHealth = await safeQuery('social-health', async () => {
    const r = await supabaseFetch(
      `/rest/v1/social_posts?posted_at=gte.${encodeURIComponent(yesterdayStartIso)}&posted_at=lt.${encodeURIComponent(todayStartIso)}&select=id,status,platform`,
    );
    if (!r.ok) return null;
    const rows = Array.isArray(r.data) ? r.data : [];
    const posted = rows.filter((p) => p.status === 'posted');
    const failed = rows.filter((p) => p.status === 'failed');
    const rejected = rows.filter((p) => p.status === 'rejected');
    // Unique platforms that had at least one successful post.
    const coveredPlatforms = [...new Set(posted.map((p) => p.platform).filter(Boolean))];
    // All platforms we care about.
    const allPlatforms = ['facebook', 'twitter', 'instagram', 'linkedin', 'tiktok'];
    const missedPlatforms = allPlatforms.filter((pl) => !coveredPlatforms.includes(pl));
    return { posted: posted.length, failed: failed.length, rejected: rejected.length, coveredPlatforms, missedPlatforms };
  }, null);

  // 6d. Staging diff.
  const stagingDiff = getStagingDiff();

  // 7. Churn-risk action items.
  // 🔴 Critical:
  //   - paid >48h ago AND never logged in
  //   - active customer no login in 7+ days
  // 🟡 Watch:
  //   - paid <48h ago AND never logged in (under grace, but worth noting)
  //   - logged in but no app action in 14+ days  ← simplified: login >14d ago
  const fortyEightHoursAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const critical = [];
  const watch = [];

  for (const c of customers) {
    const daysSinceSignup = daysBetween(now, c.created_at);
    if (!c.last_sign_in_at) {
      if (c.created_at <= fortyEightHoursAgo) {
        critical.push(`🔴 ${c.name} — paid ${daysSinceSignup} day${daysSinceSignup === 1 ? '' : 's'} ago, never logged in. TEXT ${c.name.split(' ')[0].toUpperCase()}.`);
      } else {
        const hours = Math.max(1, Math.floor((now.getTime() - c.created_at.getTime()) / (1000 * 60 * 60)));
        watch.push(`🟡 ${c.name} — paid ${hours}h ago, hasn't logged in yet (under 48h grace)`);
      }
      continue;
    }
    const daysSinceLogin = daysBetween(now, c.last_sign_in_at);
    if (daysSinceLogin >= 7) {
      critical.push(`🔴 ${c.name} — no login in ${daysSinceLogin} days. TEXT ${c.name.split(' ')[0].toUpperCase()}.`);
    } else if (c.last_sign_in_at <= fourteenDaysAgo) {
      // (Defensive — already covered by >=7 above; kept for future "no app action" check)
      watch.push(`🟡 ${c.name} — last login ${daysSinceLogin} days ago, activity dropping`);
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`☀️ Dossie Morning Brief — ${chicagoDateLabel()}`);
  lines.push('');

  // FINANCIAL
  lines.push('💰 FINANCIAL');
  lines.push(`MRR: $${mrr}  Expenses: $${expenses.toFixed(2)}  Net: $${net.toFixed(2)}/mo`);
  lines.push(`🎯 ${foundingSpotsRemaining} founding spots remaining (${foundingSpotsUsed}/${FOUNDING_TOTAL_SPOTS} taken)`);
  lines.push('');

  // CUSTOMERS
  lines.push('👥 CUSTOMERS');
  lines.push(`${foundingPaying} paying founding @ $29`);
  lines.push(`${foundingFriend} founding friend @ $1`);
  lines.push(`${soloCount} solo · ${teamCount} team`);
  lines.push(`${cancelledThisMonth} cancelled this month`);
  // Login detection caveat: last_sign_in_at only updates on explicit re-auth,
  // not on cached session usage. Active customers with valid sessions will show
  // as "not logged in" even though they're using the app.
  lines.push('(login dates = last auth event; cached sessions not reflected)');
  lines.push('');

  // NEW THIS WEEK
  lines.push('🆕 NEW THIS WEEK');
  if (newThisWeek.length === 0) {
    lines.push('No new paying customers yet this week.');
  } else {
    const names = newThisWeek.map((c) => c.name).join(', ');
    lines.push(`${names} (+$${newMrrThisWeek} MRR)`);
  }
  lines.push('');

  // REFERRAL PIPELINE
  lines.push('📥 PIPELINE');
  if (pendingApps === null) {
    lines.push('? pending applications (query unavailable)');
  } else if (pendingApps.length === 0) {
    lines.push('No pending applications.');
  } else {
    lines.push(`${pendingApps.length} pending application${pendingApps.length === 1 ? '' : 's'} awaiting review:`);
    for (const app of pendingApps) {
      const daysWaiting = daysBetween(now, new Date(app.created_at));
      lines.push(`  - ${app.name || app.email} (${daysWaiting}d ago)`);
    }
  }
  lines.push('');

  // VIDEO BRIEF
  const videoBrief = buildVideoBrief(now);
  lines.push(videoBrief);
  lines.push('');

  // SOCIAL HEALTH
  lines.push('📱 SOCIAL');
  if (socialHealth === null) {
    lines.push('? (query unavailable)');
  } else if (socialHealth.posted === 0 && socialHealth.failed === 0 && socialHealth.rejected === 0) {
    lines.push('No posts recorded yesterday.');
  } else {
    lines.push(`${socialHealth.posted} posted · ${socialHealth.failed} failed · ${socialHealth.rejected} rejected`);
    if (socialHealth.coveredPlatforms.length > 0) {
      lines.push(`Covered: ${socialHealth.coveredPlatforms.join(', ')}`);
    }
    if (socialHealth.missedPlatforms.length > 0) {
      lines.push(`Missed: ${socialHealth.missedPlatforms.join(', ')}`);
    }
  }
  lines.push('');

  // ENGAGEMENT
  lines.push('📊 ENGAGEMENT');
  lines.push(`Active 7d: ${activeIn7d.length}/${customers.length} paying (${activePct}%)`);
  const engageBits = [];
  if (messagesYesterday !== null) engageBits.push(`${messagesYesterday} messages to Dossie`);
  engageBits.push(`${dossiersYesterday} dossiers created`);
  lines.push(`Yesterday: ${engageBits.join(' · ')}`);
  lines.push('');

  // ACTION ITEMS
  lines.push('🚨 ACTION ITEMS');
  if (critical.length === 0 && watch.length === 0) {
    lines.push('✅ All customers healthy — nothing to act on today.');
  } else {
    for (const item of critical) lines.push(item);
    for (const item of watch) lines.push(item);
  }
  lines.push('');

  // STAGING DIFF
  lines.push('🔀 STAGING (not yet in production)');
  if (stagingDiff === null) {
    lines.push('git unavailable in this runtime — check manually.');
  } else if (stagingDiff.length === 0) {
    lines.push('✅ Staging is clean.');
  } else {
    for (const commit of stagingDiff) {
      lines.push(`  ${commit}`);
    }
  }
  lines.push('');

  lines.push('📍 Full dashboard: https://meetdossie.com/admin.html');

  return lines.join('\n');
}

// ─── Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  try {
    // Auth: accept Vercel cron header OR Bearer CRON_SECRET.
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }

    const text = await buildBrief();

    try {
      await sendTelegram(text);
    } catch (telegramErr) {
      console.error('[morning-brief] Telegram send failed:', telegramErr.message);
      return res.status(500).json({
        ok: false,
        error: `Telegram send failed: ${telegramErr.message}`,
        brief_preview: text.slice(0, 500),
      });
    }

    return res.status(200).json({
      ok: true,
      sent: true,
      brief_length: text.length,
      brief_lines: text.split('\n').length,
    });
  } catch (err) {
    console.error('[morning-brief] uncaught error:', err);
    return res.status(500).json({
      ok: false,
      error: err && err.message ? err.message : String(err),
    });
  }
};
