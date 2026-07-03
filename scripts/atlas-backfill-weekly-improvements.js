#!/usr/bin/env node
// One-time backfill for WEEKLY-IMPROVEMENTS.md covering June 5-12 2026.
//
// Uses LOCAL git (both repos) instead of GitHub API since we have direct
// filesystem access. Same classification logic as
// api/cron-auto-populate-weekly-improvements.js — copy/paste so this can run
// standalone before the cron is even deployed.
//
// Usage:
//   node scripts/atlas-backfill-weekly-improvements.js                (default Jun 5-12 2026)
//   node scripts/atlas-backfill-weekly-improvements.js 2026-06-05 2026-06-12
//   node scripts/atlas-backfill-weekly-improvements.js --dry-run
//
// Output: modifies C:\Users\Heath Shepard\Desktop\MeetDossie\WEEKLY-IMPROVEMENTS.md
//         in place. Caller commits.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load .env.local manually (Node doesn't auto-load it).
function loadEnvLocal() {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) {
      const k = m[1];
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[k]) process.env[k] = v;
    }
  }
}

loadEnvLocal();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set (checked .env.local + env)');
  process.exit(1);
}

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';

const MEETDOSSIE_REPO = 'C:/Users/Heath Shepard/Desktop/MeetDossie';
const DOSSIE_REPO = 'C:/Users/Heath Shepard/Desktop/Dossie';

const TARGET_FILE = path.join(MEETDOSSIE_REPO, 'WEEKLY-IMPROVEMENTS.md');

// ─── Filters ───────────────────────────────────────────────────────────
const SKIP_SUBJECT_PATTERNS = [
  /^chore[:(]/i, /^refactor[:(]/i, /^wip[:(]/i, /^test[:(]/i, /^ci[:(]/i,
  /^docs[:(]/i, /^style[:(]/i, /^build[:(]/i,
  /^atlas[\s-]?test/i, /^carter[\s-]?test/i, /^cole[\s-]?test/i, /^sage[\s-]?test/i,
  /^gold-\d{4}-\d{2}-\d{2}/i,
  /^memory:/i,
  /update claude\.md/i,
  /update memory\.md/i,
];

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
  /^WEEKLY-IMPROVEMENTS\.md$/,
];

function shouldSkipBySubject(subject) {
  if (!subject) return true;
  return SKIP_SUBJECT_PATTERNS.some((re) => re.test(subject));
}

function shouldSkipByFiles(files) {
  if (!Array.isArray(files) || files.length === 0) return false;
  return files.every((f) => INTERNAL_PATH_PATTERNS.some((re) => re.test(f)));
}

// ─── Git helpers ───────────────────────────────────────────────────────

function gitListCommits(repoPath, since, until) {
  // %x09 = tab separator. Format: sha\tsubject (one line per commit).
  const cmd = `git -C "${repoPath}" log --all --no-merges --since="${since}" --until="${until}" --pretty=format:"%H%x09%s%x09%ai"`;
  let raw;
  try {
    raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (err) {
    console.error(`git log failed for ${repoPath}:`, err.message);
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [sha, subject, dateStr] = line.split('\t');
    if (!sha || seen.has(sha)) continue;
    seen.add(sha);
    out.push({ sha, subject: subject || '', date: dateStr || '' });
  }
  // Oldest first.
  out.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  return out;
}

function gitGetFilesChanged(repoPath, sha) {
  try {
    const raw = execSync(`git -C "${repoPath}" show --name-only --pretty=format: ${sha}`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return raw.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function gitGetFullMessage(repoPath, sha) {
  try {
    return execSync(`git -C "${repoPath}" log -1 --pretty=format:"%B" ${sha}`, {
      encoding: 'utf8',
      maxBuffer: 1 * 1024 * 1024,
    });
  } catch {
    return '';
  }
}

// ─── Anthropic ─────────────────────────────────────────────────────────

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

async function classifyCommit({ subject, body, files, repo }) {
  const prompt = buildClassifyPrompt({ subject, body, filesChanged: files, repo });
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
  const data = JSON.parse(text);
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const content = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(stripped); } catch {
    return { customer_facing: false, tag: '(internal)', title: '', body: '' };
  }
  return {
    customer_facing: !!parsed.customer_facing,
    tag: ['(customer)', '(both)', '(internal)'].includes(parsed.tag) ? parsed.tag : '(internal)',
    title: typeof parsed.title === 'string' ? parsed.title.trim() : '',
    body: typeof parsed.body === 'string' ? parsed.body.trim() : '',
  };
}

// ─── WEEKLY-IMPROVEMENTS.md mutator ────────────────────────────────────

function mondayOfWeek(d) {
  const day = d.getUTCDay();
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

const MONTH_NAMES = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

function parseWeekHeaderDate(rawHeader) {
  const m = rawHeader.match(/Week of\s+([A-Za-z]+)\s+(\d{1,2})(?:[–—\-]\d{1,2})?,\s+(\d{4})/);
  if (!m) return null;
  const monthName = m[1].toLowerCase();
  if (!(monthName in MONTH_NAMES)) return null;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (Number.isNaN(day) || Number.isNaN(year)) return null;
  return new Date(Date.UTC(year, MONTH_NAMES[monthName], day));
}

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

function extractAppliedShas(sectionLines) {
  for (const ln of sectionLines) {
    const m = ln.match(/<!--\s*applied_shas:\s*([^>]+?)\s*-->/i);
    if (m) {
      return new Set(m[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    }
  }
  return new Set();
}

function buildAppliedShasComment(shaSet) {
  const arr = Array.from(shaSet).sort();
  return `<!-- applied_shas: ${arr.join(',')} -->`;
}

function rewriteWeekSection(sectionLines, newEntries, newShaSet) {
  let cleaned = sectionLines.filter((ln) => !/<!--\s*applied_shas:/i.test(ln));
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') cleaned.pop();
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

function insertNewWeekSection(fileText, weekHeader, newEntries, newShaSet) {
  const lines = fileText.split('\n');
  let firstWeekIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Week of/.test(lines[i])) { firstWeekIdx = i; break; }
  }
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

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const nonFlagArgs = args.filter((a) => !a.startsWith('--'));
  const sinceArg = nonFlagArgs[0] || '2026-06-05';
  const untilArg = nonFlagArgs[1] || '2026-06-12';

  const sinceDate = new Date(`${sinceArg}T00:00:00Z`);
  const untilDate = new Date(`${untilArg}T23:59:59Z`);

  console.log(`[backfill] window ${sinceArg} .. ${untilArg}`);
  console.log(`[backfill] dry run: ${dryRun}`);

  // Pull commits from both repos.
  const allCommits = [];
  for (const repo of [
    { path: MEETDOSSIE_REPO, slug: 'heathshepard/MeetDossie' },
    { path: DOSSIE_REPO, slug: 'heathshepard/DossieApp' },
  ]) {
    const cs = gitListCommits(repo.path, sinceArg, untilArg);
    console.log(`[backfill] ${repo.slug}: ${cs.length} commits`);
    for (const c of cs) allCommits.push({ ...c, _repoPath: repo.path, _repoSlug: repo.slug });
  }

  console.log(`[backfill] total commits in window: ${allCommits.length}`);

  // Load current file + resolve target section.
  const fileText = fs.readFileSync(TARGET_FILE, 'utf8');
  const sectionTarget = resolveTargetSection(fileText, untilDate);
  const weekHeader = sectionTarget.header;
  const alreadyApplied = sectionTarget.existing
    ? extractAppliedShas(sectionTarget.existing.sectionLines)
    : new Set();
  console.log(`[backfill] target section: "${weekHeader}" (mode=${sectionTarget.mode}, already-applied SHAs=${alreadyApplied.size})`);

  // Classify each commit.
  const accepted = [];
  const stats = {
    total: allCommits.length,
    skip_subject: 0,
    skip_files: 0,
    skip_already_applied: 0,
    haiku_internal: 0,
    haiku_errors: 0,
    accepted_customer: 0,
    accepted_both: 0,
  };

  for (let i = 0; i < allCommits.length; i++) {
    const c = allCommits[i];
    const shortSha = c.sha.slice(0, 7).toLowerCase();
    process.stdout.write(`[${i + 1}/${allCommits.length}] ${shortSha} ${c.subject.slice(0, 80)} ... `);

    if (alreadyApplied.has(shortSha)) {
      stats.skip_already_applied += 1;
      console.log('SKIP (already applied)');
      continue;
    }
    if (shouldSkipBySubject(c.subject)) {
      stats.skip_subject += 1;
      console.log('SKIP (subject pattern)');
      continue;
    }
    const files = gitGetFilesChanged(c._repoPath, c.sha);
    if (shouldSkipByFiles(files)) {
      stats.skip_files += 1;
      console.log(`SKIP (all ${files.length} files internal)`);
      continue;
    }
    const fullMsg = gitGetFullMessage(c._repoPath, c.sha);
    const bodyOnly = fullMsg.split('\n').slice(1).join('\n').trim();

    let classified;
    try {
      classified = await classifyCommit({
        subject: c.subject,
        body: bodyOnly,
        files,
        repo: c._repoSlug,
      });
    } catch (err) {
      stats.haiku_errors += 1;
      console.log(`HAIKU_ERR: ${err.message}`);
      continue;
    }

    if (!classified.customer_facing || classified.tag === '(internal)' || !classified.title || !classified.body) {
      stats.haiku_internal += 1;
      console.log(`internal`);
      continue;
    }

    if (classified.tag === '(customer)') stats.accepted_customer += 1;
    else if (classified.tag === '(both)') stats.accepted_both += 1;

    accepted.push({
      sha: shortSha,
      repo: c._repoSlug,
      subject: c.subject,
      tag: classified.tag,
      title: classified.title,
      body: classified.body,
    });
    console.log(`ACCEPT ${classified.tag} "${classified.title}"`);
  }

  console.log('\n[backfill] stats:', JSON.stringify(stats, null, 2));
  console.log(`[backfill] entries to add: ${accepted.length}`);

  if (accepted.length === 0) {
    console.log('[backfill] nothing to write.');
    return;
  }

  if (dryRun) {
    console.log('\n[backfill] --dry-run set. Entries:');
    for (const e of accepted) {
      console.log(`\n  **${e.title}** ${e.tag}`);
      console.log(`  - ${e.body}`);
      console.log(`  (sha ${e.sha}, ${e.repo})`);
    }
    return;
  }

  const newContent = applyEntriesToFile(fileText, sectionTarget, accepted, alreadyApplied);
  fs.writeFileSync(TARGET_FILE, newContent, 'utf8');
  console.log(`[backfill] wrote ${TARGET_FILE}`);
  console.log(`[backfill] DONE — ${accepted.length} entries added under "${weekHeader}"`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
