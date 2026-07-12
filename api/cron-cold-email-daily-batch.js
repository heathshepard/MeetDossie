// Vercel Serverless Function: /api/cron-cold-email-daily-batch
//
// Fires weekday mornings (~09:00 CDT / 14:00 UTC) and queues that day's
// cold-email touch-1 batch into public.outbound_email_queue.
//
// This is the *ramp-up* replacement for the prior weekly Monday blast that
// used queue-cold-email-batch-N.py. Volume comes from public.cold_email_cadence
// (week_num, daily_target). Schedule Heath set 2026-07-05:
//   Week 1 (2026-07-06+): 10/day Tue-Fri (batch-3 already sent Mon)
//   Week 2 (2026-07-13+): 15/day
//   Week 3 (2026-07-20+): 20/day
//   Week 4+ (2026-07-27+): 25/day steady
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 14 * * 1-5 (Mon-Fri 14:00 UTC = 09:00 CDT).
//           Heath decision 2026-07-09 evening: KW touch-2 override DISARMED
//           after fact-check exposed 3 wrong claims in the copy. Friday
//           2026-07-10 reverts to STANDARD 10-email SA-pool cadence.
//           kw-only-*.csv files retained on disk but not referenced.
//
// Behaviour:
//   1. Look up current week's daily_target from cold_email_cadence.
//   2. Load lead pool from data/sa-realtor-leads-final-v2.csv (bundled via
//      vercel.json includeFiles).
//   3. Filter: valid email, no known bounces, not in email_suppression_list,
//      not already in outbound_email_queue (any status), preferentially
//      Tier 1 (existing verified) then Tier 2 (KW pattern-guess).
//   4. Queue `daily_target` new pending rows with metadata.send_after set to
//      today 15:00 UTC (1 hour after cron fires — gives us a safety window).
//   5. Skip if it's a weekend or the day already has a queued batch (idempotent).
//
// Idempotency: metadata.batch = 'daily-YYYY-MM-DD'. If a row with that batch
// tag already exists in the queue, we skip entirely — no double-fires if the
// cron accidentally runs twice in one day.

const fs = require('fs');
const path = require('path');
const { recordCronRun } = require('./_lib/cron-telemetry.js');
const { isSuppressed, clearCache } = require('./_lib/check-suppression.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;

const FROM_EMAIL   = 'heath@meetdossie.com';
const REPLY_TO     = 'heath@meetdossie.com';
const SUBJECT      = '6:47pm again?';
const FOUNDING_URL = 'https://meetdossie.com/founding?utm_source=cold-email&utm_medium=email';
const UNSUB_URL    = 'https://meetdossie.com/unsubscribe';
const NW_ADDRESS   = 'Dossie LLC, 5900 Balcones Drive STE 100, Austin, TX 78731';

const KNOWN_BOUNCES = new Set(['cheo.chayoh@lptrealty.com']);

// Founding cohort — cap reduced from 50 → 25 on 2026-07-09 (locked for life).
// Live count queried per batch via getFoundingRemaining() so no stale numbers
// ("37 of 50") leak into cold-email copy again.
const FOUNDING_COHORT_CAP = 25;
const FOUNDING_FRIEND_EMAILS = new Set(['k.suzanne.page@gmail.com']);

async function getFoundingRemaining() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return FOUNDING_COHORT_CAP;
  try {
    const subResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?select=user_id&plan=eq.founding&status=eq.active`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!subResp.ok) return FOUNDING_COHORT_CAP;
    const subs = await subResp.json();
    const userIds = (Array.isArray(subs) ? subs : []).map((s) => s.user_id).filter(Boolean);
    if (userIds.length === 0) return FOUNDING_COHORT_CAP;
    const profFilter = userIds.map((id) => `"${id}"`).join(',');
    const profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=in.(${profFilter})&select=id,email,is_demo,is_founder`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    if (!profResp.ok) return Math.max(0, FOUNDING_COHORT_CAP - userIds.length);
    const profiles = await profResp.json();
    const profilesById = new Map((Array.isArray(profiles) ? profiles : []).map((p) => [p.id, p]));
    let taken = 0;
    for (const uid of userIds) {
      const p = profilesById.get(uid);
      if (!p || p.is_demo || p.is_founder) continue;
      if (p.email && FOUNDING_FRIEND_EMAILS.has(p.email.toLowerCase())) continue;
      taken += 1;
    }
    return Math.max(0, FOUNDING_COHORT_CAP - taken);
  } catch (err) {
    console.warn('[daily-batch] getFoundingRemaining failed:', err && err.message);
    return FOUNDING_COHORT_CAP;
  }
}

// Lead CSV path — bundled via vercel.json includeFiles.
const LEADS_CSV = path.join(process.cwd(), 'data/sa-realtor-leads-final-v2.csv');

// ── KW-only touch-2 override — DISARMED 2026-07-09 ───────────────────────
// Heath decision 2026-07-09 evening: fact-check exposed 3 wrong claims in
// the KW copy. Override killed. Friday 2026-07-10 reverts to STANDARD 10-
// email SA-pool cadence. CSV files kw-only-thursday-2026-07-10.csv and
// kw-only-friday-2026-07-11.csv retained on disk for possible future
// rewritten send but NOT referenced by cron logic.
//
// To re-arm: add date string to KW_OVERRIDE_DATES + map CSV in
// KW_OVERRIDE_CSV_BY_DATE + verify copy accuracy first.
const KW_OVERRIDE_DATES = new Set(); // empty = override branch never fires
const KW_OVERRIDE_CSV_BY_DATE = {};
const KW_OVERRIDE_SUBJECT = "Your DocuSign is dying in 5 days — here's a TX-native alternative I built";
const KW_OVERRIDE_TARGET  = 15;
const KW_OVERRIDE_CAMPAIGN = 'kw-docusign-migration-touch2';

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

function titleFirstName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (!parts.length || !parts[0]) return 'there';
  const p = parts[0];
  return p[0].toUpperCase() + p.slice(1).toLowerCase();
}

function cityOrDefault(c) {
  const s = String(c || '').trim();
  return s || 'San Antonio';
}

// Minimal CSV parser (handles quoted fields with commas). The lead CSV is
// generated by our own scraper, so we don't need bulletproof RFC-4180.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.length === header.length).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function loadLeads() {
  if (!fs.existsSync(LEADS_CSV)) {
    console.warn('[daily-batch] leads CSV not bundled:', LEADS_CSV);
    return [];
  }
  const text = fs.readFileSync(LEADS_CSV, 'utf8');
  return parseCsv(text);
}

function loadKwLeads(dateKey) {
  const csvPath = KW_OVERRIDE_CSV_BY_DATE[dateKey];
  if (!csvPath || !fs.existsSync(csvPath)) {
    console.warn('[daily-batch] KW override CSV not bundled for', dateKey, ':', csvPath);
    return [];
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  return parseCsv(text);
}

// KW touch-2 copy — Heath's approved final wording locked 2026-07-09 17:35 CDT.
// Numbers: 11 Texas REALTORS paying / 14 founding seats remaining / 25 cap /
// $29/mo LOCKED FOR LIFE / Solo goes $149 on July 31.
function buildKwText(firstName, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `Hey ${firstName},

KW REALTOR to KW REALTOR.

You know the drill. Every deal = TC service, DocuSign, CRM, deadline tracker. Different apps, different bills, different UIs.

I got tired of it. So I built Dossie - one app for TX REALTORs that auto-picks the right TREC forms, e-signs, tracks deadlines, drafts your follow-up emails. Does what a $400/file TC does. 11 Texas REALTORS pay for her today.

Bonus: DocuSign leaves KW Monday. Dossie has e-sign built in.

Founding: $29/mo for LIFE. 14 seats left. Solo goes $149 on July 31.

Reply 'demo' for a 5-min video + a call.

Heath Shepard
KW City View, SA
Founder, Dossie

---
Unsubscribe: ${unsub}
${NW_ADDRESS}
`;
}

function buildKwHtml(firstName, email) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 560px;">
<p>Hey ${firstName},</p>

<p>KW REALTOR to KW REALTOR.</p>

<p>You know the drill. Every deal = TC service, DocuSign, CRM, deadline tracker. Different apps, different bills, different UIs.</p>

<p>I got tired of it. So I built Dossie &mdash; one app for TX REALTORs that auto-picks the right TREC forms, e-signs, tracks deadlines, drafts your follow-up emails. Does what a $400/file TC does. 11 Texas REALTORS pay for her today.</p>

<p>Bonus: DocuSign leaves KW Monday. Dossie has e-sign built in.</p>

<p>Founding: $29/mo for LIFE. 14 seats left. Solo goes $149 on July 31.</p>

<p>Reply 'demo' for a 5-min video + a call.</p>

<p>Heath Shepard<br>
KW City View, SA<br>
Founder, <a href="${FOUNDING_URL}">Dossie</a></p>

<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;">
<p style="font-size: 11px; color: #888;">
<a href="${unsub}" style="color: #888;">Unsubscribe</a> | ${NW_ADDRESS}
</p>
</div>`;
}

function selectKwLeads(count, excluded, dateKey) {
  const all = loadKwLeads(dateKey);
  const selected = [];
  const seen = new Set();
  const isValidLead = r =>
    isValidEmail(r.email) &&
    !KNOWN_BOUNCES.has((r.email || '').toLowerCase()) &&
    !excluded.has((r.email || '').toLowerCase());
  for (const r of all) {
    if (!isValidLead(r)) continue;
    const k = r.email.toLowerCase();
    if (seen.has(k)) continue;
    selected.push(r); seen.add(k);
    if (selected.length >= count) break;
  }
  return { selected, kw_avail: all.length };
}

function buildText(city, email, foundingRemaining) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  const spotsText = typeof foundingRemaining === 'number'
    ? `${foundingRemaining} of ${FOUNDING_COHORT_CAP} spots left`
    : `${FOUNDING_COHORT_CAP} founding spots at $29/mo`;
  return `It's 6:47pm Thursday in ${city} and you're still in the car.

The lender kicked back another required-repair list. Your seller wants an option-period amendment out tonight. That second appraisal is still "pending review." And there's an offer you owe back on a different file.

I'm a working KW agent - I've sat in that exact parking lot. So I built Dossie to handle the tracking, drafting, and reminder layer of those moments. She queues the amendment, watches the appraisal clock, drafts the repair-response email. You stay on the negotiation.

13 Texas agents are already on. Brittney closed 49 deals with her.

Worth a reply if that sounds like a normal week?

- Heath
KW City View / KW Boerne

P.S. Founding rate $29/mo, locked for the life of your subscription. ${spotsText}. If it's not for you, no worries - just reply "not now". ${FOUNDING_URL}

---
Unsubscribe: ${unsub}
${NW_ADDRESS}
`;
}

function buildHtml(city, email, foundingRemaining) {
  const unsub = `${UNSUB_URL}?email=${encodeURIComponent(email)}`;
  const spotsText = typeof foundingRemaining === 'number'
    ? `${foundingRemaining} of ${FOUNDING_COHORT_CAP} spots left`
    : `${FOUNDING_COHORT_CAP} founding spots at $29/mo`;
  return `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-size: 15px; line-height: 1.5; color: #1a1a1a; max-width: 560px;">
<p>It's 6:47pm Thursday in ${city} and you're still in the car.</p>

<p>The lender kicked back another required-repair list. Your seller wants an option-period amendment out tonight. That second appraisal is still "pending review." And there's an offer you owe back on a different file.</p>

<p>I'm a working KW agent - I've sat in that exact parking lot. So I built Dossie to handle the tracking, drafting, and reminder layer of those moments. She queues the amendment, watches the appraisal clock, drafts the repair-response email. You stay on the negotiation.</p>

<p>13 Texas agents are already on. Brittney closed 49 deals with her.</p>

<p>Worth a reply if that sounds like a normal week?</p>

<p>- Heath<br>
KW City View / KW Boerne</p>

<p style="color: #555;">P.S. Founding rate $29/mo, locked for the life of your subscription. ${spotsText}. If it's not for you, no worries - just reply "not now". <a href="${FOUNDING_URL}">Founding details</a>.</p>

<hr style="border: none; border-top: 1px solid #e5e5e5; margin: 24px 0 12px;">
<p style="font-size: 11px; color: #888;">
<a href="${unsub}" style="color: #888;">Unsubscribe</a> | ${NW_ADDRESS}
</p>
</div>`;
}

function sbHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function getDailyTarget(now) {
  // Find the highest-week_num row whose week_start <= today.
  const today = now.toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/cold_email_cadence?week_start=lte.${today}&order=week_num.desc&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`cadence lookup failed: ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) {
    // No config yet — fall back to 10 (week-1 default). Log a warning.
    console.warn('[daily-batch] no cadence row for', today, '— defaulting to 10');
    return { daily_target: 10, week_num: 0, fallback: true };
  }
  return rows[0];
}

// Fetch every to_email that's ever been in the queue OR on the suppression
// list. One roundtrip each; we build a Set for O(1) exclusion checks.
async function loadExclusionSet() {
  const excluded = new Set();
  // Existing queue
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?select=to_email&order=created_at.asc&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`queue scan failed: ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach(x => { if (x && x.to_email) excluded.add(String(x.to_email).toLowerCase()); });
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  // Suppression list
  const sUrl = `${SUPABASE_URL}/rest/v1/email_suppression_list?select=email&limit=5000`;
  const sr = await fetch(sUrl, { headers: sbHeaders() });
  if (sr.ok) {
    const rows = await sr.json();
    if (Array.isArray(rows)) rows.forEach(x => { if (x && x.email) excluded.add(String(x.email).toLowerCase()); });
  }
  return excluded;
}

async function selectLeads(count, excluded) {
  const all = loadLeads();
  const selected = [];
  const seen = new Set();

  const isValidLead = r =>
    isValidEmail(r.email) &&
    !KNOWN_BOUNCES.has((r.email || '').toLowerCase()) &&
    !excluded.has((r.email || '').toLowerCase());

  // Tier 1: ZenRows-verified existing emails (highest deliverability signal).
  const tier1 = all.filter(r =>
    r.confidence_tier === 'tier_b_zenrows_no_phone' &&
    r.email_source === 'existing' &&
    isValidLead(r)
  );

  // Tier 2: ZenRows-scoped + any brokerage-scoped pattern guess (kw, exp, jpar,
  // etc). Broader than v3's KW-only rule — small pattern-guess pools starve
  // the ramp within a week. Deliverability is comparable to KW across major
  // brokerages we've probed.
  const tier2 = all.filter(r =>
    r.confidence_tier === 'tier_b_zenrows_no_phone' &&
    typeof r.email_source === 'string' &&
    r.email_source.startsWith('pattern_guess:') &&
    isValidLead(r)
  );

  // Tier 3: TREC-scoped pattern guess (much larger pool: 4200+). Lower
  // deliverability signal than Tier 1/2 but the volume is what unblocks the
  // ramp beyond ~week 1. Reserve for when Tier 1+2 exhausted.
  const tier3 = all.filter(r =>
    r.confidence_tier === 'tier_c_trec_pattern_guess' &&
    isValidLead(r)
  );

  const take = (pool) => {
    for (const r of pool) {
      const k = r.email.toLowerCase();
      if (seen.has(k)) continue;
      selected.push(r); seen.add(k);
      if (selected.length >= count) return true;
    }
    return false;
  };

  take(tier1) || take(tier2) || take(tier3);

  return {
    selected,
    tier1_avail: tier1.length,
    tier2_avail: tier2.length,
    tier3_avail: tier3.length,
  };
}

// KW touch-2 exclusion: only suppression list (allows re-contacting touch-1
// recipients, which is the entire point of a touch-2 blast).
async function loadKwExclusionSet() {
  const excluded = new Set();
  const sUrl = `${SUPABASE_URL}/rest/v1/email_suppression_list?select=email&limit=5000`;
  const sr = await fetch(sUrl, { headers: sbHeaders() });
  if (sr.ok) {
    const rows = await sr.json();
    if (Array.isArray(rows)) rows.forEach(x => { if (x && x.email) excluded.add(String(x.email).toLowerCase()); });
  }
  return excluded;
}

async function insertRow(row) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue`;
  const r = await fetch(url, {
    method: 'POST',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`insert failed: ${r.status} ${text.slice(0, 200)}`);
  }
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows[0] ? rows[0].id : null;
}

async function batchAlreadyExists(batchId) {
  const q = encodeURIComponent(`{"batch":"${batchId}"}`);
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?metadata=cs.${q}&select=id&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return false; // fail-open: better to send-again than not-at-all
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function handler(req, res) {
  // Optional query overrides for staging APV.
  const forceDryRun = req.query && (req.query.dry === '1' || req.query.dry === 'true');
  const forceRun    = req.query && (req.query.force === '1' || req.query.force === 'true');
  // Date-override for staging APV — ONLY honored when dry=1 so it can never
  // trigger real inserts with a fabricated date. Format YYYY-MM-DD.
  const dateOverride = req.query && typeof req.query.today === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(req.query.today) ? req.query.today : null;

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
  }

  const startedAt = Date.now();
  const now = new Date();
  // Effective "today" = dateOverride when present and dry-run, else real UTC date.
  const today = (dateOverride && forceDryRun) ? dateOverride : now.toISOString().slice(0, 10);
  // Recompute dow from effective today (UTC-based Date parse).
  const dow = (dateOverride && forceDryRun) ? new Date(today + 'T00:00:00Z').getUTCDay() : now.getUTCDay();
  const batchId = `daily-${today}`;
  const isKwOverride = KW_OVERRIDE_DATES.has(today);

  // Weekend skip (unless force=1 OR KW override date — currently no override
  // dates armed; KW touch-2 disarmed 2026-07-09 per fact-check).
  if (!forceRun && !isKwOverride && (dow === 0 || dow === 6)) {
    return res.status(200).json({ ok: true, skipped: 'weekend', dow });
  }

  try {
    clearCache();

    // Idempotent day-skip: if today's batch already exists, bail out.
    if (!forceRun && await batchAlreadyExists(batchId)) {
      recordCronRun('cron-cold-email-daily-batch', 'ok', {
        skipped: 'batch_already_queued', batch: batchId,
      }).catch(() => {});
      return res.status(200).json({ ok: true, skipped: 'batch_already_queued', batch: batchId });
    }

    // ── KW touch-2 override branch (2026-07-10 only) ────────────────────
    if (isKwOverride) {
      const excluded = await loadKwExclusionSet();
      const { selected, kw_avail } = selectKwLeads(KW_OVERRIDE_TARGET, excluded, today);

      const sendAfter = new Date(now);
      sendAfter.setUTCHours(15, 0, 0, 0);

      const result = {
        batch: batchId,
        target: KW_OVERRIDE_TARGET,
        selected: selected.length,
        queued: 0,
        suppressed: 0,
        errors: 0,
        kw_avail,
        send_after: sendAfter.toISOString(),
        dry_run: !!forceDryRun,
        campaign: KW_OVERRIDE_CAMPAIGN,
        override: 'kw-only-touch2',
      };

      for (const lead of selected) {
        const to = String(lead.email).trim().toLowerCase();
        if (await isSuppressed(to, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)) {
          result.suppressed += 1;
          continue;
        }
        const firstName = titleFirstName(lead.name);
        const row = {
          to_email: to,
          from_email: FROM_EMAIL,
          subject: KW_OVERRIDE_SUBJECT,
          body_text: buildKwText(firstName, to),
          body_html: buildKwHtml(firstName, to),
          reply_to: REPLY_TO,
          status: 'pending',
          metadata: {
            send_after: sendAfter.toISOString(),
            campaign: KW_OVERRIDE_CAMPAIGN,
            batch: batchId,
            touch: 2,
            hook: 'docusign-migration-window',
            first_name: firstName,
            city: cityOrDefault(lead.city),
            brokerage: (lead.brokerage || '').trim(),
            confidence_tier: lead.confidence_tier,
            email_source: lead.email_source,
            queued_by: 'cron-cold-email-daily-batch',
            override: 'kw-only-touch2',
          },
        };
        if (forceDryRun) { result.queued += 1; continue; }
        try {
          await insertRow(row);
          result.queued += 1;
        } catch (err) {
          result.errors += 1;
          console.warn('[daily-batch-kw] insert failed', to, err && err.message);
        }
      }

      const duration_ms = Date.now() - startedAt;
      recordCronRun('cron-cold-email-daily-batch', 'ok', { duration_ms, ...result }).catch(() => {});
      return res.status(200).json({ ok: true, duration_ms, ...result });
    }

    const cadence = await getDailyTarget(now);
    const dailyTarget = Math.max(0, cadence.daily_target || 0);
    if (dailyTarget === 0) {
      return res.status(200).json({ ok: true, skipped: 'daily_target=0', cadence });
    }

    // Per-week day-of-week skip list. Week 1 skips Monday because Heath's
    // batch-3 blast already fired Mon 2026-07-06; ramp is Tue-Fri only.
    const skipDow = Array.isArray(cadence.skip_dow) ? cadence.skip_dow : [];
    if (!forceRun && skipDow.includes(dow)) {
      recordCronRun('cron-cold-email-daily-batch', 'ok', {
        skipped: 'skip_dow_configured', dow, week_num: cadence.week_num,
      }).catch(() => {});
      return res.status(200).json({
        ok: true, skipped: 'skip_dow_configured', dow, week_num: cadence.week_num,
      });
    }

    const excluded = await loadExclusionSet();
    const { selected, tier1_avail, tier2_avail, tier3_avail } = await selectLeads(dailyTarget, excluded);

    // send_after = today at 15:00 UTC (10:00 CDT) — 1h after 09:00 CDT cron fire.
    const sendAfter = new Date(now);
    sendAfter.setUTCHours(15, 0, 0, 0);

    // Live founding-spots count (was hardcoded "37 of 50" — leaked stale value
    // into cold-email P.S. after cohort cap changed from 50 → 25 on 2026-07-09).
    const foundingRemaining = await getFoundingRemaining();

    const result = {
      batch: batchId,
      target: dailyTarget,
      selected: selected.length,
      queued: 0,
      suppressed: 0,
      errors: 0,
      tier1_avail,
      tier2_avail,
      tier3_avail,
      send_after: sendAfter.toISOString(),
      dry_run: !!forceDryRun,
      week_num: cadence.week_num,
    };

    for (const lead of selected) {
      const to = String(lead.email).trim().toLowerCase();
      // Belt-and-suspenders suppression re-check per lead.
      if (await isSuppressed(to, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)) {
        result.suppressed += 1;
        continue;
      }
      const city = cityOrDefault(lead.city);
      const row = {
        to_email: to,
        from_email: FROM_EMAIL,
        subject: SUBJECT,
        body_text: buildText(city, to, foundingRemaining),
        body_html: buildHtml(city, to, foundingRemaining),
        reply_to: REPLY_TO,
        status: 'pending',
        metadata: {
          send_after: sendAfter.toISOString(),
          campaign: 'sa-cold-daily-warmup',
          batch: batchId,
          touch: 1,
          hook: '2-brutal-thursday-evening',
          subject_variant: 'B',
          first_name: titleFirstName(lead.name),
          city,
          brokerage: (lead.brokerage || '').trim(),
          confidence_tier: lead.confidence_tier,
          email_source: lead.email_source,
          queued_by: 'cron-cold-email-daily-batch',
          week_num: cadence.week_num,
        },
      };
      if (forceDryRun) { result.queued += 1; continue; }
      try {
        await insertRow(row);
        result.queued += 1;
      } catch (err) {
        result.errors += 1;
        console.warn('[daily-batch] insert failed', to, err && err.message);
      }
    }

    const duration_ms = Date.now() - startedAt;
    recordCronRun('cron-cold-email-daily-batch', 'ok', { duration_ms, ...result }).catch(() => {});
    return res.status(200).json({ ok: true, duration_ms, ...result });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const msg = (err && err.message) ? err.message.slice(0, 500) : 'crash';
    recordCronRun('cron-cold-email-daily-batch', 'error', { duration_ms, error: msg }).catch(() => {});
    return res.status(500).json({ ok: false, error: msg, duration_ms });
  }
}

module.exports = handler;
module.exports.default = handler;
