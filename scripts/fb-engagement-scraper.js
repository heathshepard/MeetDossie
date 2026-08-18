'use strict';

// scripts/fb-engagement-scraper.js
//
// Extends the group-listening system (fb-lead-scraper.js) with Heath's real
// ask (2026-08-17): don't just fire a generic lead alert -- find real,
// relevant comments/posts in the target groups, capture the actual text +
// author + permalink + surrounding thread context, DRAFT a genuine reply in
// Heath's own voice, and hold it for approval. Never auto-posts a comment.
//
// Why this exists separately from fb-lead-scraper.js: that script only
// evaluates `div[role="article"]` ONCE after scrolling, which lets FB's
// virtualized feed empty out text from posts that scrolled past -- that is
// very likely why it found 0 leads across 36 groups even with broadened
// keyword patterns (confirmed live 2026-08-17: extracting BEFORE each
// scroll step, instead of once at the end, recovers real comment text FB
// had virtualized away). This script extracts incrementally for that reason.
// It also captures COMMENT-level `div[role="article"]` nodes (FB reuses the
// same role for comments), not just top-level posts -- comments are exactly
// what Heath asked to engage with.
//
// Usage:
//   node scripts/fb-engagement-scraper.js [--groups=N] [--dry-run]
//
// Env vars required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
//   PLAYWRIGHT_PROFILE_DIR, PLAYWRIGHT_PROFILE_NAME (DossieBot Chrome profile)
//
// Never auto-posts. Rows land in `engagement_queue` at status='pending_review'
// -- api/cron-engagement-review.js surfaces them to Heath via Telegram.

const path = require('path');
const os = require('os');
const fs = require('fs');

try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const GROUPS_ARG = args.find((a) => a.startsWith('--groups='));
const MAX_GROUPS = GROUPS_ARG ? parseInt(GROUPS_ARG.split('=')[1], 10) : 8;

// Reuses the same broadened keyword set as fb-lead-scraper.js (TC pain,
// paperwork overwhelm, solo-agent burnout, TREC/transaction-assistant asks)
// PLUS a broader "engagement" layer for genuine real-estate-practice
// questions a knowledgeable agent could answer helpfully with no pitch at
// all -- commission structure, listing agreements, disclosures, contract
// mechanics. That second layer is what actually found today's real example.
const RELEVANCE_PATTERNS = [
  String.raw`\b(my|our|the)\s+(tc|transaction coordinator)\b`,
  String.raw`\btc\s+(quit|flaked|ghosted|dropped|missed|bailed)`,
  String.raw`\bfir(ed|ing)?\s+(my\s+)?tc\b`,
  String.raw`\b(looking for|need|recommend|anyone (use|know)|switching)\s+(a\s+)?(new\s+)?tc\b`,
  String.raw`\boverwhelm(ed|ing)?\b`,
  String.raw`\bdrowning in (paperwork|contracts|files|deadlines)\b`,
  String.raw`\bburied in (paperwork|contracts|files|deadlines)\b`,
  String.raw`\bmissed (a |the )?deadline`,
  String.raw`\btrec forms\b`,
  String.raw`\btrec deadlines\b`,
  String.raw`\bcontract deadlines\b`,
  String.raw`\boption period\b`,
  String.raw`\bearnest money (deadline|due)\b`,
  String.raw`\bsolo agent\b`,
  String.raw`\bno assistant\b`,
  // ── genuine practice questions, no pain framing required ──
  String.raw`\b(listing|buyer['’]?s?) (agreement|agent) .{0,40}(commission|fee|split|percent|%)\b`,
  String.raw`\bcommission (split|structure)\b`,
  String.raw`\b\d+(\.\d+)?%\s*(commission|listing|fee)\b`,
  String.raw`\b(disclosure|sdn|seller['’]?s? disclosure)\b.{0,40}\?`,
  String.raw`\bhow (do|does|is) .{0,40}(commission|earnest money|option period|closing)\b`,
  String.raw`\bjust a question\b`,
];

function loadSeen() {
  const SEEN_FILE = path.join(__dirname, '.engagement-scraper-seen.json');
  try {
    if (fs.existsSync(SEEN_FILE)) return { file: SEEN_FILE, set: new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))) };
  } catch { /* ignore */ }
  return { file: SEEN_FILE, set: new Set() };
}
function saveSeen(file, set) {
  try { fs.writeFileSync(file, JSON.stringify([...set]), 'utf8'); } catch (e) { console.warn('[fb-engagement-scraper] could not save seen file:', e.message); }
}

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function loadGroups() {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_registry?select=id,group_name,group_url&order=last_posted_at.asc.nullsfirst&limit=${MAX_GROUPS}`
  );
  if (!ok || !Array.isArray(data)) return [];
  return data.filter((g) => g.group_url && !g.group_url.includes('PLACEHOLDER'));
}

// Draft a genuine, contextual reply in Heath's voice. Short, direct, plain --
// never corporate/salesy, never a generic pitch. Falls back to a template if
// Anthropic isn't configured so the pipeline still produces something to
// review (worse draft, never worse than silence).
async function draftReply(candidate) {
  const prompt = `You are ghostwriting a Facebook comment reply for Heath Shepard, a Texas real estate agent (KW Boerne/San Antonio) who also built a TREC-compliance tool. He is replying inside a real estate agent Facebook group to this specific comment/post:

Group: ${candidate.groupName}
Original post/comment: "${candidate.text}"
${candidate.threadContext ? `Thread context: ${candidate.threadContext}` : ''}

Write ONLY the reply text, nothing else. Rules:
- Genuinely helpful and specific to what was actually asked/said -- not a generic pitch.
- Do NOT mention his product/tool/company unless the original text is literally about TC/paperwork overwhelm AND a natural, non-salesy mention fits.
- Heath's real voice: short (1-3 sentences), direct, plain language, no corporate tone, no exclamation-point enthusiasm, fragments are fine, no formal sign-off.
- If the honest answer is "it depends," say what it depends on plainly.`;

  if (!ANTHROPIC_API_KEY) {
    return { text: `[NO ANTHROPIC_API_KEY -- manual draft needed] Re: "${candidate.text.slice(0, 80)}"`, model: null };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data?.content?.[0]?.text?.trim();
    if (!text) throw new Error('empty response');
    return { text, model: data.model || 'claude-sonnet-4-5' };
  } catch (err) {
    console.warn('[fb-engagement-scraper] draft generation failed:', err.message);
    return { text: `[DRAFT GENERATION FAILED -- write manually] Re: "${candidate.text.slice(0, 80)}"`, model: null };
  }
}

async function extractCandidates(page) {
  return page.evaluate((patterns) => {
    const regexes = patterns.map((p) => new RegExp(p, 'i'));
    const articles = document.querySelectorAll('div[role="article"]');
    const out = [];
    for (const article of articles) {
      const text = (article.innerText || '').trim();
      if (text.length < 20) continue;
      let matchedPattern = null;
      for (let i = 0; i < regexes.length; i++) {
        if (regexes[i].test(text)) { matchedPattern = patterns[i]; break; }
      }
      if (!matchedPattern) continue;

      let permalink = null;
      const links = article.querySelectorAll('a[href*="/groups/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href && /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(href)) {
          permalink = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
          permalink = permalink.split('?')[0];
          break;
        }
      }

      let authorName = '';
      const nameEl = article.querySelector('h3 a, h4 a, strong a');
      if (nameEl) authorName = nameEl.innerText.trim();

      // Comment vs post: comments sit inside a "role=article" that's nested
      // under another one; top-level posts are not.
      const isNested = !!article.parentElement?.closest('div[role="article"]');

      out.push({
        text: text.slice(0, 1000),
        permalink,
        authorName,
        matchedPattern,
        contentType: isNested ? 'comment' : 'post',
      });
    }
    return out;
  }, RELEVANCE_PATTERNS);
}

async function scanGroup(page, group, seenIds) {
  const found = [];
  console.log(`[fb-engagement-scraper] Scanning ${group.group_name}`);
  await page.goto(group.group_url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
    console.warn(`[fb-engagement-scraper] goto failed for ${group.group_name}:`, e.message);
  });
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    console.warn('[fb-engagement-scraper] Redirected to login — skipping group');
    return found;
  }

  const seenThisGroup = new Map();
  // Extract BEFORE each scroll step -- FB virtualizes content that scrolls
  // out of view, so evaluating only once at the end (the old fb-lead-scraper
  // approach) silently loses text. This is the fix confirmed live 2026-08-17.
  for (let i = 0; i < 5; i++) {
    const batch = await extractCandidates(page).catch(() => []);
    for (const item of batch) {
      const key = item.text.slice(0, 80);
      if (!seenThisGroup.has(key)) seenThisGroup.set(key, item);
    }
    await page.evaluate(() => window.scrollBy(0, 900));
    await page.waitForTimeout(1800);
  }

  for (const item of seenThisGroup.values()) {
    const dedupeKey = `${group.group_name}::${item.text.slice(0, 80)}`;
    if (seenIds.has(dedupeKey)) continue;
    seenIds.add(dedupeKey);
    found.push({ ...item, groupName: group.group_name, groupUrl: group.group_url });
  }
  return found;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[fb-engagement-scraper] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }

  const { file: seenFile, set: seenIds } = loadSeen();
  const groups = await loadGroups();
  if (!groups.length) {
    console.log('[fb-engagement-scraper] No groups in group_registry');
    return;
  }

  const { chromium } = require('playwright');
  console.log(`[fb-engagement-scraper] Launching Chrome with DossieBot profile, scanning ${groups.length} group(s)${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();
  let totalCandidates = 0;
  let totalInserted = 0;

  try {
    for (const group of groups) {
      const candidates = await scanGroup(page, group, seenIds).catch((err) => {
        console.warn(`[fb-engagement-scraper] Error on ${group.group_name}:`, err.message);
        return [];
      });

      for (const candidate of candidates) {
        totalCandidates++;
        console.log(`[fb-engagement-scraper] Candidate (${candidate.contentType}) in ${candidate.groupName}: "${candidate.text.slice(0, 80)}"`);

        const draft = await draftReply({ groupName: candidate.groupName, text: candidate.text, threadContext: null });

        if (DRY_RUN) {
          console.log(`  -> DRAFT: ${draft.text}`);
          continue;
        }

        const insert = await supabaseFetch('/rest/v1/engagement_queue', {
          method: 'POST',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            source: 'facebook_group',
            group_name: candidate.groupName,
            group_url: candidate.groupUrl,
            content_type: candidate.contentType,
            author_name: candidate.authorName || null,
            original_text: candidate.text,
            permalink: candidate.permalink,
            matched_pattern: candidate.matchedPattern,
            drafted_reply: draft.text,
            draft_model: draft.model,
            status: 'pending_review',
          }),
        });
        if (insert.ok) totalInserted++;
        else console.warn('[fb-engagement-scraper] insert failed', insert.status, JSON.stringify(insert.data).slice(0, 200));
      }

      saveSeen(seenFile, seenIds);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally {
    await context.close();
  }

  console.log(`[fb-engagement-scraper] complete: ${totalCandidates} candidate(s) found, ${totalInserted} inserted across ${groups.length} group(s)`);
}

main().catch((err) => {
  console.error('[fb-engagement-scraper] Fatal error:', err.message);
  process.exit(1);
});
