'use strict';

// scripts/weekly-pattern-digest.js
//
// Cole's weekly failure-pattern digest. Reads feedback_*.md files from the
// memory directory modified in the last 7 days. Prints a plain-text digest
// Cole can paste into Telegram or read at session start.
//
// Usage:
//   node scripts/weekly-pattern-digest.js
//
// No env vars required — pure local file read.
// Schedule via Task Scheduler: every Monday at 9AM (or run manually).

const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(
  'C:', 'Users', 'Heath Shepard', '.claude', 'projects',
  'C--Users-Heath-Shepard-Desktop-MeetDossie', 'memory'
);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Top 3 permanent rules pulled from CLAUDE.md Section 0
const TOP_3_PERMANENT_RULES = [
  'RULE 1 -- SCAN BEFORE BUILD: Before writing any new script or tool, run dir scripts/ and search for existing ones.',
  'RULE 2 -- "I DID IT ALREADY" MEANS IT WORKED: When Heath says he completed a setup step, assume success.',
  'RULE 3 -- SUMMARIES LIE ABOUT WHAT\'S BUILT: Session auto-summaries optimize for capturing blockers, not inventory.',
];

function divider(char = '-', len = 60) {
  return char.repeat(len);
}

function run() {
  const now = new Date();
  const cutoff = new Date(now.getTime() - SEVEN_DAYS_MS);

  if (!fs.existsSync(MEMORY_DIR)) {
    console.error(`Memory directory not found: ${MEMORY_DIR}`);
    process.exit(1);
  }

  let allFiles;
  try {
    allFiles = fs.readdirSync(MEMORY_DIR);
  } catch (err) {
    console.error(`Failed to read memory directory: ${err.message}`);
    process.exit(1);
  }

  // Filter to feedback_*.md files
  const feedbackFiles = allFiles.filter(
    (f) => f.startsWith('feedback_') && f.endsWith('.md')
  );

  // Split into modified-this-week vs older
  const recentFiles = [];
  const olderFiles = [];

  for (const fname of feedbackFiles) {
    const fpath = path.join(MEMORY_DIR, fname);
    let mtime;
    try {
      mtime = fs.statSync(fpath).mtime;
    } catch (_) {
      continue;
    }
    if (mtime >= cutoff) {
      recentFiles.push({ fname, mtime });
    } else {
      olderFiles.push({ fname, mtime });
    }
  }

  recentFiles.sort((a, b) => b.mtime - a.mtime);

  // ── Output ────────────────────────────────────────────────────────────────
  console.log('');
  console.log(divider('='));
  console.log('  COLE WEEKLY FAILURE-PATTERN DIGEST');
  console.log(`  Week ending ${now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  console.log(divider('='));
  console.log('');

  console.log(`  Total feedback rules on file: ${feedbackFiles.length}`);
  console.log(`  Rules written or updated this week: ${recentFiles.length}`);
  console.log('');

  if (recentFiles.length > 0) {
    console.log('  NEW / UPDATED RULES THIS WEEK:');
    console.log(divider());
    for (const { fname, mtime } of recentFiles) {
      const ruleName = fname.replace('feedback_', '').replace('.md', '').replace(/_/g, ' ');
      const dayAgo = Math.round((now - mtime) / 1000 / 60 / 60);
      console.log(`  - ${ruleName} (${dayAgo}h ago)`);

      // Print first non-empty line of the file as the rule summary
      try {
        const content = fs.readFileSync(path.join(MEMORY_DIR, fname), 'utf8');
        const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
        // Skip heading lines starting with #
        const summary = lines.find((l) => !l.startsWith('#'));
        if (summary) {
          console.log(`    "${summary.slice(0, 120)}${summary.length > 120 ? '...' : ''}"`);
        }
      } catch (_) {}
    }
    console.log('');
  } else {
    console.log('  No new feedback rules this week. Clean run.');
    console.log('');
  }

  console.log('  TOP 3 PERMANENT RULES (never forget these):');
  console.log(divider());
  TOP_3_PERMANENT_RULES.forEach((rule, i) => {
    console.log(`  ${i + 1}. ${rule}`);
    console.log('');
  });

  console.log(divider('='));
  console.log('');
}

run();
