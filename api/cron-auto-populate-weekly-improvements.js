// Vercel Serverless Function: /api/cron-auto-populate-weekly-improvements
//
// PURPOSE
//   Auto-populates WEEKLY-IMPROVEMENTS.md from yesterday's commits across BOTH
//   Dossie repos so the customer newsletter source-of-truth never goes stale.
//   The Thursday newsletter draft (cron-weekly-newsletter-draft) reads from
//   WEEKLY-IMPROVEMENTS.md on disk — if items don't land in the .md file, they
//   never reach the newsletter.
//
// WHAT IT DOES
//   1. Pulls commits from the last 24h from BOTH repos via GitHub API:
//        - heathshepard/MeetDossie (main + staging)
//        - heathshepard/DossieApp  (main + staging)
//   2. Filters out non-customer-facing patterns (chore:, refactor:, wip:, ci:,
//      atlas-runs/, agent infra, internal cron config, etc.)
//   3. For each remaining commit, asks Claude Haiku to:
//        - Decide if it's customer-facing
//        - If yes, rewrite as 1-2 sentence plain-English benefit
//        - Tag it (customer) | (both) | (internal)
//   4. Appends customer + both entries to WEEKLY-IMPROVEMENTS.md under the
//      current week's section header.
//   5. Commits the updated file back to MeetDossie via GitHub API.
//
// IDEMPOTENCY
//   Each week's section carries a hidden HTML comment tracking applied SHAs:
//      <!-- applied_shas: a1ea8f5,cc72b79,68d2266,... -->
//   Commits whose SHA is already listed are skipped on subsequent runs.
//
// BACKFILL MODE
//   GET /api/cron-auto-populate-weekly-improvements?backfill=2026-06-05..2026-06-12
//   Runs the same logic over the date range instead of yesterday.
//
// SCHEDULE
//   vercel.json: "0 23 * * *"  (23:00 UTC daily = 6 PM CDT / 7 PM CST)
//
// AUTH
//   Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
//
// REQUIRED ENV
//   CRON_SECRET
//   ANTHROPIC_API_KEY
//   GITHUB_TOKEN              — PAT with `repo` scope on heathshepard/MeetDossie + DossieApp
//                               If missing, the cron returns ok+skipped (no crash).
//
// OPTIONAL ENV
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  — only used on backfill completion
//
// COST MATH
//   ~20 commits/day × ~250 input + 150 output tokens each on Haiku 4.5
//   ≈ $0.001/day on Anthropic. Negligible. GitHub API is free.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

// Both repos to scan. Owner + repo slug.
const REPOS = [
  { owner: 'heathshepard', repo: 'MeetDossie' },
  { owner: 'heathshepard', repo: 'DossieApp' },
];

// Target file lives in MeetDossie main branch.
const TARGET_REPO = { owner: 'heathshepard', repo: 'MeetDossie' };
const TARGET_BRANCH = 'main';
const TARGET_PATH = 'WEEKLY-IMPROVEMENTS.md';

// ─── Filter: skip non-customer-facing commits before they hit Haiku ─────

// Subject-line patterns that are definitionally internal/infra and should never
// reach Haiku. Saves Haiku calls.
const SKIP_SUBJECT_PATTERNS = [
  /^chore[:(]/i,
  /^refactor[:(]/i,
  /^wip[:(]/i,
  /^test[:(]/i,
  /^ci[:(]/i,
  /^docs[:(]/i,
  /^style[:(]/i,
  /^build[:(]/i,
  /^atlas[\s-]?test/i,
  /^carter[\s-]?test/i,
  /^cole[\s-]?test/i,
  /^sage[\s-]?test/i,
  // GOLD tag commits themselves are markers, not changes
  /^gold-\d{4}-\d{2}-\d{2}/i,
  // Memory-only commits
  /^memory:/i,
  // CLAUDE.md / MEMORY.md updates only
  /update claude\.md/i,
  /update memory\.md/i,
];

// File-path patterns — if EVERY changed file matches one of these, the commit
// is internal-only and Haiku is skipped.
const INTERNAL_PATH_PATTERNS = [
  /^\.claude\//,
  /^scripts\/atlas-runs\//,
  /^scripts\/atlas-/,
  /\/agents\//,
  /^jarvis-cole\//,
  /^Engineering\//,
  /^docs\//,
  /CLAUDE\.md$/,
  /MEMORY\.md$/,
  /SESSION-DIARY\.md$/,
  /\.tmp/,
  /^WEEKLY-IMPROVEMENTS\.md$/, // changes to the file itself shouldn't recurse
];

function shouldSkipBySubject(subject) {
  if (!subject) return true;
  return SKIP_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

function shouldSkipByFiles(filesChanged) {
  if (!Array.isArray(filesChanged) || filesChanged.length === 0) {
    // No file info available — let Haiku decide.
    return false;
  }
  return filesChanged.every((f) => INTERNAL_PATH_PATTERNS.some((re) => re.test(f)));
}

// ─── GitHub REST helpers ────────────────────────────────────────────────

async function gh(path, init = {}) {
  if (!GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN not configured');
  }
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dossie-auto-populate-cron',
      ...(init.headers || {}),
    },
  });
  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!r.ok) {
    throw new Error(`GitHub ${path} ${r.status}: ${text.slice(0, 240)}`);
  }
  return data;
}

// Pull commits in window. Returns commits sorted oldest-first so we apply
// them in chronological order.
async function listCommits(owner, repo, sinceIso, untilIso) {
  const out = [];
  // Pull from main + staging (de-dupe by sha).
  const seen = new Set();
  for (const branch of ['main', 'staging']) {
    let page = 1;
    // Hard cap pagination to avoid runaway.
    while (page <= 5) {
      const qs = new URLSearchParams({
        sha: branch,
        since: sinceIso,
        until: untilIso,
        per_page: '100',
        page: String(page),
      }).toString();
      let pageData;
      try {
        pageData = await gh(`/repos/${owner}/${repo}/commits?${qs}`);
      } catch (err) {
        // Branch may not exist — skip.
        if (/422|404/.test(String(err.message))) break;
        throw err;
      }
      if (!Array.isArray(pageData) || pageData.length === 0) break;
      for (const c of pageData) {
        if (!c.sha || seen.has(c.sha)) continue;
        seen.add(c.sha);
        out.push(c);
      }
      if (pageData.length < 100) break;
      page += 1;
    }
  }
  // Sort oldest first.
  out.sort((a, b) => {
    const ta = new Date(a.commit?.author?.date || 0).getTime();
    const tb = new Date(b.commit?.author?.date || 0).getTime();
    return ta - tb;
  });
  return out;
}

// Pull file list for a given commit (lightweight).
async function getCommitFiles(owner, repo, sha) {
  try {
    const data = await gh(`/repos/${owner}/${repo}/commits/${sha}`);
    return (data.files || []).map((f) => f.filename).filter(Boolean);
  } catch {
    return [];
  }
}

// Read the current WEEKLY-IMPROVEMENTS.md (returns content + sha for commit).
async function readTargetFile() {
  const data = await gh(
    `/repos/${TARGET_REPO.owner}/${TARGET_REPO.repo}/contents/${encodeURIComponent(TARGET_PATH)}?ref=${TARGET_BRANCH}`,
  );
  const buf = Buffer.from(data.content || '', 'base64');
  return { content: buf.toString('utf8'), sha: data.sha };
}

// Commit updated content back to the target file.
async function writeTargetFile(newContent, baseSha, message) {
  const encoded = Buffer.from(newContent, 'utf8').toString('base64');
  return gh(`/repos/${TARGET_REPO.owner}/${TARGET_REPO.repo}/contents/${encodeURIComponent(TARGET_PATH)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: encoded,
      branch: TARGET_BRANCH,
      sha: baseSha,
      committer: { name: 'Atlas Auto-Populate', email: 'atlas@meetdossie.com' },
      author: { name: 'Atlas Auto-Populate', email: 'atlas@meetdossie.com' },
    }),
  });
}

// ─── Anthropic ──────────────────────────────────────────────────────────

function buildClassifyPrompt({ subject, body, filesChanged, repo }) {
  const fileList = (filesChanged || []).slice(0, 30).join('\n') || '(no file info)';
  const bodyText = (body || '').slice(0, 1200);
  return `You categorize a Dossie engineering commit for a customer-facing changelog (WEEKLY-IMPROVEMENTS.md), read by Texas real estate agents.

A) Is this CUSTOMER-FACING? It is customer-facing only if it changes something a paying real estate agent customer can SEE or USE in the Dossie app, marketing site, or in emails Dossie sends them. Examples that ARE customer-facing: new forms, new dossier sections, mobile UI fixes, Talk-to-Dossie improvements, fill-and-sign, deadline reminders, customer email content, new pricing/founding-flow tweaks, calculator changes.

Examples that are NOT customer-facing: agent orchestration infra (Cole/Sage/Atlas/Pierce/Hadley/Carter), cron schedule tweaks, internal dashboards Heath uses (Ventures dashboard), social media auto-post infra, FB/Reddit scraping/comment automation, memory file edits, test scripts, content-generation pipelines for socials, watchdog/QA loops, refactors with no visible behavior change, dependency bumps, internal telemetry/audit logging, GitHub Actions, env var changes, build pipeline fixes.

B) If customer-facing, rewrite as 1-2 sentence plain-English benefit. Lead with the benefit, not the implementation. Use "we" instead of "I". No jargon ("bundle", "API", "useEffect", "z-index", "Vite", "Vercel", "TypeScript", "endpoint", "schema", "RLS", "Supabase"). Plain ASCII only — straight hyphens, straight quotes, no em-dashes/en-dashes/curly quotes.

C) Tag as exactly one of:
   "(customer)"  — pure customer-facing, agents will notice this
   "(both)"      — internal change WITH a small customer-visible improvement
   "(internal)"  — no customer impact (skip from changelog)

Return STRICT JSON, no markdown fence, no commentary:

{
  "customer_facing": true|false,
  "tag": "(customer)" | "(both)" | "(internal)",
  "title": "Short bold title for the entry (3-8 words, sentence case)",
  "body": "1-2 sentence plain-English benefit. Empty string if internal."
}

If customer_facing is false, set tag="(internal)", title="", body="".

Repo: ${repo}
Commit subject: ${subject}
Commit body:
"""
${bodyText}
"""
Files changed (up to 30):
${fileList}`;
}

async function classifyCommit(commit, filesChanged, repoSlug) {
  const subject = (commit.commit?.message || '').split('\n')[0];
  const bodyOnly = (commit.commit?.message || '').split('\n').slice(1).join('\n').trim();
  const prompt = buildClassifyPrompt({
    subject,
    body: bodyOnly,
    filesChanged,
    repo: repoSlug,
  });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Anthropic ${r.status}: ${text.slice(0, 240)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Anthropic non-JSON response'); }
  const content = data?.content?.[0]?.text || '';
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(stripped); } catch (e) {
    // Haiku returned something weird — treat as internal so we don't pollute the file.
    return { customer_facing: false, tag: '(internal)', title: '', body: '' };
  }
  // Defensive coerce.
  return {
    customer_facing: !!parsed.customer_facing,
    tag: ['(customer)', '(both)', '(internal)'].includes(parsed.tag) ? parsed.tag : '(internal)',
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
  };
}

// ─── WEEKLY-IMPROVEMENTS.md mutator ────────────────────────────────────

// Compute Monday of the week containing the given Date, in UTC.
function mondayOfWeek(d) {
  const day = d.getUTCDay(); // 0=Sun ... 6=Sat
  const offsetToMonday = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offsetToMonday));
}

function formatWeekHeader(monday) {
  const months = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];
  return `Week of ${months[monday.getUTCMonth()]} ${monday.getUTCDate()}, ${monday.getUTCFullYear()}`;
}

// Heath's existing weeks anchor on different days (some Friday, some Monday).
// Rather than fight that, we treat the TOPMOST `## Week of …` section as
// "the current week" if the parsed date is within `windowDays` of the
// commit-window end date. Otherwise we create a new section.
const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseWeekHeaderDate(rawHeader) {
  // Examples we tolerate:
  //   "Week of June 5, 2026"
  //   "Week of May 29, 2026 (continued)"
  //   "Week of May 13–20, 2026"  (en-dash range — use the FIRST date)
  //   "Week of May 13-20, 2026"  (hyphen range)
  const m = rawHeader.match(/Week of\s+([A-Za-z]+)\s+(\d{1,2})(?:[–—\-]\d{1,2})?,\s+(\d{4})/);
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  if (!(monthName in MONTH_NAMES)) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (Number.isNaN(day) || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, MONTH_NAMES[monthName], day));
}

// Find the section for an explicit header.
function findWeekSection(fileText, weekHeader) {
  const lines = fileText.split('\n');
  const headerPrefix = `## ${weekHeader}`;
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(headerPrefix)) { startIdx = i; break; }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }
  return { startIdx, endIdx, sectionLines: lines.slice(startIdx, endIdx) };
}

// Find the TOPMOST `## Week of …` section. Returns { rawHeader, startIdx,
// endIdx, sectionLines, anchorDate } or null.
function findTopWeekSection(fileText) {
  const lines = fileText.split('\n');
  let startIdx = -1;
  let rawHeader = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(Week of[^\n]+)/);
    if (m) {
      startIdx = i;
      rawHeader = m[1].trim();
      break;
    }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) { endIdx = i; break; }
  }
  const anchorDate = parseWeekHeaderDate(rawHeader);
  return { rawHeader, startIdx, endIdx, sectionLines: lines.slice(startIdx, endIdx), anchorDate };
}

// Decide which header to write under for an anchor date.
//   - If a top section exists and its anchor is within 14 days of windowAnchor,
//     append to that existing header.
//   - Otherwise create a new section with this week's Monday-anchored header.
function resolveTargetSection(fileText, windowAnchorDate) {
  const top = findTopWeekSection(fileText);
  if (top && top.anchorDate) {
    const diffDays = Math.abs(windowAnchorDate.getTime() - top.anchorDate.getTime()) / (24 * 60 * 60 * 1000);
    if (diffDays <= 14) {
      return { header: top.rawHeader, mode: 'append', existing: top };
    }
  }
  const newHeader = formatWeekHeader(mondayOfWeek(windowAnchorDate));
  return { header: newHeader, mode: 'create', existing: null };
}

// Extract applied SHA list from a hidden HTML comment in the section.
function extractAppliedShas(sectionLines) {
  for (const ln of sectionLines) {
    const m = ln.match(/<!--\s*applied_shas:\s*([^>]+?)\s*-->/i);
    if (m) {
      return new Set(
        m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
      );
    }
  }
  return new Set();
}

function buildAppliedShasComment(shaSet) {
  const arr = Array.from(shaSet).sort();
  return `<!-- applied_shas: ${arr.join(',')} -->`;
}

// Insert new entries + updated SHA comment into a week section.
// Strategy:
//   - Strip any existing applied_shas comment.
//   - Append new entries at the bottom of the section (before the trailing
//     blank lines and any "---" delimiter — which lives OUTSIDE the section in
//     our line-slice convention because the delimiter sits between sections).
//   - Append the refreshed applied_shas comment as the final line of the
//     section.
function rewriteWeekSection(sectionLines, newEntries, newShaSet) {
  // Drop any pre-existing applied_shas comment lines.
  let cleaned = sectionLines.filter((ln) => !/<!--\s*applied_shas:/i.test(ln));
  // Trim trailing blank lines.
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
    cleaned.pop();
  }
  // Append entries.
  for (const e of newEntries) {
    cleaned.push('');
    cleaned.push(`**${e.title}** ${e.tag}`);
    cleaned.push(`- ${e.body}`);
  }
  cleaned.push('');
  cleaned.push(buildAppliedShasComment(newShaSet));
  cleaned.push('');
  return cleaned;
}

// Insert a brand-new week section at the top of the changelog (right after
// the preamble + before the first existing "## Week of …" section).
function insertNewWeekSection(fileText, weekHeader, newEntries, newShaSet) {
  const lines = fileText.split('\n');
  // Find first "## Week of …" line.
  let firstWeekIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Week of/.test(lines[i])) { firstWeekIdx = i; break; }
  }
  // Find preceding "---" delimiter so we keep the structure.
  // We'll insert the new section + a trailing "---" right before the existing
  // first week section.
  const insertAt = firstWeekIdx === -1 ? lines.length : firstWeekIdx;

  const section = [];
  section.push(`## ${weekHeader}`);
  section.push('');
  for (const e of newEntries) {
    section.push(`**${e.title}** ${e.tag}`);
    section.push(`- ${e.body}`);
    section.push('');
  }
  section.push(buildAppliedShasComment(newShaSet));
  section.push('');
  section.push('---');
  section.push('');

  const out = lines.slice(0, insertAt).concat(section).concat(lines.slice(insertAt));
  return out.join('\n');
}

// Apply a set of NEW entries to the file. `target` comes from
// resolveTargetSection. Returns new file content.
function applyEntriesToFile(fileText, target, entries, alreadyAppliedShas) {
  const newShaSet = new Set(alreadyAppliedShas);
  for (const e of entries) newShaSet.add(e.sha);

  if (target.mode === 'append' && target.existing) {
    const rewritten = rewriteWeekSection(target.existing.sectionLines, entries, newShaSet);
    const lines = fileText.split('\n');
    const out = lines.slice(0, target.existing.startIdx).concat(rewritten).concat(lines.slice(target.existing.endIdx));
    return out.join('\n');
  }
  return insertNewWeekSection(fileText, target.header, entries, newShaSet);
}

// ─── Date window resolution ─────────────────────────────────────────────

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function parseBackfillRange(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  const start = new Date(`${m[1]}T00:00:00Z`);
  const end = new Date(`${m[2]}T23:59:59Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

// ─── Telegram (used only for backfill completion) ────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch {}
}

// ─── Handler ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
    }
    if (!GITHUB_TOKEN) {
      // Don't crash — the cron is harmless when un-configured. Heath flips the
      // env var when ready.
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'GITHUB_TOKEN not configured — add a PAT with repo scope on heathshepard/MeetDossie + DossieApp to enable.',
      });
    }

    const now = new Date();
    const backfillParam = (req.query && req.query.backfill) || null;
    const dryRun = (req.query && req.query.dryRun === '1') || false;
    const backfillRange = parseBackfillRange(backfillParam);

    // Resolve commit-fetch window.
    let sinceIso, untilIso, weekAnchor;
    if (backfillRange) {
      sinceIso = backfillRange.start.toISOString();
      untilIso = backfillRange.end.toISOString();
      // Backfill writes to the week containing the END date.
      weekAnchor = backfillRange.end;
    } else {
      // Daily run: last 24h ending now. Week = current week.
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      sinceIso = yesterday.toISOString();
      untilIso = now.toISOString();
      weekAnchor = now;
    }

    // 1. Pull commits from both repos.
    const allCommits = [];
    for (const r of REPOS) {
      const cs = await listCommits(r.owner, r.repo, sinceIso, untilIso);
      for (const c of cs) {
        allCommits.push({ ...c, _repo: `${r.owner}/${r.repo}` });
      }
    }

    // 2. Load current WEEKLY-IMPROVEMENTS.md and resolve which section we
    //    write under. If the topmost existing week section is within 14 days
    //    of the window anchor, we append to it (handles Heath's mixed
    //    Mon/Fri/Sun anchoring). Otherwise we open a fresh Monday-anchored
    //    section.
    const target = await readTargetFile();
    const sectionTarget = resolveTargetSection(target.content, weekAnchor);
    const weekHeader = sectionTarget.header;
    const alreadyApplied = sectionTarget.existing
      ? extractAppliedShas(sectionTarget.existing.sectionLines)
      : new Set();

    // 3. Filter + classify.
    const accepted = [];
    const stats = {
      total_commits: allCommits.length,
      filtered_by_subject: 0,
      filtered_by_files: 0,
      already_applied: 0,
      classified_internal: 0,
      classified_customer: 0,
      classified_both: 0,
      haiku_errors: 0,
    };

    for (const c of allCommits) {
      const shortSha = (c.sha || '').slice(0, 7).toLowerCase();
      const subject = (c.commit?.message || '').split('\n')[0];

      if (alreadyApplied.has(shortSha)) {
        stats.already_applied += 1;
        continue;
      }
      if (shouldSkipBySubject(subject)) {
        stats.filtered_by_subject += 1;
        continue;
      }

      // Get files (small repo, cheap call).
      const repoParts = c._repo.split('/');
      const files = await getCommitFiles(repoParts[0], repoParts[1], c.sha);
      if (shouldSkipByFiles(files)) {
        stats.filtered_by_files += 1;
        continue;
      }

      let classified;
      try {
        classified = await classifyCommit(c, files, c._repo);
      } catch (err) {
        console.error('[auto-populate] Haiku error', c.sha, err.message);
        stats.haiku_errors += 1;
        continue;
      }

      if (!classified.customer_facing || classified.tag === '(internal)') {
        stats.classified_internal += 1;
        continue;
      }
      if (!classified.title || !classified.body) {
        stats.classified_internal += 1;
        continue;
      }

      if (classified.tag === '(customer)') stats.classified_customer += 1;
      else if (classified.tag === '(both)') stats.classified_both += 1;

      accepted.push({
        sha: shortSha,
        repo: c._repo,
        subject,
        tag: classified.tag,
        title: classified.title,
        body: classified.body,
      });
    }

    // 4. If nothing accepted, no-op (but record that we ran).
    if (accepted.length === 0) {
      return res.status(200).json({
        ok: true,
        ran_at: now.toISOString(),
        week_header: weekHeader,
        window: { since: sinceIso, until: untilIso },
        applied: 0,
        stats,
        message: 'No new customer-facing commits in window.',
      });
    }

    // 5. Build the new file content.
    const newContent = applyEntriesToFile(target.content, sectionTarget, accepted, alreadyApplied);

    if (dryRun) {
      return res.status(200).json({
        ok: true,
        dryRun: true,
        week_header: weekHeader,
        applied: accepted.length,
        entries: accepted,
        stats,
        diff_preview: newContent.slice(0, 4000),
      });
    }

    // 6. Commit back to MeetDossie main.
    const commitMessage = backfillRange
      ? `Auto-populate WEEKLY-IMPROVEMENTS.md: backfill ${isoDay(backfillRange.start)}..${isoDay(backfillRange.end)} (${accepted.length} entries)`
      : `Auto-populate WEEKLY-IMPROVEMENTS.md: ${isoDay(now)} daily run (${accepted.length} entries)`;
    await writeTargetFile(newContent, target.sha, commitMessage);

    // 7. Telegram ping (backfill only — daily run is silent).
    if (backfillRange) {
      const summary = accepted.map((e) => `- ${e.title} ${e.tag}`).join('\n').slice(0, 1500);
      await sendTelegram(
        `<b>WEEKLY-IMPROVEMENTS.md backfill complete</b>\n` +
        `Range: ${isoDay(backfillRange.start)}..${isoDay(backfillRange.end)}\n` +
        `Week: ${weekHeader}\n` +
        `Added: ${accepted.length} entries\n\n` +
        `<pre>${summary}</pre>`,
      );
    }

    return res.status(200).json({
      ok: true,
      ran_at: now.toISOString(),
      backfill: !!backfillRange,
      week_header: weekHeader,
      window: { since: sinceIso, until: untilIso },
      applied: accepted.length,
      entries: accepted.map((e) => ({ sha: e.sha, tag: e.tag, title: e.title })),
      stats,
    });
  } catch (err) {
    console.error('[cron-auto-populate-weekly-improvements] fatal', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
