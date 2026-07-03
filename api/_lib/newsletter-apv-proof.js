// Newsletter APV proof gate — Cole/Jarvis must sign the Friday newsletter
// BEFORE the send cron will fire. Locked 2026-07-02.
//
// Send cron looks for a file at:
//   Shepard-Ventures/Newsletter/audit/weekly-apv-{YYYY-MM-DD}.md
// where {YYYY-MM-DD} is the current Friday (America/Chicago).
//
// File must contain a line matching /^APPROVED_BY:\s*cole\s*$/im.
// Optional metadata lines are ignored.
//
// If missing → send cron aborts + Telegrams Heath.
// If present but no APPROVED_BY line → same abort behavior.

const fs = require('fs');
const path = require('path');

// The Shepard-Ventures filing cabinet lives beside MeetDossie/ on Heath's
// desktop. Vercel serverless functions won't see that path, so we ALSO
// support a mirrored copy inside the repo at .newsletter-audit/ that gets
// committed alongside code. Priority order:
//   1) Repo mirror: MeetDossie/.newsletter-audit/weekly-apv-{date}.md
//   2) Local dev:   ../Shepard-Ventures/Newsletter/audit/weekly-apv-{date}.md
function candidatePaths(dateStr) {
  return [
    path.join(process.cwd(), '.newsletter-audit', `weekly-apv-${dateStr}.md`),
    path.join(__dirname, '..', '..', '.newsletter-audit', `weekly-apv-${dateStr}.md`),
    path.join('/var/task', '.newsletter-audit', `weekly-apv-${dateStr}.md`),
    // Local dev only — filing cabinet outside the repo
    path.join(process.cwd(), '..', 'Shepard-Ventures', 'Newsletter', 'audit', `weekly-apv-${dateStr}.md`),
  ];
}

// Returns YYYY-MM-DD for the current Friday in America/Chicago. If today is
// not Friday, returns the upcoming Friday's date — send cron only runs on
// Fridays anyway, so under normal operation "today" IS Friday.
function currentFridayDateStr(now = new Date()) {
  // Compute Chicago-local components
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const y = get('year');
  const m = get('month');
  const d = get('day');
  const weekday = get('weekday'); // Mon, Tue, ...
  // If it's already Friday, return today. Otherwise nudge to the next Friday.
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
  const daysUntilFri = (5 - dayIdx + 7) % 7;
  if (daysUntilFri === 0) return `${y}-${m}-${d}`;
  // Advance
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  utc.setUTCDate(utc.getUTCDate() + daysUntilFri);
  const yy = utc.getUTCFullYear();
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Look for the APV proof file for the given date. Returns:
 *   { present: true,  approvedBy: 'cole', path, contents }
 *   { present: true,  approvedBy: null,   path, contents, reason: 'no_approved_by_line' }
 *   { present: false, approvedBy: null, checkedPaths: [...] }
 */
function findApvProof(dateStr = currentFridayDateStr()) {
  const paths = candidatePaths(dateStr);
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) {
        const contents = fs.readFileSync(p, 'utf8');
        const match = contents.match(/^APPROVED_BY:\s*(\w+)\s*$/im);
        if (match && match[1].toLowerCase() === 'cole') {
          return { present: true, approvedBy: 'cole', path: p, contents };
        }
        return {
          present: true,
          approvedBy: null,
          path: p,
          contents,
          reason: 'no_approved_by_line',
        };
      }
    } catch (err) {
      // continue
    }
  }
  return { present: false, approvedBy: null, checkedPaths: paths };
}

/**
 * Composite gate — returns { ok: true, ... } if the send cron may proceed,
 * or { ok: false, reason, message } if the send must abort.
 */
function assertApvProof(now = new Date()) {
  const dateStr = currentFridayDateStr(now);
  const result = findApvProof(dateStr);
  if (!result.present) {
    return {
      ok: false,
      reason: 'apv_missing',
      dateStr,
      message: `Weekly newsletter aborted — Cole did not proof (no APV file for ${dateStr}). Draft still in Resend queue for review.`,
      checkedPaths: result.checkedPaths,
    };
  }
  if (!result.approvedBy) {
    return {
      ok: false,
      reason: 'apv_unsigned',
      dateStr,
      path: result.path,
      message: `Weekly newsletter aborted — APV file for ${dateStr} exists but has no "APPROVED_BY: cole" line.`,
    };
  }
  return {
    ok: true,
    dateStr,
    path: result.path,
    approvedBy: result.approvedBy,
  };
}

module.exports = {
  currentFridayDateStr,
  findApvProof,
  assertApvProof,
};
